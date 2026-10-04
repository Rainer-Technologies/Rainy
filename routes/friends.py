"""Friends API — the social graph.

Endpoints:
    GET    /api/friends              accepted friends
    GET    /api/friends/requests     incoming + outgoing pending requests
    POST   /api/friends/requests     send a request {email | username}
    POST   /api/friends/requests/<id>/accept
    POST   /api/friends/requests/<id>/decline
    DELETE /api/friends/<friend_id>  unfriend
"""
from flask import Blueprint, jsonify, request, session

from models.friendship import FriendshipModel
from routes.auth import require_auth, server_error

friends_bp = Blueprint('friends', __name__, url_prefix='/api/friends')


@friends_bp.route('', methods=['GET'])
@require_auth
def list_friends():
    """Accepted friends, with profile info."""
    try:
        return jsonify({'friends': FriendshipModel.friends_list(session['user_id'])})
    except Exception:
        return server_error()


@friends_bp.route('/requests', methods=['GET'])
@require_auth
def list_requests():
    """Pending incoming + outgoing friend requests."""
    try:
        user_id = session['user_id']
        incoming = FriendshipModel.incoming(user_id)
        outgoing = FriendshipModel.outgoing(user_id)
        # The invitee needs to know who to send invites to — they are all
        # here with their public info.
        return jsonify({
            'incoming': incoming,
            'outgoing': outgoing,
        })
    except Exception:
        return server_error()


@friends_bp.route('/requests', methods=['POST'])
@require_auth
def send_request():
    """Send a friend request by email or username.

    Auto-accepts when the target already sent us a request (mutual
    connect). Idempotent for already-pending / already-friends states.
    """
    try:
        data = request.get_json() or {}
        identifier = data.get('email') or data.get('username')
        if not identifier:
            return jsonify({'error': 'Email or username is required'}), 400

        target = FriendshipModel.find_user(identifier)
        if not target:
            return jsonify({'error': 'No user found with that email or username'}), 404

        requester_id = session['user_id']
        status, row = FriendshipModel.send_request(requester_id, target['id'])

        if status == 'self':
            return jsonify({'error': 'You cannot befriend yourself'}), 400
        if status == 'already_friends':
            return jsonify({'error': f'You are already friends with {target["username"]}'}), 409
        if status == 'accepted':
            return jsonify({
                'success': True,
                'status': 'accepted',
                'message': f'You and {target["username"]} are now friends'
            })
        if status == 'pending':
            return jsonify({
                'success': True,
                'status': 'pending',
                'message': f'Friend request sent to {target["username"]}'
            })
        return jsonify({'error': 'Unexpected friendship state'}), 500
    except Exception:
        return server_error()


@friends_bp.route('/requests/<int:request_id>/accept', methods=['POST'])
@require_auth
def accept_request(request_id):
    """Accept a pending friend request addressed to us."""
    try:
        user_id = session['user_id']
        row = FriendshipModel.find_request(request_id, user_id)
        if not row or row['status'] != 'pending':
            return jsonify({'error': 'Request not found'}), 404
        if row['friend_id'] != user_id:
            return jsonify({'error': 'Only the recipient can accept a request'}), 403
        # The UPDATE is itself restricted to pending rows addressed to us;
        # execute_query returns lastrowid (0 for UPDATE) so don't test it.
        FriendshipModel.accept(request_id, user_id)

        target_id = row['user_id']
        from models.user import UserModel
        target = UserModel.get_user_by_id(target_id)
        return jsonify({
            'success': True,
            'message': f'You are now friends with {target["username"]}',
        })
    except Exception:
        return server_error()


@friends_bp.route('/requests/<int:request_id>/decline', methods=['POST'])
@require_auth
def decline_request(request_id):
    """Decline an incoming request, or withdraw one we sent."""
    try:
        user_id = session['user_id']
        row = FriendshipModel.find_request(request_id, user_id)
        if not row:
            return jsonify({'error': 'Request not found'}), 404
        FriendshipModel.decline(request_id, user_id)
        return jsonify({'success': True})
    except Exception:
        return server_error()


@friends_bp.route('/<int:friend_id>', methods=['DELETE'])
@require_auth
def remove_friend(friend_id):
    """Remove an accepted friendship."""
    try:
        user_id = session['user_id']
        if user_id == friend_id:
            return jsonify({'error': 'You cannot unfriend yourself'}), 400
        if not FriendshipModel.are_friends(user_id, friend_id):
            return jsonify({'error': 'You are not friends with this user'}), 404
        FriendshipModel.remove_friend(user_id, friend_id)
        return jsonify({'success': True, 'message': 'Friend removed'})
    except Exception:
        return server_error()
