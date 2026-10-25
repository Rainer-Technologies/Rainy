"""Friends chat API — messages, presence and the live stream.

Endpoints (everything needs a friendship with the other account):
    GET  /api/chat/conversations        friends with last message, unread, presence
    GET  /api/chat/<friend_id>/messages ?before=<id>&limit=<n>, oldest first
    POST /api/chat/<friend_id>/messages {kind: text|song|playlist_invite, ...}
    POST /api/chat/<friend_id>/read     {up_to?}
    POST /api/chat/<friend_id>/typing
    GET  /api/chat/presence             who is online / listening
    GET  /api/chat/settings             PUT {share_online?, share_listening?}
    GET  /api/chat/stream               server-sent events (see chat_stream)

Like Rainy Connect, the stream is one long request, i.e. one server thread,
and other worker processes are reached through the database.
"""

import json
import threading
import time
from collections import defaultdict

from flask import Blueprint, Response, jsonify, request

from models.chat import KINDS, MAX_NOTE, MAX_TEXT, ChatModel
from models.friendship import FriendshipModel
from models.library_access import LibraryAccessModel
from models.playlist import PlaylistModel
from models.playlist_share import VALID_ROLES, PlaylistShareModel
from models.presence import PresenceModel
from routes.auth import get_current_user_id, require_auth, server_error
from utils import ratelimit

chat_bp = Blueprint('chat', __name__, url_prefix='/api/chat')

# How often a stream looks for new messages when nobody in this process woke it.
STREAM_POLL_SECONDS = 1.0
# How often it re-reads presence, typing and read marks of the user's friends.
STREAM_PRESENCE_SECONDS = 3.0
# How often an open stream counts as presence, and writes a comment so proxies
# keep the connection and a dead client is noticed.
STREAM_TOUCH_SECONDS = 10.0
STREAM_PING_SECONDS = 15.0
# A stream ends by itself after this long; the client reconnects and is
# authenticated again.
STREAM_MAX_SECONDS = 300.0
# Streams one user may hold open (a tab or a phone each).
STREAM_MAX_PER_USER = 6

SEND_LIMIT = (40, 60)     # messages per minute
TYPING_LIMIT = (120, 60)  # typing pings per minute


class _StreamHub:
    """Wakes the streams of a user when something happened for them in this
    process, so a message shows up at once instead of on the next poll."""

    def __init__(self):
        self._lock = threading.Lock()
        self._waiters = defaultdict(set)  # user_id -> {threading.Event}

    def open(self, user_id):
        """Register a stream; None when the user already holds too many."""
        with self._lock:
            if len(self._waiters[user_id]) >= STREAM_MAX_PER_USER:
                return None
            waiter = threading.Event()
            self._waiters[user_id].add(waiter)
            return waiter

    def close(self, user_id, waiter):
        """Forget a stream. Safe to call twice (generator end + response
        close both do)."""
        with self._lock:
            waiters = self._waiters.get(user_id)
            if not waiters:
                return
            waiters.discard(waiter)
            if not waiters:
                del self._waiters[user_id]

    def notify(self, user_id):
        with self._lock:
            waiters = list(self._waiters.get(user_id, ()))
        for waiter in waiters:
            waiter.set()


stream_hub = _StreamHub()


def _sse(event, data, event_id=None):
    lines = [f"id: {event_id}"] if event_id is not None else []
    lines += [f"event: {event}", f"data: {json.dumps(data, separators=(',', ':'))}"]
    return "\n".join(lines) + "\n\n"


def _watch_friends(user_id):
    return [f['id'] for f in FriendshipModel.friends_list(user_id)]


def chat_stream(user_id, after_id, waiter):
    """Server-sent events for one client of one account:

        message   a message sent or received (id = message id, resume point)
        presence  {users: [...], full}  friends whose presence changed
        read      {reader_id, author_id, last_read_id}  a read mark moved
        open      the stream is up

    Runs after the request context is gone, so every query uses its own
    short-lived connection."""
    try:
        PresenceModel.touch(user_id)
        started = touched = pinged = checked = time.monotonic()
        deadline = started + STREAM_MAX_SECONDS
        yield "retry: 2000\n" + _sse("open", {})

        friend_ids = _watch_friends(user_id)
        seen = PresenceModel.snapshot(user_id, friend_ids)
        yield _sse("presence", {'users': list(seen.values()), 'full': True})
        marks = ChatModel.read_marks(user_id)
        woken = False

        while time.monotonic() < deadline:
            now = time.monotonic()
            if now - touched >= STREAM_TOUCH_SECONDS:
                PresenceModel.touch(user_id)
                touched = now
            for message in ChatModel.after(user_id, after_id):
                after_id = message['id']
                yield _sse("message", message, event_id=message['id'])
                pinged = now
            if woken or now - checked >= STREAM_PRESENCE_SECONDS:
                checked = now
                friend_ids = _watch_friends(user_id)
                current = PresenceModel.snapshot(user_id, friend_ids)
                changed = [p for uid, p in current.items() if seen.get(uid) != p]
                gone = [{'user_id': uid, 'online': False, 'listening': None,
                         'typing': False} for uid in seen if uid not in current]
                seen = current
                if changed or gone:
                    yield _sse("presence", {'users': changed + gone, 'full': False})
                    pinged = now
                fresh = ChatModel.read_marks(user_id)
                for (reader, author), last in fresh.items():
                    if marks.get((reader, author)) != last:
                        yield _sse("read", {'reader_id': reader, 'author_id': author,
                                            'last_read_id': last})
                        pinged = now
                marks = fresh
            if now - pinged >= STREAM_PING_SECONDS:
                yield ": ping\n\n"
                pinged = now
            woken = waiter.wait(STREAM_POLL_SECONDS)
            waiter.clear()
    finally:
        stream_hub.close(user_id, waiter)


def _friend_or_error(user_id, friend_id):
    if not FriendshipModel.are_friends(user_id, friend_id):
        return jsonify({'error': 'Not a friend'}), 403
    return None


@chat_bp.route('/conversations', methods=['GET'])
@require_auth
def conversations():
    try:
        user_id = get_current_user_id()
        friends = FriendshipModel.friends_list(user_id)
        ids = [f['id'] for f in friends]
        talks = ChatModel.conversations(user_id, ids)
        presence = PresenceModel.snapshot(user_id, ids)
        out = []
        for f in friends:
            talk = talks.get(f['id'], {})
            out.append({
                'friend': {'id': f['id'], 'username': f['username']},
                'last_message': talk.get('last_message'),
                'unread': talk.get('unread', 0),
                'presence': presence.get(f['id']),
            })
        # Newest conversation first, then friends nobody wrote to yet.
        out.sort(key=lambda c: (c['last_message'] or {}).get('id', 0), reverse=True)
        return jsonify({'conversations': out})
    except Exception:
        return server_error()


@chat_bp.route('/<int:friend_id>/messages', methods=['GET'])
@require_auth
def list_messages(friend_id):
    try:
        user_id = get_current_user_id()
        err = _friend_or_error(user_id, friend_id)
        if err:
            return err
        before = request.args.get('before', type=int)
        limit = request.args.get('limit', type=int) or 50
        messages = ChatModel.thread(user_id, friend_id, before=before, limit=limit)
        return jsonify({'messages': messages})
    except Exception:
        return server_error()


@chat_bp.route('/<int:friend_id>/messages', methods=['POST'])
@require_auth
def send_message(friend_id):
    """Body: {kind: 'text', body}
             {kind: 'song', song_id, body?}
             {kind: 'playlist_invite', playlist_id, role?: 'admin'|'viewer'}"""
    try:
        user_id = get_current_user_id()
        if friend_id == user_id:
            return jsonify({'error': 'You cannot message yourself'}), 400
        err = _friend_or_error(user_id, friend_id)
        if err:
            return err
        data = request.get_json(silent=True) or {}
        kind = data.get('kind', 'text')
        if kind not in KINDS:
            return jsonify({'error': 'Unknown message kind'}), 400
        allowed, retry = ratelimit.check(f'chat:send:{user_id}', *SEND_LIMIT)
        if not allowed:
            return jsonify({'error': 'Slow down, you are sending too fast'}), 429

        body = data.get('body')
        body = body.strip() if isinstance(body, str) else None
        song_id = playlist_id = share_id = None
        if kind == 'text':
            if not body:
                return jsonify({'error': 'Write something first'}), 400
            if len(body) > MAX_TEXT:
                return jsonify({'error': f'Messages are limited to {MAX_TEXT} characters'}), 400
        elif kind == 'song':
            song_id = data.get('song_id')
            if not isinstance(song_id, int) or isinstance(song_id, bool):
                return jsonify({'error': 'song_id is required'}), 400
            # Only what you have in your own library can be passed on.
            if not LibraryAccessModel.has_access(user_id, song_id):
                return jsonify({'error': 'Song not found'}), 404
            body = body[:MAX_NOTE] if body else None
        else:
            playlist_id = data.get('playlist_id')
            if not isinstance(playlist_id, int) or isinstance(playlist_id, bool):
                return jsonify({'error': 'playlist_id is required'}), 400
            role = data.get('role', 'admin')
            if role not in VALID_ROLES:
                return jsonify({'error': "role must be 'admin' or 'viewer'"}), 400
            playlist = PlaylistModel.get_playlist_by_id(playlist_id)
            if not playlist or playlist.get('owner_user_id') != user_id:
                return jsonify({'error': 'You can only invite to your own playlists'}), 403
            status, share = PlaylistShareModel.invite(
                playlist_id, friend_id, user_id, role=role)
            if share is None:
                return jsonify({'error': 'That friend already has access to this playlist'}), 409
            share_id = share['id']
            body = None

        message_id = ChatModel.send(user_id, friend_id, kind, body, song_id,
                                    playlist_id, share_id)
        stream_hub.notify(friend_id)
        stream_hub.notify(user_id)
        return jsonify({'success': True,
                        'message': ChatModel.get(message_id, user_id)}), 201
    except Exception:
        return server_error()


@chat_bp.route('/<int:friend_id>/read', methods=['POST'])
@require_auth
def mark_read(friend_id):
    try:
        user_id = get_current_user_id()
        err = _friend_or_error(user_id, friend_id)
        if err:
            return err
        data = request.get_json(silent=True) or {}
        up_to = data.get('up_to')
        up_to = up_to if isinstance(up_to, int) and not isinstance(up_to, bool) else None
        last = ChatModel.mark_read(user_id, friend_id, up_to)
        return jsonify({'success': True, 'last_read_id': last})
    except Exception:
        return server_error()


@chat_bp.route('/<int:friend_id>/typing', methods=['POST'])
@require_auth
def typing(friend_id):
    try:
        user_id = get_current_user_id()
        err = _friend_or_error(user_id, friend_id)
        if err:
            return err
        allowed, _ = ratelimit.check(f'chat:typing:{user_id}', *TYPING_LIMIT)
        if allowed:
            PresenceModel.set_typing(user_id, friend_id)
            stream_hub.notify(friend_id)
        return jsonify({'success': True})
    except Exception:
        return server_error()


@chat_bp.route('/presence', methods=['GET'])
@require_auth
def presence():
    try:
        snapshot = PresenceModel.snapshot(get_current_user_id())
        return jsonify({'presence': list(snapshot.values())})
    except Exception:
        return server_error()


@chat_bp.route('/settings', methods=['GET'])
@require_auth
def get_settings():
    try:
        return jsonify(PresenceModel.get_settings(get_current_user_id()))
    except Exception:
        return server_error()


@chat_bp.route('/settings', methods=['PUT'])
@require_auth
def put_settings():
    try:
        data = request.get_json(silent=True) or {}
        values = {}
        for key in ('share_online', 'share_listening'):
            if key in data:
                if not isinstance(data[key], bool):
                    return jsonify({'error': f'{key} must be true or false'}), 400
                values[key] = data[key]
        return jsonify(PresenceModel.update_settings(get_current_user_id(), **values))
    except Exception:
        return server_error()


@chat_bp.route('/stream', methods=['GET'])
@require_auth
def stream():
    """Server-sent events (see chat_stream). ?after=<message id> (or
    Last-Event-ID on a reconnect) is the last message the client holds; leave
    it out to receive only what arrives from now on. While the stream is
    open the account counts as online."""
    user_id = get_current_user_id()
    raw = request.headers.get('Last-Event-ID') or request.args.get('after')
    try:
        after_id = max(0, int(raw)) if raw not in (None, '') else None
    except ValueError:
        after_id = None
    if after_id is None:
        after_id = ChatModel.latest_id(user_id)
    waiter = stream_hub.open(user_id)
    if waiter is None:
        return jsonify({'error': 'Too many streams'}), 429
    response = Response(
        chat_stream(user_id, after_id, waiter),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            # nginx would otherwise hold events back to fill its buffer.
            'X-Accel-Buffering': 'no',
        },
    )
    # A generator that was never started runs no `finally`: release the slot
    # here too, for a client that left before the first byte.
    response.call_on_close(lambda: stream_hub.close(user_id, waiter))
    return response
