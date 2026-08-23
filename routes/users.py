from functools import wraps

from flask import Blueprint, jsonify, request, session
from models.user import UserModel

users_bp = Blueprint('users', __name__)

VALID_ROLES = ('user', 'sysadmin')


def require_admin(f):
    """Decorator requiring an authenticated sysadmin."""
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = session.get('user_id')
        if not user_id:
            return jsonify({'error': 'Authentication required'}), 401

        user = UserModel.get_user_by_id(user_id)
        if not user or user['role'] != 'sysadmin':
            return jsonify({'error': 'Administrator privileges required'}), 403

        return f(*args, **kwargs)
    return decorated


def serialize_user(user):
    return {
        'id': user['id'],
        'username': user['username'],
        'email': user['email'],
        'role': user['role'],
        'full_library': bool(user.get('full_library')),
        'created_at': user['created_at'].isoformat() if user.get('created_at') else None,
    }


@users_bp.route('', methods=['GET'])
@require_admin
def list_users():
    """List all user accounts."""
    try:
        users = UserModel.get_all_users()
        return jsonify({'users': [serialize_user(u) for u in users]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@users_bp.route('', methods=['POST'])
@require_admin
def create_user():
    """Create a new user account."""
    try:
        data = request.get_json() or {}

        username = (data.get('username') or '').strip()
        email = (data.get('email') or '').strip().lower()
        password = data.get('password') or ''
        role = (data.get('role') or 'user').strip()
        # 'Full system library' permission — explicit opt-in only. NOT a
        # default for anyone, admins included.
        full_library = bool(data.get('full_library', False))

        if not username or not email or not password:
            return jsonify({'error': 'Username, email and password are required'}), 400

        if len(password) < 6:
            return jsonify({'error': 'Password must be at least 6 characters'}), 400

        if role not in VALID_ROLES:
            return jsonify({'error': f'Invalid role. Must be one of: {", ".join(VALID_ROLES)}'}), 400

        if UserModel.get_user_by_email(email):
            return jsonify({'error': 'A user with this email already exists'}), 409

        user_id = UserModel.create_user(
            username, email, password, role=role, full_library=full_library)
        if not user_id:
            return jsonify({'error': 'Username is already taken'}), 409

        user = UserModel.get_user_by_id(user_id)
        return jsonify({'success': True, 'user': serialize_user(user)}), 201

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@users_bp.route('/<int:user_id>/role', methods=['POST'])
@require_admin
def update_user_role(user_id):
    """Change a user's role."""
    try:
        data = request.get_json() or {}
        role = (data.get('role') or '').strip()

        if role not in VALID_ROLES:
            return jsonify({'error': f'Invalid role. Must be one of: {", ".join(VALID_ROLES)}'}), 400

        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        if target['role'] == 'sysadmin' and role != 'sysadmin' and UserModel.get_sysadmin_count() <= 1:
            return jsonify({'error': 'Cannot demote the last administrator'}), 400

        UserModel.update_role(user_id, role)
        user = UserModel.get_user_by_id(user_id)
        return jsonify({'success': True, 'user': serialize_user(user)})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@users_bp.route('/<int:user_id>/reset-password', methods=['POST'])
@require_admin
def reset_user_password(user_id):
    """Set a new password for a user."""
    try:
        data = request.get_json() or {}
        password = data.get('password') or ''

        if len(password) < 6:
            return jsonify({'error': 'Password must be at least 6 characters'}), 400

        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        UserModel.update_password(user_id, password)
        return jsonify({'success': True, 'message': 'Password updated successfully'})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@users_bp.route('/<int:user_id>/full-library', methods=['POST'])
@require_admin
def update_user_full_library(user_id):
    """Grant/revoke full-system-library visibility for a user."""
    try:
        data = request.get_json() or {}
        flag = bool(data.get('full_library', False))

        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        UserModel.update_full_library(user_id, flag)
        user = UserModel.get_user_by_id(user_id)
        return jsonify({'success': True, 'user': serialize_user(user)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@users_bp.route('/<int:user_id>', methods=['DELETE'])
@require_admin
def delete_user(user_id):
    """Delete a user account."""
    try:
        if user_id == session.get('user_id'):
            return jsonify({'error': 'You cannot delete your own account'}), 400

        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        if target['role'] == 'sysadmin' and UserModel.get_sysadmin_count() <= 1:
            return jsonify({'error': 'Cannot delete the last administrator'}), 400

        # Per-account isolation: drop the user's playlists with the account —
        # otherwise the owner FK (ON DELETE SET NULL) would orphan them into
        # public legacy playlists visible to every account.
        from models.database import Database
        Database.execute_query(
            "DELETE FROM playlists WHERE owner_user_id = %s", (user_id,))

        UserModel.delete_user(user_id)
        return jsonify({'success': True, 'message': 'User deleted successfully'})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Per-account library isolation: publishing ────────────────────────────

@users_bp.route('/library/imports', methods=['GET'])
@require_admin
def library_import_stats():
    """Per-user counts of personal (unpublished) imported songs."""
    try:
        from models.library_access import LibraryAccessModel
        return jsonify({'stats': LibraryAccessModel.import_stats()})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@users_bp.route('/library/publish/<int:song_id>', methods=['POST'])
@require_admin
def publish_song(song_id):
    """Publish a personally-imported song to every account."""
    try:
        from models.library_access import LibraryAccessModel
        from models.song import SongModel

        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        LibraryAccessModel.publish_to_all(song_id)
        return jsonify({
            'success': True,
            'message': f'"{song["title"]}" is now visible to all accounts',
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@users_bp.route('/library/publish-user/<int:user_id>', methods=['POST'])
@require_admin
def publish_user_imports(user_id):
    """Publish ALL personal imports of one user to every account."""
    try:
        from models.library_access import LibraryAccessModel

        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        LibraryAccessModel.publish_all_imported_by(user_id)
        return jsonify({
            'success': True,
            'message': f'All imports by {target["username"]} are now public',
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

