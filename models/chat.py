"""
Friends chat: text, songs and playlist invitations between two friends.

A message is a row in `chat_messages` with an ever-growing id, so a client that
was away asks for "everything after id N". Songs and invitations are
references, never copies: the receiver streams the song through
LibraryAccessModel.can_play (which honours a song a friend sent them) and keeps
it with the usual "save to library"; an invitation is a normal pending
`playlist_shares` row that the receiver accepts or declines from the message.

Nothing here checks that two users are friends: the routes do, on every read
and write, so unfriending closes the conversation without deleting it.
"""

import time

from models.database import Database
from models.library_access import LibraryAccessModel

KINDS = ('text', 'song', 'playlist_invite')
MAX_TEXT = 2000
MAX_NOTE = 500
PAGE = 50
MAX_PAGE = 100


def _now():
    return time.time()


def _in(ids):
    return ','.join(['%s'] * len(ids))


def _pair(a, b):
    return ("((m.sender_id = %s AND m.recipient_id = %s)"
            " OR (m.sender_id = %s AND m.recipient_id = %s))"), (a, b, b, a)


class ChatModel:
    @staticmethod
    def send(sender_id, recipient_id, kind, body=None, song_id=None,
             playlist_id=None, share_id=None):
        """Store a message and answer its id."""
        return Database.execute_query(
            "INSERT INTO chat_messages (sender_id, recipient_id, kind, body,"
            " song_id, playlist_id, share_id, created_at)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (sender_id, recipient_id, kind, body, song_id, playlist_id,
             share_id, _now()))

    @staticmethod
    def get(message_id, viewer_id):
        row = Database.execute_query(
            "SELECT * FROM chat_messages WHERE id = %s", (message_id,),
            fetch_one=True)
        return ChatModel.serialize([row], viewer_id)[0] if row else None

    @staticmethod
    def thread(user_id, friend_id, before=None, limit=PAGE):
        """One page of the conversation, oldest first. `before` is a message
        id: only older messages come back."""
        limit = max(1, min(int(limit or PAGE), MAX_PAGE))
        where, params = _pair(user_id, friend_id)
        if before:
            where += " AND m.id < %s"
            params += (int(before),)
        rows = Database.execute_query(
            f"SELECT m.* FROM chat_messages m WHERE {where}"
            " ORDER BY m.id DESC LIMIT %s", (*params, limit),
            fetch_all=True) or []
        rows.reverse()
        return ChatModel.serialize(rows, user_id)

    @staticmethod
    def latest_id(user_id):
        row = Database.execute_query(
            "SELECT MAX(id) AS last FROM chat_messages"
            " WHERE sender_id = %s OR recipient_id = %s",
            (user_id, user_id), fetch_one=True)
        return (row or {}).get('last') or 0

    @staticmethod
    def after(user_id, after_id, limit=MAX_PAGE):
        """Messages the user sent or received with an id above `after_id`,
        oldest first (what the chat stream delivers)."""
        rows = Database.execute_query(
            "SELECT * FROM chat_messages WHERE id > %s"
            " AND (sender_id = %s OR recipient_id = %s)"
            " ORDER BY id ASC LIMIT %s",
            (after_id, user_id, user_id, limit), fetch_all=True) or []
        return ChatModel.serialize(rows, user_id)

    @staticmethod
    def conversations(user_id, friend_ids):
        """{friend_id: {last_message, unread}} for friends who have either."""
        out = {}
        if not friend_ids:
            return out
        last = Database.execute_query(
            "SELECT m.* FROM chat_messages m WHERE m.id IN ("
            " SELECT MAX(id) FROM chat_messages"
            " WHERE sender_id = %s OR recipient_id = %s"
            " GROUP BY CASE WHEN sender_id = %s THEN recipient_id"
            " ELSE sender_id END)",
            (user_id, user_id, user_id), fetch_all=True) or []
        for message in ChatModel.serialize(last, user_id):
            other = (message['recipient_id'] if message['sender_id'] == user_id
                     else message['sender_id'])
            out[other] = {'last_message': message, 'unread': 0}
        unread = Database.execute_query(
            "SELECT m.sender_id, COUNT(*) AS n FROM chat_messages m"
            " LEFT JOIN chat_reads r"
            " ON r.user_id = %s AND r.friend_id = m.sender_id"
            " WHERE m.recipient_id = %s"
            " AND m.id > COALESCE(r.last_read_id, 0)"
            " GROUP BY m.sender_id", (user_id, user_id), fetch_all=True) or []
        for row in unread:
            out.setdefault(row['sender_id'],
                           {'last_message': None, 'unread': 0})['unread'] = row['n']
        return out

    @staticmethod
    def mark_read(user_id, friend_id, up_to=None):
        """Mark the friend's messages up to `up_to` (default: all) as read.
        Only ever moves forward, and never past a message that exists.
        Answers the new mark."""
        row = Database.execute_query(
            "SELECT MAX(id) AS last FROM chat_messages"
            " WHERE sender_id = %s AND recipient_id = %s",
            (friend_id, user_id), fetch_one=True)
        newest = (row or {}).get('last') or 0
        mark = newest if up_to is None else min(int(up_to), newest)
        Database.execute_query(
            "INSERT INTO chat_reads (user_id, friend_id, last_read_id)"
            " VALUES (%s, %s, %s)"
            " ON DUPLICATE KEY UPDATE"
            " last_read_id = GREATEST(last_read_id, VALUES(last_read_id))",
            (user_id, friend_id, mark))
        row = Database.execute_query(
            "SELECT last_read_id FROM chat_reads"
            " WHERE user_id = %s AND friend_id = %s",
            (user_id, friend_id), fetch_one=True)
        return (row or {}).get('last_read_id') or 0

    @staticmethod
    def read_marks(user_id):
        """{(reader_id, author_id): last_read_id} for every mark that involves
        the user: their own (they read a friend's messages) and their
        friends' (a friend read theirs)."""
        rows = Database.execute_query(
            "SELECT user_id, friend_id, last_read_id FROM chat_reads"
            " WHERE user_id = %s OR friend_id = %s",
            (user_id, user_id), fetch_all=True) or []
        return {(r['user_id'], r['friend_id']): r['last_read_id'] for r in rows}

    @staticmethod
    def serialize(rows, viewer_id):
        """Messages as the API shows them to `viewer_id`: songs and
        invitations are filled in from their current state."""
        rows = [r for r in rows if r]
        if not rows:
            return []
        songs = ChatModel._songs({r['song_id'] for r in rows if r['song_id']})
        shares = ChatModel._shares({r['share_id'] for r in rows if r['share_id']})
        out = []
        for r in rows:
            message = {
                'id': r['id'],
                'sender_id': r['sender_id'],
                'recipient_id': r['recipient_id'],
                'kind': r['kind'],
                'body': r['body'],
                'created_at': r['created_at'],
            }
            if r['kind'] == 'song':
                song = songs.get(r['song_id'])
                if song:
                    song = dict(song, in_library=(
                        r['sender_id'] == viewer_id
                        or LibraryAccessModel.has_access(viewer_id, song['id'])))
                message['song'] = song
            elif r['kind'] == 'playlist_invite':
                message['invite'] = ChatModel._invite(r, shares.get(r['share_id']))
            out.append(message)
        return out

    @staticmethod
    def _songs(ids):
        if not ids:
            return {}
        rows = Database.execute_query(
            "SELECT id, title, artist, album, duration, cover_path"
            f" FROM songs WHERE id IN ({_in(ids)})", tuple(ids),
            fetch_all=True) or []
        return {r['id']: r for r in rows}

    @staticmethod
    def _shares(ids):
        if not ids:
            return {}
        rows = Database.execute_query(
            "SELECT ps.id, ps.playlist_id, ps.role, ps.status,"
            " p.name AS playlist_name FROM playlist_shares ps"
            " JOIN playlists p ON p.id = ps.playlist_id"
            f" WHERE ps.id IN ({_in(ids)})", tuple(ids), fetch_all=True) or []
        return {r['id']: r for r in rows}

    @staticmethod
    def _invite(message, share):
        """An invitation's live state: 'pending', 'accepted', or 'closed'
        once it was declined, revoked or its playlist deleted."""
        if not share:
            return {'share_id': message['share_id'],
                    'playlist_id': message['playlist_id'],
                    'playlist_name': None, 'role': None, 'state': 'closed'}
        return {'share_id': share['id'], 'playlist_id': share['playlist_id'],
                'playlist_name': share['playlist_name'], 'role': share['role'],
                'state': share['status']}
