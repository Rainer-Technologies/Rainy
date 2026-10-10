"""
Rainy Connect — Spotify-Connect-style cross-device session control.

Each active player (web tab or mobile app) registers as a "device" and
heartbeats its playback state every few seconds. Any device belonging to the
same user can:
  - list active devices
  - remote-control another device (play/pause/skip/seek/volume/shuffle/repeat)
  - transfer playback to itself ("play here instead")

A device is online while it heartbeats or holds its command stream open; after
STALE_SECONDS of neither it is offline (still known, greyed out in pickers that
ask for it) and after FORGET_SECONDS it is dropped. State lives in the database
so it's shared across the Flask workers and visible to every client.

Storage layout (Sep 2026): connect_sessions holds only the small per-beat
columns; the multi-KB playback queue lives in connect_session_queues and is
written only when it actually changes. See heartbeat() for why.

Protocol notes (Oct 2026):
  - Commands carry an id. A device reports the last id it applied as
    `last_cmd_id` in its heartbeat, so a controller can tell a state snapshot
    taken before its command from one taken after.
  - Commands expire after COMMAND_TTL_SECONDS and are refused for stale
    devices: a command is "do this now", never "do this whenever you are
    back".
  - The stored queue is a window of at most MAX_QUEUE tracks around the
    current one. `queue_index` in the API is relative to that window;
    `queue_offset` says where the window starts in the device's real queue.
  - Commands reach a device through its stream (routes/connect.py) or, as a
    fallback, by polling. The stream keeps them until the device acknowledges
    them in a heartbeat (`cmd_ack`), so a dropped connection loses nothing;
    devices skip ids they already applied.
  - An open stream also counts as presence (`stream_seen`). A browser tab in
    the background has its timers throttled to one a minute, so its
    heartbeats alone made a paused player look gone.
"""

import hashlib
import json
import math
import time
import uuid

from models.database import Database, DatabaseError, is_lock_timeout

# A device is offline after this many seconds without a heartbeat or an open
# command stream…
STALE_SECONDS = 30
# …and forgotten (its row deleted) after this many.
FORGET_SECONDS = 30 * 60

# A command nobody picked up within this long is dropped instead of applied.
COMMAND_TTL_SECONDS = 15

# Largest queue window kept per device (and forwarded in a command).
MAX_QUEUE = 500
# Tracks kept before the current one when a longer queue is windowed, and how
# far the current track moves before the window slides.
_QUEUE_LEAD = 50
_QUEUE_STEP = 100

COMMANDS = frozenset({
    "play", "pause", "play_pause", "next", "previous", "seek", "volume",
    "shuffle", "repeat", "play_song", "play_queue", "transfer",
})


def _now():
    return time.time()


def _number(value, default=0.0, lo=None, hi=None):
    """`value` as a finite float within [lo, hi], or `default`."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(n):
        return default
    if lo is not None and n < lo:
        n = lo
    if hi is not None and n > hi:
        n = hi
    return n


def _integer(value, default=0, lo=None, hi=None):
    n = _number(value, None, lo, hi)
    return default if n is None else int(n)


def _text(value, limit, default=None):
    if value is None:
        return default
    return str(value)[:limit]


def normalize_repeat(mode):
    """One vocabulary on the wire: the mobile app says 'off', the web 'none'."""
    return mode if mode in ("all", "one") else "none"


def window_queue(queue, index):
    """Trim `queue` to MAX_QUEUE tracks around `index`.

    Returns (window, offset) where offset is the window's start in `queue`.
    The start only moves in _QUEUE_STEP jumps so that advancing one track
    does not produce a different window (and a rewrite) every time.
    """
    if len(queue) <= MAX_QUEUE:
        return queue, 0
    start = max(0, ((index - _QUEUE_LEAD) // _QUEUE_STEP) * _QUEUE_STEP)
    start = min(start, len(queue) - MAX_QUEUE)
    return queue[start:start + MAX_QUEUE], start


class ConnectModel:
    """Manages Rainy Connect device sessions per user."""

    @staticmethod
    def new_device_id():
        return uuid.uuid4().hex

    @staticmethod
    def _qhash(text):
        return hashlib.md5(text.encode("utf-8", "replace")).hexdigest()

    @staticmethod
    def _parse_queue(raw):
        """The `queue` field of a heartbeat as a list of track maps."""
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                return []
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, dict)]

    @staticmethod
    def heartbeat(user_id, device_id, payload):
        """Create or update a device session. Called on every state change and
        on a periodic timer by each client.

        The write is split so the hot row stays small:
          1. connect_sessions — only the columns a beat changes (position,
             is_playing, last_seen, volume…), no queue blob.
          2. connect_session_queues — written ONLY when the queue changed
             (track/queue edits), and skipped entirely when the client omits
             the `queue` key ("unchanged since the last beat").

        A multi-KB blob in the row every device rewrites every couple of
        seconds made each heartbeat a multi-page row rewrite on a single hot
        row; those locks outlived the 50s innodb_lock_wait_timeout, so beats
        convoyed (25 stuck requests), the 32-connection pool drained and
        unrelated requests + background workers died (500s / PoolError).

        A client that omits the queue sends `queue_sig`, an opaque label of
        the queue it last uploaded. When that is not what is stored (pruned
        row, dropped write, first beat) the answer says `need_queue` and the
        client uploads it on its next beat.

        Returns {"stored": bool, "need_queue": bool}. `stored` is False when a
        write hit a lock-wait timeout and the previous state stands. The route
        answers 200 either way on purpose: a 500 made every client retry
        instantly, which is what turned a slow lock into a self-sustaining
        storm.
        """
        now = _now()
        queue_index = _integer(payload.get("queue_index"), 0, lo=0)
        queue_sig = _text(payload.get("queue_sig"), 64, "")

        try:
            Database.execute_query(
                """
                INSERT INTO connect_sessions
                    (device_id, user_id, device_name, device_type, song_id,
                     song_title, song_artist, song_album, cover_path, position,
                     duration, is_playing, volume, is_shuffled, repeat_mode,
                     queue_index, last_cmd_id, last_seen)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    user_id = VALUES(user_id),
                    device_name = VALUES(device_name),
                    device_type = VALUES(device_type),
                    song_id = VALUES(song_id),
                    song_title = VALUES(song_title),
                    song_artist = VALUES(song_artist),
                    song_album = VALUES(song_album),
                    cover_path = VALUES(cover_path),
                    position = VALUES(position),
                    duration = VALUES(duration),
                    is_playing = VALUES(is_playing),
                    volume = VALUES(volume),
                    is_shuffled = VALUES(is_shuffled),
                    repeat_mode = VALUES(repeat_mode),
                    queue_index = VALUES(queue_index),
                    last_cmd_id = GREATEST(last_cmd_id, VALUES(last_cmd_id)),
                    last_seen = VALUES(last_seen)
                """,
                (
                    device_id,
                    user_id,
                    _text(payload.get("device_name"), 128, "Unknown Device"),
                    _text(payload.get("device_type"), 32, "web"),
                    _integer(payload.get("song_id"), None),
                    _text(payload.get("song_title"), 255),
                    _text(payload.get("song_artist"), 255),
                    _text(payload.get("song_album"), 255),
                    _text(payload.get("cover_path"), 500),
                    _number(payload.get("position"), 0.0, lo=0),
                    _number(payload.get("duration"), 0.0, lo=0),
                    1 if payload.get("is_playing") else 0,
                    _integer(payload.get("volume"), 100, lo=0, hi=100),
                    1 if payload.get("is_shuffled") else 0,
                    normalize_repeat(payload.get("repeat_mode")),
                    queue_index,
                    _integer(payload.get("last_cmd_id"), 0, lo=0),
                    now,
                ),
            )
        except DatabaseError as e:
            if is_lock_timeout(e):
                print(f"[connect] heartbeat lock-wait timeout for {device_id}"
                      " — state kept from previous beat")
                return {"stored": False, "need_queue": False}
            raise

        # Sent by a device right after it applied commands: they can go now.
        cmd_ack = _integer(payload.get("cmd_ack"), 0, lo=0)
        if cmd_ack:
            ConnectModel.ack_commands(user_id, device_id, cmd_ack)

        if "queue" not in payload:
            if not queue_sig:
                return {"stored": True, "need_queue": False}
            row = Database.execute_query(
                "SELECT client_sig FROM connect_session_queues"
                " WHERE device_id = %s AND user_id = %s",
                (device_id, user_id),
                fetch_one=True,
            )
            return {"stored": True,
                    "need_queue": not row or row.get("client_sig") != queue_sig}

        # A client that windows the queue itself says where its window starts;
        # one that sends everything gets windowed here.
        sent = ConnectModel._parse_queue(payload.get("queue"))
        sent_offset = _integer(payload.get("queue_offset"), 0, lo=0)
        total = _integer(payload.get("queue_total"), 0, lo=0) or sent_offset + len(sent)
        window, start = window_queue(sent, queue_index - sent_offset)
        offset = sent_offset + start
        queue_raw = json.dumps(window, separators=(",", ":")) if window else None
        qhash = ConnectModel._qhash(f"{offset}:{total}:{queue_raw or ''}")

        try:
            row = Database.execute_query(
                "SELECT qhash, client_sig FROM connect_session_queues WHERE device_id = %s",
                (device_id,),
                fetch_one=True,
            )
            if (not row or row.get("qhash") != qhash
                    or row.get("client_sig") != queue_sig):
                Database.execute_query(
                    """
                    INSERT INTO connect_session_queues
                        (device_id, user_id, qhash, client_sig, queue,
                         queue_offset, queue_total, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        user_id = VALUES(user_id),
                        qhash = VALUES(qhash),
                        client_sig = VALUES(client_sig),
                        queue = VALUES(queue),
                        queue_offset = VALUES(queue_offset),
                        queue_total = VALUES(queue_total),
                        updated_at = VALUES(updated_at)
                    """,
                    (device_id, user_id, qhash, queue_sig, queue_raw,
                     offset, total, now),
                )
        except DatabaseError as e:
            if is_lock_timeout(e):
                print(f"[connect] queue write lock-wait timeout for {device_id}"
                      " — queue kept from previous beat")
                return {"stored": False, "need_queue": True}
            raise
        return {"stored": True, "need_queue": False}

    @staticmethod
    def _prune_stale(user_id):
        """Drop devices nobody has heard from in FORGET_SECONDS."""
        cutoff = _now() - FORGET_SECONDS
        # Listings are polled every few seconds: stay read-only unless there
        # is actually something to prune.
        gone = "user_id = %s AND last_seen < %s AND stream_seen < %s"
        stale = Database.execute_query(
            f"SELECT device_id FROM connect_sessions WHERE {gone} LIMIT 1",
            (user_id, cutoff, cutoff),
            fetch_one=True,
        )
        if not stale:
            return
        Database.execute_query(
            f"DELETE FROM connect_sessions WHERE {gone}",
            (user_id, cutoff, cutoff),
        )
        # Queue rows and pending commands whose device row is gone would
        # otherwise accumulate forever.
        for table in ("connect_session_queues", "connect_commands"):
            Database.execute_query(
                f"""
                DELETE FROM {table}
                WHERE user_id = %s AND NOT EXISTS (
                    SELECT 1 FROM connect_sessions s
                    WHERE s.device_id = {table}.device_id
                )
                """,
                (user_id,),
            )

    @staticmethod
    def _seen(row):
        """When a device last showed signs of life (heartbeat or stream)."""
        return max(float(row.get("last_seen") or 0), float(row.get("stream_seen") or 0))

    # The queue blob is only read when the caller does not already hold it
    # (`known_hash`), so a controller polling every second gets a small row.
    _DEVICE_COLUMNS = """
        s.*, q.qhash AS queue_hash, q.queue_offset, q.queue_total,
        CASE WHEN q.qhash = %s THEN NULL ELSE q.queue END AS queue_blob
    """
    _NO_HASH = "-"  # matches no stored hash: always read the queue

    @staticmethod
    def list_devices(user_id, exclude_device_id=None, include_queue=True,
                     include_offline=False):
        """Return a user's devices, newest first: the online ones, plus the
        offline ones not yet forgotten when `include_offline`."""
        ConnectModel._prune_stale(user_id)
        if include_queue:
            columns = ConnectModel._DEVICE_COLUMNS
            params = (ConnectModel._NO_HASH, user_id)
        else:
            columns = ("s.*, q.qhash AS queue_hash, q.queue_offset,"
                       " q.queue_total, NULL AS queue_blob")
            params = (user_id,)
        rows = Database.execute_query(
            f"""
            SELECT {columns}
            FROM connect_sessions s
            LEFT JOIN connect_session_queues q ON q.device_id = s.device_id
            WHERE s.user_id = %s
            ORDER BY s.last_seen DESC
            """,
            params,
            fetch_all=True,
        )
        now = _now()
        devices = []
        for r in rows or []:
            if exclude_device_id and r["device_id"] == exclude_device_id:
                continue
            device = ConnectModel._serialize(r, now, with_queue=include_queue)
            if device["online"] or include_offline:
                devices.append(device)
        # Online first; the listing query can only order by heartbeat.
        devices.sort(key=lambda d: not d["online"])
        return devices

    @staticmethod
    def get_device(user_id, device_id, known_queue_hash=None):
        """One device's latest state. With `known_queue_hash` equal to the
        stored queue's hash the queue is left out (`queue_unchanged`)."""
        row = Database.execute_query(
            f"""
            SELECT {ConnectModel._DEVICE_COLUMNS}
            FROM connect_sessions s
            LEFT JOIN connect_session_queues q ON q.device_id = s.device_id
            WHERE s.user_id = %s AND s.device_id = %s
            """,
            (known_queue_hash or ConnectModel._NO_HASH, user_id, device_id),
            fetch_one=True,
        )
        if not row:
            return None
        unchanged = bool(known_queue_hash) and row.get("queue_hash") == known_queue_hash
        device = ConnectModel._serialize(row, _now(), with_queue=not unchanged)
        if unchanged:
            device["queue_unchanged"] = True
        return device

    @staticmethod
    def device_status(user_id, device_id):
        """'online', 'offline' (known but stale) or None (unknown device)."""
        row = Database.execute_query(
            "SELECT last_seen, stream_seen FROM connect_sessions"
            " WHERE user_id = %s AND device_id = %s",
            (user_id, device_id),
            fetch_one=True,
        )
        if not row:
            return None
        fresh = ConnectModel._seen(row) >= _now() - STALE_SECONDS
        return "online" if fresh else "offline"

    @staticmethod
    def touch_stream(user_id, device_id):
        """Record that the device's command stream is open right now."""
        Database.execute_query(
            "UPDATE connect_sessions SET stream_seen = %s"
            " WHERE user_id = %s AND device_id = %s",
            (_now(), user_id, device_id),
        )

    @staticmethod
    def remove_device(user_id, device_id):
        """A device deregisters (e.g. player closed / app backgrounded)."""
        for table in ("connect_sessions", "connect_session_queues", "connect_commands"):
            Database.execute_query(
                f"DELETE FROM {table} WHERE user_id = %s AND device_id = %s",
                (user_id, device_id),
            )

    @staticmethod
    def normalize_command(command, args):
        """Bring a command's args to the shape every client understands."""
        args = dict(args) if isinstance(args, dict) else {}
        if command == "repeat":
            args["mode"] = normalize_repeat(args.get("mode"))
        queue = args.get("queue")
        if isinstance(queue, list) and len(queue) > MAX_QUEUE:
            index = _integer(args.get("index"), 0, lo=0)
            window, start = window_queue(queue, index)
            args["queue"] = window
            args["index"] = index - start
        return args

    @staticmethod
    def push_command(user_id, device_id, command, args=None):
        """Queue a remote-control command for a target device. The target
        device polls pending_commands() and applies them. Returns the
        command's id, which the device echoes back as `last_cmd_id`."""
        return Database.execute_query(
            """
            INSERT INTO connect_commands
                (user_id, device_id, command, args, created_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (user_id, device_id, command,
             json.dumps(ConnectModel.normalize_command(command, args)), _now()),
        )

    @staticmethod
    def pending_commands(user_id, device_id):
        """Fetch and delete pending commands for this device (FIFO).

        Commands older than COMMAND_TTL_SECONDS are dropped unread. Rows are
        claimed with a token before they are returned, so two polls racing
        for the same device never both get a command.
        """
        scope = (user_id, device_id)
        pending = Database.execute_query(
            "SELECT id FROM connect_commands"
            " WHERE user_id = %s AND device_id = %s AND claim IS NULL",
            scope,
            fetch_all=True,
        )
        if not pending:
            return []

        token = uuid.uuid4().hex
        ids = tuple(r["id"] for r in pending)
        placeholders = ",".join(["%s"] * len(ids))
        Database.execute_query(
            f"UPDATE connect_commands SET claim = %s"
            f" WHERE id IN ({placeholders}) AND claim IS NULL",
            (token,) + ids,
        )
        rows = Database.execute_query(
            """SELECT id, command, args, created_at FROM connect_commands
               WHERE user_id = %s AND device_id = %s AND claim = %s
               ORDER BY id ASC""",
            scope + (token,),
            fetch_all=True,
        )
        cutoff = _now() - COMMAND_TTL_SECONDS
        # Also sweeps expired rows a crashed poll claimed but never deleted.
        Database.execute_query(
            """DELETE FROM connect_commands
               WHERE user_id = %s AND device_id = %s
                 AND (claim = %s OR created_at < %s)""",
            scope + (token, cutoff),
        )

        cmds = []
        for r in rows or []:
            if float(r["created_at"] or 0) < cutoff:
                continue
            try:
                args = json.loads(r["args"]) if r["args"] else {}
            except ValueError:
                args = {}
            cmds.append({"id": r["id"], "command": r["command"], "args": args})
        return cmds

    @staticmethod
    def peek_commands(user_id, device_id, after_id=0):
        """Pending commands newer than `after_id`, WITHOUT consuming them.

        For the command stream: a command written to a connection that has
        silently died would be lost if it were deleted on send, so it stays
        until the device acknowledges it (ack_commands) or it expires. The
        stream remembers the last id it sent, the device the last it applied.
        """
        rows = Database.execute_query(
            """SELECT id, command, args FROM connect_commands
               WHERE user_id = %s AND device_id = %s AND id > %s
                 AND claim IS NULL AND created_at >= %s
               ORDER BY id ASC""",
            (user_id, device_id, after_id, _now() - COMMAND_TTL_SECONDS),
            fetch_all=True,
        )
        cmds = []
        for r in rows or []:
            try:
                args = json.loads(r["args"]) if r["args"] else {}
            except ValueError:
                args = {}
            cmds.append({"id": r["id"], "command": r["command"], "args": args})
        return cmds

    @staticmethod
    def ack_commands(user_id, device_id, up_to_id):
        """The device applied every command up to `up_to_id`: delete them,
        along with any that expired unread."""
        Database.execute_query(
            """DELETE FROM connect_commands
               WHERE user_id = %s AND device_id = %s
                 AND (id <= %s OR created_at < %s)""",
            (user_id, device_id, up_to_id, _now() - COMMAND_TTL_SECONDS),
        )

    @staticmethod
    def _serialize(r, now, with_queue=True):
        offset = int(r.get("queue_offset") or 0)
        last_seen = float(r["last_seen"] or 0)
        seen = ConnectModel._seen(r)
        device = {
            "device_id": r["device_id"],
            "device_name": r["device_name"],
            "device_type": r["device_type"],
            "song_id": r["song_id"],
            "song_title": r["song_title"],
            "song_artist": r["song_artist"],
            "song_album": r["song_album"],
            "cover_path": r["cover_path"],
            "position": float(r["position"] or 0),
            "duration": float(r["duration"] or 0),
            "is_playing": bool(r["is_playing"]),
            "volume": int(r["volume"] if r["volume"] is not None else 100),
            "is_shuffled": bool(r["is_shuffled"]),
            "repeat_mode": normalize_repeat(r["repeat_mode"]),
            # Relative to the queue window; add queue_offset for the index in
            # the device's real queue.
            "queue_index": int(r["queue_index"] or 0) - offset,
            "queue_offset": offset,
            "queue_total": int(r.get("queue_total") or 0),
            "queue_hash": r.get("queue_hash") or "",
            "last_cmd_id": int(r.get("last_cmd_id") or 0),
            "last_seen": last_seen,
            # Seconds since this snapshot was taken, by the server's clock —
            # lets a client extrapolate the position without trusting its own.
            "state_age": max(0.0, now - last_seen),
            "online": seen >= now - STALE_SECONDS,
            # Seconds since the device last showed signs of life.
            "idle_for": max(0.0, now - seen),
        }
        if with_queue:
            queue = []
            raw_queue = r.get("queue_blob")
            if raw_queue:
                try:
                    queue = json.loads(raw_queue)
                except ValueError:
                    queue = []
            device["queue"] = queue
        return device
