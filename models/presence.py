"""
Friends presence: who is online and what they are listening to.

Online means a client of the account holds its chat stream open (it touches
`user_presence` every few seconds) or a Rainy Connect device is alive (see
models/connect.py). What a friend is listening to is read from the Connect
heartbeat their player already sends, so no client reports it twice. Each
account decides what its friends may see (`share_online`,
`share_listening`); a hidden account simply looks offline.
"""

import time

from models.connect import STALE_SECONDS
from models.database import Database
from models.friendship import FriendshipModel

# A chat stream touches presence this often (routes/chat.py); the account is
# offline when the last touch is older than ONLINE_SECONDS.
ONLINE_SECONDS = 45
# "is typing" fades after this long without another keystroke ping.
TYPING_SECONDS = 6


def _now():
    return time.time()


def _in(ids):
    return ','.join(['%s'] * len(ids))


class PresenceModel:
    @staticmethod
    def touch(user_id):
        Database.execute_query(
            "INSERT INTO user_presence (user_id, last_seen) VALUES (%s, %s)"
            " ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen)",
            (user_id, _now()))

    @staticmethod
    def set_typing(user_id, to_id):
        now = _now()
        Database.execute_query(
            "INSERT INTO user_presence (user_id, last_seen, typing_to, typing_at)"
            " VALUES (%s, %s, %s, %s)"
            " ON DUPLICATE KEY UPDATE typing_to = VALUES(typing_to),"
            " typing_at = VALUES(typing_at)",
            (user_id, now, to_id, now))

    @staticmethod
    def get_settings(user_id):
        row = Database.execute_query(
            "SELECT share_online, share_listening FROM users WHERE id = %s",
            (user_id,), fetch_one=True) or {}
        return {'share_online': bool(row.get('share_online', 1)),
                'share_listening': bool(row.get('share_listening', 1))}

    @staticmethod
    def update_settings(user_id, share_online=None, share_listening=None):
        if share_online is not None:
            Database.execute_query(
                "UPDATE users SET share_online = %s WHERE id = %s",
                (1 if share_online else 0, user_id))
        if share_listening is not None:
            Database.execute_query(
                "UPDATE users SET share_listening = %s WHERE id = %s",
                (1 if share_listening else 0, user_id))
        return PresenceModel.get_settings(user_id)

    @staticmethod
    def snapshot(viewer_id, friend_ids=None):
        """{friend_id: {user_id, online, listening, typing}} for the viewer's
        friends, as the viewer is allowed to see them.

        `listening` is {song_id, title, artist, album, cover_path} while the
        friend plays something, else None. `typing` is true while the friend
        is writing to the viewer. Never exposes devices, queues or times."""
        if friend_ids is None:
            friend_ids = [f['id'] for f in FriendshipModel.friends_list(viewer_id)]
        if not friend_ids:
            return {}
        now = _now()
        marks = _in(friend_ids)
        users = Database.execute_query(
            "SELECT u.id, u.share_online, u.share_listening, p.last_seen,"
            " p.typing_to, p.typing_at FROM users u"
            " LEFT JOIN user_presence p ON p.user_id = u.id"
            f" WHERE u.id IN ({marks})", tuple(friend_ids), fetch_all=True) or []
        devices = Database.execute_query(
            "SELECT user_id, MAX(GREATEST(last_seen, stream_seen)) AS alive"
            f" FROM connect_sessions WHERE user_id IN ({marks})"
            " GROUP BY user_id", tuple(friend_ids), fetch_all=True) or []
        alive = {d['user_id']: d['alive'] or 0 for d in devices}
        playing = Database.execute_query(
            "SELECT user_id, song_id, song_title, song_artist, song_album,"
            " cover_path FROM connect_sessions"
            f" WHERE user_id IN ({marks}) AND is_playing = 1"
            " AND song_id IS NOT NULL AND last_seen >= %s"
            " ORDER BY last_seen ASC",
            (*friend_ids, now - STALE_SECONDS), fetch_all=True) or []
        listening = {}
        for row in playing:  # ascending: the most recent device wins
            listening[row['user_id']] = {
                'song_id': row['song_id'], 'title': row['song_title'],
                'artist': row['song_artist'], 'album': row['song_album'],
                'cover_path': row['cover_path']}

        out = {}
        for u in users:
            uid = u['id']
            online = bool(u['share_online']) and (
                (u['last_seen'] or 0) >= now - ONLINE_SECONDS
                or alive.get(uid, 0) >= now - STALE_SECONDS)
            typing = bool(online and u['typing_to'] == viewer_id
                          and (u['typing_at'] or 0) >= now - TYPING_SECONDS)
            out[uid] = {
                'user_id': uid,
                'online': online,
                'listening': (listening.get(uid)
                              if online and u['share_listening'] else None),
                'typing': typing,
            }
        return out
