"""Listen together API — a host invites friends to hear what they play.

    POST /api/listen/invite               {friend_id, device_id}: open the host's
                                          session on this device and invite a friend
    GET  /api/listen/<id>                 the session as the viewer may see it
    POST /api/listen/<id>/join            take up an invitation
    POST /api/listen/<id>/leave           leave, or decline (closes the invitation)
    POST /api/listen/<id>/end             host only: end it for everyone

The session itself reaches the clients on the chat stream as `listen` events
(routes/chat.py); the host's playback comes in with the Connect beat
(routes/connect.py). Everything needs a friendship with the host.
"""

from flask import Blueprint, jsonify, request

from models.friendship import FriendshipModel
from models.listen import MAX_MEMBERS, ListenModel
from models.chat import ChatModel
from routes.auth import get_current_user_id, require_auth, server_error
from routes.chat import stream_hub
from utils import ratelimit

listen_bp = Blueprint('listen', __name__, url_prefix='/api/listen')

INVITE_LIMIT = (30, 60)  # invitations per minute


def _device_id(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if 0 < len(value) <= 64 else None


def _wake(user_ids):
    for user_id in user_ids or []:
        stream_hub.notify(user_id)


@listen_bp.route('/invite', methods=['POST'])
@require_auth
def invite():
    try:
        user_id = get_current_user_id()
        data = request.get_json(silent=True) or {}
        friend_id = data.get('friend_id')
        if not isinstance(friend_id, int) or isinstance(friend_id, bool):
            return jsonify({'error': 'friend_id is required'}), 400
        device_id = _device_id(data.get('device_id'))
        if not device_id:
            return jsonify({'error': 'device_id is required'}), 400
        if friend_id == user_id:
            return jsonify({'error': 'You cannot listen with yourself'}), 400
        if not FriendshipModel.are_friends(user_id, friend_id):
            return jsonify({'error': 'Not a friend'}), 403
        allowed, _ = ratelimit.check(f'listen:invite:{user_id}', *INVITE_LIMIT)
        if not allowed:
            return jsonify({'error': 'Slow down, you are inviting too fast'}), 429

        session_id = ListenModel.open_session(user_id, device_id)
        state = ListenModel.member_state(session_id, friend_id)
        if state == 'joined':
            return jsonify({'error': 'They are already listening with you'}), 409
        if state != 'invited' and ListenModel.listener_count(session_id) >= MAX_MEMBERS:
            return jsonify({'error': 'The session is full'}), 409

        ListenModel.invite(session_id, friend_id)
        ChatModel.send(user_id, friend_id, 'listen_invite', listen_session_id=session_id)
        _wake(ListenModel.audience(session_id))
        snapshot = ListenModel.snapshot(session_id, user_id)
        return jsonify({'success': True, 'session': snapshot}), 201
    except Exception:
        return server_error()


@listen_bp.route('/<int:session_id>', methods=['GET'])
@require_auth
def get_session(session_id):
    try:
        snapshot = ListenModel.snapshot(session_id, get_current_user_id())
        if snapshot is None:
            return jsonify({'error': 'Session not found'}), 404
        return jsonify({'session': snapshot})
    except Exception:
        return server_error()


@listen_bp.route('/<int:session_id>/join', methods=['POST'])
@require_auth
def join(session_id):
    try:
        user_id = get_current_user_id()
        audience = ListenModel.join(user_id, session_id)
        if audience is None:
            return jsonify({'error': 'This invitation is no longer open'}), 409
        _wake(audience)
        return jsonify({'success': True, 'session': ListenModel.snapshot(session_id, user_id)})
    except Exception:
        return server_error()


@listen_bp.route('/<int:session_id>/leave', methods=['POST'])
@require_auth
def leave(session_id):
    try:
        audience = ListenModel.leave(get_current_user_id(), session_id)
        if audience is None:
            return jsonify({'error': 'You are not listening to this session'}), 404
        _wake(audience)
        return jsonify({'success': True})
    except Exception:
        return server_error()


@listen_bp.route('/<int:session_id>/end', methods=['POST'])
@require_auth
def end(session_id):
    try:
        audience = ListenModel.end(get_current_user_id(), session_id)
        if audience is None:
            return jsonify({'error': 'No live session of yours with that id'}), 404
        _wake(audience)
        return jsonify({'success': True})
    except Exception:
        return server_error()
