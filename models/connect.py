"""
Rainy Connect — Spotify-Connect-style cross-device session control.

Each active player (web tab or mobile app) registers as a "device" and
heartbeats its playback state every few seconds. Any device belonging to the
same user can:
  - list active devices
  - remote-control another device (play/pause/skip/seek/volume/shuffle/repeat)
  - transfer playback to itself ("play here instead")

Devices that stop heartbeating are considered stale after STALE_SECONDS and
are pruned from listings. State lives in the database so it's shared across the
Flask workers and visible to every client.

Storage layout (Sep 2026): connect_sessions holds only the small per-beat
columns; the multi-KB playback queue lives in connect_session_queues and is
written only when it actually changes. See heartbeat() for why.
"""

import hashlib
import time
import uuid

from models.database import Database, DatabaseError, is_lock_timeout

# A device is considered gone after this many seconds without a heartbeat.
STALE_SECONDS = 20


class ConnectModel:
    """Manages Rainy Connect device sessions per user."""

    @staticmethod
    def init_table():
        Database.execute_query("""
            CREATE TABLE IF NOT EXISTS connect_sessions (
                device_id VARCHAR(64) PRIMARY KEY,
                user_id INT NOT NULL,
                device_name VARCHAR(128) NOT NULL,
                device_type VARCHAR(32) NOT NULL DEFAULT 'web',
                song_id INT NULL,
                song_title VARCHAR(255) NULL,
                song_artist VARCHAR(255) NULL,
                song_album VARCHAR(255) NULL,
                cover_path VARCHAR(500) NULL,
                position DOUBLE DEFAULT 0,
                duration DOUBLE DEFAULT 0,
                is_playing TINYINT DEFAULT 0,
                volume INT DEFAULT 100,
                is_shuffled TINYINT DEFAULT 0,
                repeat_mode VARCHAR(16) DEFAULT 'off',
                queue MEDIUMTEXT NULL,
                last_seen DOUBLE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_last_seen (last_seen)
            )
        """)
        # Playback queues live in their own table (see heartbeat()).
        Database.execute_query("""
            CREATE TABLE IF NOT EXISTS connect_session_queues (
                device_id VARCHAR(64) PRIMARY KEY,
                user_id INT NOT NULL,
                qhash CHAR(32) NOT NULL DEFAULT '',
                queue MEDIUMTEXT NULL,
                updated_at DOUBLE NOT NULL,
                INDEX idx_user (user_id)
            )
        """)

    @staticmethod
    def new_device_id():
        return uuid.uuid4().hex

    @staticmethod
    def _qhash(queue_raw):
        return hashlib.md5((queue_raw or "").encode("utf-8", "replace")).hexdigest()

    @staticmethod
    def heartbeat(user_id, device_id, payload):
        """Create or update a device session. Called on every state change and
        on a periodic timer by each client.

        The write is split so the hot row stays small:
          1. connect_sessions — only the columns a beat changes (position,
             is_playing, last_seen, volume…), no queue blob.
          2. connect_session_queues — written ONLY when the queue hash changed
             (track/queue edits), and skipped entirely when the client omits
             the `queue` key ("unchanged since the last beat").

        A multi-KB blob in the row every device rewrites every couple of
        seconds made each heartbeat a multi-page row rewrite on a single hot
        row; those locks outlived the 50s innodb_lock_wait_timeout, so beats
        convoyed (25 stuck requests), the 32-connection pool drained and
        unrelated requests + background workers died (500s / PoolError).

        Returns True when the full state was stored, False when a write hit a
        lock-wait timeout and the previous state stands. The route answers 200
        either way on purpose: a 500 made every client retry instantly, which
        is what turned a slow lock into a self-sustaining storm.
        """
        import json
        now = time.time()
        queue_raw = payload.get("queue")
        if queue_raw is not None and not isinstance(queue_raw, str):
            queue_raw = json.dumps(queue_raw)
        wants_queue = "queue" in payload

        try:
            Database.execute_query(
                """
                INSERT INTO connect_sessions
                    (device_id, user_id, device_name, device_type, song_id,
                     song_title, song_artist, song_album, cover_path, position,
                     duration, is_playing, volume, is_shuffled, repeat_mode,
                     queue_index, last_seen)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
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
                    last_seen = VALUES(last_seen)
                """,
                (
                    device_id,
                    user_id,
                    payload.get("device_name", "Unknown Device"),
                    payload.get("device_type", "web"),
                    payload.get("song_id"),
                    payload.get("song_title"),
                    payload.get("song_artist"),
                    payload.get("song_album"),
                    payload.get("cover_path"),
                    payload.get("position", 0),
                    payload.get("duration", 0),
                    1 if payload.get("is_playing") else 0,
                    payload.get("volume", 100),
                    1 if payload.get("is_shuffled") else 0,
                    payload.get("repeat_mode", "off"),
                    payload.get("queue_index", 0),
                    now,
                ),
            )
        except DatabaseError as e:
            if is_lock_timeout(e):
                print(f"[connect] heartbeat lock-wait timeout for {device_id}"
                      " — state kept from previous beat")
                return False
            raise

        if wants_queue:
            qhash = ConnectModel._qhash(queue_raw)
            try:
                row = Database.execute_query(
                    "SELECT qhash FROM connect_session_queues WHERE device_id = %s",
                    (device_id,),
                    fetch_one=True,
                )
                if not row or row.get("qhash") != qhash:
                    Database.execute_query(
                        """
                        INSERT INTO connect_session_queues
                            (device_id, user_id, qhash, queue, updated_at)
                        VALUES (%s, %s, %s, %s, %s)
                        ON DUPLICATE KEY UPDATE
                            user_id = VALUES(user_id),
                            qhash = VALUES(qhash),
                            queue = VALUES(queue),
                            updated_at = VALUES(updated_at)
                        """,
                        (device_id, user_id, qhash, queue_raw or None, now),
                    )
            except DatabaseError as e:
                if is_lock_timeout(e):
                    print(f"[connect] queue write lock-wait timeout for {device_id}"
                          " — queue kept from previous beat")
                    return False
                raise
        return True

    @staticmethod
    def _prune_stale(user_id):
        cutoff = time.time() - STALE_SECONDS
        Database.execute_query(
            "DELETE FROM connect_sessions WHERE user_id = %s AND last_seen < %s",
            (user_id, cutoff),
        )
        # Queue rows whose device row is gone (e.g. pruned just above) would
        # otherwise accumulate forever.
        Database.execute_query(
            """
            DELETE FROM connect_session_queues
            WHERE user_id = %s AND NOT EXISTS (
                SELECT 1 FROM connect_sessions s
                WHERE s.device_id = connect_session_queues.device_id
            )
            """,
            (user_id,),
        )

    @staticmethod
    def list_devices(user_id, exclude_device_id=None):
        """Return active (non-stale) devices for a user, newest first."""
        ConnectModel._prune_stale(user_id)
        rows = Database.execute_query(
            """
            SELECT s.*, q.queue AS queue_blob
            FROM connect_sessions s
            LEFT JOIN connect_session_queues q ON q.device_id = s.device_id
            WHERE s.user_id = %s
            ORDER BY s.last_seen DESC
            """,
            (user_id,),
            fetch_all=True,
        )
        devices = []
        for r in rows or []:
            if exclude_device_id and r["device_id"] == exclude_device_id:
                continue
            devices.append(ConnectModel._serialize(r))
        return devices

    @staticmethod
    def get_device(user_id, device_id):
        row = Database.execute_query(
            """
            SELECT s.*, q.queue AS queue_blob
            FROM connect_sessions s
            LEFT JOIN connect_session_queues q ON q.device_id = s.device_id
            WHERE s.user_id = %s AND s.device_id = %s
            """,
            (user_id, device_id),
            fetch_one=True,
        )
        return ConnectModel._serialize(row) if row else None

    @staticmethod
    def remove_device(user_id, device_id):
        """A device deregisters (e.g. player closed / app backgrounded)."""
        Database.execute_query(
            "DELETE FROM connect_sessions WHERE user_id = %s AND device_id = %s",
            (user_id, device_id),
        )
        Database.execute_query(
            "DELETE FROM connect_session_queues WHERE user_id = %s AND device_id = %s",
            (user_id, device_id),
        )

    @staticmethod
    def push_command(user_id, device_id, command, args=None):
        """Queue a remote-control command for a target device. The target
        device polls pending_commands() and applies them."""
        import json
        Database.execute_query(
            """
            INSERT INTO connect_commands
                (user_id, device_id, command, args, created_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (user_id, device_id, command, json.dumps(args or {}), time.time()),
        )

    @staticmethod
    def pending_commands(user_id, device_id):
        """Fetch and delete pending commands for this device (FIFO)."""
        import json
        rows = Database.execute_query(
            """SELECT id, command, args FROM connect_commands
               WHERE user_id = %s AND device_id = %s
               ORDER BY id ASC""",
            (user_id, device_id),
            fetch_all=True,
        )
        if not rows:
            return []
        ids = [r["id"] for r in rows]
        placeholders = ",".join(["%s"] * len(ids))
        Database.execute_query(
            f"DELETE FROM connect_commands WHERE id IN ({placeholders})",
            tuple(ids),
        )
        cmds = []
        for r in rows:
            try:
                args = json.loads(r["args"]) if r["args"] else {}
            except Exception:
                args = {}
            cmds.append({"command": r["command"], "args": args})
        return cmds

    @staticmethod
    def init_command_table():
        Database.execute_query("""
            CREATE TABLE IF NOT EXISTS connect_commands (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                device_id VARCHAR(64) NOT NULL,
                command VARCHAR(32) NOT NULL,
                args TEXT NULL,
                created_at DOUBLE NOT NULL,
                INDEX idx_device (user_id, device_id)
            )
        """)

    @staticmethod
    def _serialize(r):
        import json
        queue = []
        # queue_blob comes from the LEFT JOIN onto connect_session_queues.
        raw_queue = r.get("queue_blob")
        if raw_queue is None:
            raw_queue = r.get("queue")
        if raw_queue:
            try:
                queue = json.loads(raw_queue)
            except Exception:
                queue = []
        return {
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
            "volume": int(r["volume"] or 100),
            "is_shuffled": bool(r["is_shuffled"]),
            "repeat_mode": r["repeat_mode"] or "off",
            "queue": queue,
            "queue_index": int(r["queue_index"] or 0),
            "last_seen": float(r["last_seen"] or 0),
        }
