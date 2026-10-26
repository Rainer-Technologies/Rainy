"""
Listen together: a host plays, and friends hear the same song at the same
place until they leave.

A host invites friends from a chat message. The session is bound to the device
the host plays on, and that device's Rainy Connect beat carries the playback
(`host_beat`), so the host sends nothing extra. Followers receive the session
as `listen` events on the chat stream (routes/chat.py) and play what the host
plays; LibraryAccessModel lets a joined friend stream exactly that song.

A friend is 'invited', 'joined' or 'left'. Joining is only possible while
invited. Leaving (or declining) closes the invitation for good: it comes back
only with a new invite from the host. Ending the session closes everyone's.
"""

import time

from models.database import Database
from models.library_access import LibraryAccessModel

MAX_MEMBERS = 8        # invited and joined friends at once
# A host position this far from where the session expects it is a seek.
SEEK_SECONDS = 1.5
# The host counts as live while its device beat this recently (Connect beats
# every 2 seconds; a background tab may be throttled).
HOST_LIVE_SECONDS = 15
# A session that ended, and a member who left, stay visible to the stream for
# this long, so every client hears about the change.
RECENT_SECONDS = 300


def _now():
    return time.time()


def _seconds(value):
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


def _song_id(value):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


class ListenModel:
    # ── Session and members ─────────────────────────────────────────

    @staticmethod
    def open_session(host_id, device_id):
        """The host's live session, created when there is none. It is bound to
        `device_id` from now on: the device the host is playing on."""
        row = Database.execute_query(
            "SELECT id FROM listen_sessions WHERE host_id = %s AND status = 'live'"
            " ORDER BY id DESC LIMIT 1", (host_id,), fetch_one=True)
        if row:
            Database.execute_query(
                "UPDATE listen_sessions SET host_device_id = %s WHERE id = %s",
                (device_id, row['id']))
            return row['id']
        now = _now()
        return Database.execute_query(
            "INSERT INTO listen_sessions (host_id, host_device_id, status,"
            " created_at, host_seen, state_at)"
            " VALUES (%s, %s, 'live', %s, 0, %s)", (host_id, device_id, now, now))

    @staticmethod
    def member_state(session_id, user_id):
        """'invited', 'joined', 'left', or None when the user was never invited."""
        row = Database.execute_query(
            "SELECT state FROM listen_members WHERE session_id = %s AND user_id = %s",
            (session_id, user_id), fetch_one=True)
        return row['state'] if row else None

    @staticmethod
    def listener_count(session_id):
        row = Database.execute_query(
            "SELECT COUNT(*) AS n FROM listen_members"
            " WHERE session_id = %s AND state <> 'left'", (session_id,), fetch_one=True)
        return row['n'] if row else 0

    @staticmethod
    def invite(session_id, friend_id):
        """Invite a friend, or invite them again after they left."""
        now = _now()
        if ListenModel.member_state(session_id, friend_id):
            Database.execute_query(
                "UPDATE listen_members SET state = 'invited', invited_at = %s,"
                " updated_at = %s WHERE session_id = %s AND user_id = %s",
                (now, now, session_id, friend_id))
        else:
            Database.execute_query(
                "INSERT INTO listen_members (session_id, user_id, state, invited_at,"
                " updated_at) VALUES (%s, %s, 'invited', %s, %s)",
                (session_id, friend_id, now, now))
        ListenModel._bump(session_id)

    @staticmethod
    def join(user_id, session_id):
        """Take up an open invitation. Answers who must hear about it, or None
        when there is no open invitation to a live session."""
        if ListenModel.member_state(session_id, user_id) != 'invited' \
                or not ListenModel._is_live(session_id):
            return None
        audience = ListenModel.audience(session_id)
        Database.execute_query(
            "UPDATE listen_members SET state = 'joined', updated_at = %s"
            " WHERE session_id = %s AND user_id = %s", (_now(), session_id, user_id))
        ListenModel._bump(session_id)
        return audience

    @staticmethod
    def leave(user_id, session_id):
        """Leave, or decline the invitation. The invitation closes. Answers who
        must hear about it, or None when the user is not invited."""
        if ListenModel.member_state(session_id, user_id) not in ('invited', 'joined'):
            return None
        audience = ListenModel.audience(session_id)
        Database.execute_query(
            "UPDATE listen_members SET state = 'left', updated_at = %s"
            " WHERE session_id = %s AND user_id = %s", (_now(), session_id, user_id))
        ListenModel._bump(session_id)
        return audience

    @staticmethod
    def end(host_id, session_id):
        """End the session for everyone. Answers who must hear about it, or None
        when `host_id` does not host a live session with that id."""
        if not ListenModel._is_live(session_id, host_id):
            return None
        audience = ListenModel.audience(session_id)
        now = _now()
        Database.execute_query(
            "UPDATE listen_sessions SET status = 'ended', ended_at = %s, is_playing = 0,"
            " song_id = NULL, song_title = NULL, song_artist = NULL, song_album = NULL,"
            " cover_path = NULL, version = version + 1 WHERE id = %s", (now, session_id))
        Database.execute_query(
            "UPDATE listen_members SET state = 'left', updated_at = %s"
            " WHERE session_id = %s AND state <> 'left'", (now, session_id))
        return audience

    @staticmethod
    def audience(session_id):
        """User ids that must hear about a change: the host and the members
        still in the session (or still invited)."""
        host = Database.execute_query(
            "SELECT host_id FROM listen_sessions WHERE id = %s", (session_id,), fetch_one=True)
        members = Database.execute_query(
            "SELECT user_id FROM listen_members WHERE session_id = %s AND state <> 'left'",
            (session_id,), fetch_all=True) or []
        ids = {m['user_id'] for m in members}
        if host:
            ids.add(host['host_id'])
        return sorted(ids)

    @staticmethod
    def _is_live(session_id, host_id=None):
        sql = "SELECT id FROM listen_sessions WHERE id = %s AND status = 'live'"
        args = [session_id]
        if host_id is not None:
            sql += " AND host_id = %s"
            args.append(host_id)
        return Database.execute_query(sql, tuple(args), fetch_one=True) is not None

    @staticmethod
    def _bump(session_id):
        """Every change moves the version, which is what the stream compares."""
        Database.execute_query(
            "UPDATE listen_sessions SET version = version + 1 WHERE id = %s", (session_id,))

    # ── The host's playback ─────────────────────────────────────────

    @staticmethod
    def host_beat(user_id, device_id, payload):
        """Take in a Connect beat of `device_id`. When that device is the source
        of one of `user_id`'s live sessions, the session follows its playback.

        A change of song, of play state or a seek moves the state sequence
        (`state_seq`), which tells followers to apply the state in full. A
        plain tick only refreshes the position, so followers correct drift
        without restarting or resuming anything they paused themselves.

        Answers who must hear about it (empty when nothing visible moved)."""
        row = Database.execute_query(
            "SELECT * FROM listen_sessions WHERE host_id = %s AND host_device_id = %s"
            " AND status = 'live' ORDER BY id DESC LIMIT 1",
            (user_id, device_id), fetch_one=True)
        if not row:
            return []
        now = _now()
        song_id = _song_id(payload.get('song_id'))
        song_changed = song_id != row['song_id']
        if song_changed and song_id is not None \
                and not LibraryAccessModel.can_play(user_id, song_id):
            song_id = None  # the host never shares what they cannot play
        position = _seconds(payload.get('position'))
        playing = bool(payload.get('is_playing')) and song_id is not None
        play_changed = playing != bool(row['is_playing'])
        seeked = abs(ListenModel._position(row, now) - position) > SEEK_SECONDS

        if song_changed or play_changed or seeked:
            song = ListenModel._song(song_id)
            Database.execute_query(
                "UPDATE listen_sessions SET song_id = %s, song_title = %s, song_artist = %s,"
                " song_album = %s, cover_path = %s, is_playing = %s, position = %s,"
                " state_at = %s, state_seq = state_seq + 1, host_seen = %s,"
                " version = version + 1 WHERE id = %s",
                (song['id'] if song else None,
                 song['title'] if song else None,
                 song['artist'] if song else None,
                 song['album'] if song else None,
                 song['cover_path'] if song else None,
                 1 if playing and song else 0, position, now, now, row['id']))
        else:
            # Playing sessions move on every tick, so followers hear each one;
            # a paused session only refreshes the host's liveness.
            Database.execute_query(
                "UPDATE listen_sessions SET position = %s, state_at = %s, host_seen = %s,"
                " version = version + %s WHERE id = %s",
                (position, now, now, 1 if playing else 0, row['id']))
            if not playing:
                return []
        return ListenModel.audience(row['id'])

    @staticmethod
    def _song(song_id):
        if song_id is None:
            return None
        return Database.execute_query(
            "SELECT id, title, artist, album, cover_path FROM songs WHERE id = %s",
            (song_id,), fetch_one=True)

    @staticmethod
    def _position(row, now):
        """Where the session's playback is now, from the last state it was given."""
        position = float(row['position'] or 0)
        if row['is_playing'] and row['song_id'] is not None:
            position += max(0.0, now - float(row['state_at'] or 0))
        return position

    # ── Reading ─────────────────────────────────────────────────────

    @staticmethod
    def snapshot(session_id, viewer_id, now=None):
        """A session as `viewer_id` may see it, or None when they have no part
        in it. The song and the position are only for the host and for members
        who joined; members are listed to everyone in the session.

            {id, status, role, state, host, members, song, playing, position,
             state_seq, host_live, host_age, version}

        `state` is the viewer's own: 'host', or 'invited', 'joined', 'left'."""
        now = _now() if now is None else now
        row = Database.execute_query(
            "SELECT s.*, u.username AS host_name FROM listen_sessions s"
            " JOIN users u ON u.id = s.host_id WHERE s.id = %s", (session_id,), fetch_one=True)
        if not row:
            return None
        is_host = row['host_id'] == viewer_id
        state = 'host' if is_host else ListenModel.member_state(session_id, viewer_id)
        if state is None:
            return None
        members = Database.execute_query(
            "SELECT m.user_id, m.state, u.username FROM listen_members m"
            " JOIN users u ON u.id = m.user_id"
            " WHERE m.session_id = %s AND m.state <> 'left' ORDER BY m.invited_at, m.user_id",
            (session_id,), fetch_all=True) or []
        listening = row['status'] == 'live' and (is_host or state == 'joined')
        song = None
        if listening and row['song_id'] is not None:
            length = Database.execute_query(
                "SELECT duration FROM songs WHERE id = %s", (row['song_id'],),
                fetch_one=True) or {}
            song = {'id': row['song_id'], 'title': row['song_title'],
                    'artist': row['song_artist'], 'album': row['song_album'],
                    'cover_path': row['cover_path'],
                    'duration': float(length.get('duration') or 0),
                    # A listener may keep what they hear in their own library.
                    'in_library': LibraryAccessModel.has_access(viewer_id, row['song_id'])}
        age = max(0.0, now - float(row['host_seen'] or 0))
        return {
            'id': row['id'],
            'status': row['status'],
            'role': 'host' if is_host else 'guest',
            'state': state,
            'host': {'id': row['host_id'], 'username': row['host_name']},
            'members': [{'id': m['user_id'], 'username': m['username'], 'state': m['state']}
                        for m in members],
            'song': song,
            'playing': bool(song) and bool(row['is_playing']),
            'position': round(ListenModel._position(row, now), 3) if song else 0,
            'state_seq': row['state_seq'],
            'host_live': age <= HOST_LIVE_SECONDS,
            'host_age': round(age, 1),
            'version': row['version'],
        }

    @staticmethod
    def visible(user_id, now=None):
        """{session_id: version} of the sessions the stream reports on for
        `user_id`: the ones they host, and the ones they are invited to or
        joined, plus those that ended or were left in the last few minutes."""
        now = _now() if now is None else now
        recent = now - RECENT_SECONDS
        rows = Database.execute_query(
            "SELECT s.id, s.version FROM listen_sessions s"
            " WHERE (s.host_id = %s OR s.id IN ("
            "   SELECT m.session_id FROM listen_members m WHERE m.user_id = %s"
            "   AND (m.state IN ('invited', 'joined') OR m.updated_at >= %s)))"
            " AND (s.status = 'live' OR s.ended_at >= %s)",
            (user_id, user_id, recent, recent), fetch_all=True) or []
        return {r['id']: r['version'] for r in rows}

    @staticmethod
    def invite_card(session_id, listener_id, message_id):
        """What the listen invitation message `message_id` shows: the session's
        status, the listener's state in it, and the host. Only the newest
        invitation to a listener is open: an older card reads as 'left', as
        does any card of a closed session or one the listener left."""
        row = Database.execute_query(
            "SELECT s.status, s.host_id, u.username AS host_name, m.state,"
            " (SELECT MAX(c.id) FROM chat_messages c"
            "  WHERE c.listen_session_id = s.id AND c.recipient_id = %s) AS newest"
            " FROM listen_sessions s JOIN users u ON u.id = s.host_id"
            " LEFT JOIN listen_members m ON m.session_id = s.id AND m.user_id = %s"
            " WHERE s.id = %s", (listener_id, listener_id, session_id), fetch_one=True)
        if not row:
            return {'session_id': session_id, 'status': 'ended', 'state': 'left', 'host': None}
        state = row['state'] or 'left'
        if row['status'] != 'live' or row['newest'] != message_id:
            state = 'left'
        return {'session_id': session_id, 'status': row['status'], 'state': state,
                'host': {'id': row['host_id'], 'username': row['host_name']}}
