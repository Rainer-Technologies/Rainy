from flask import Blueprint, jsonify, request, current_app
from models.audit import AuditModel
from models.database import IntegrityError
from models.library_access import LibraryAccessModel
from models.session import SessionModel
from models.user import UserModel
from routes.auth import client_ip, get_current_user_id, require_sysadmin, server_error

users_bp = Blueprint('users', __name__)

VALID_ROLES = ('user', 'sysadmin')


def _audit(event, target_user_id=None, detail=None):
    AuditModel.record(event, user_id=get_current_user_id(),
                      target_user_id=target_user_id, ip=client_ip(),
                      detail=detail)


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
@require_sysadmin
def list_users():
    """List all user accounts."""
    try:
        users = UserModel.get_all_users()
        return jsonify({'users': [serialize_user(u) for u in users]})
    except Exception:
        return server_error('list users')


@users_bp.route('', methods=['POST'])
@require_sysadmin
def create_user():
    """Create a new user account."""
    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'error': 'Invalid request body'}), 400
        if not all(isinstance(data.get(k) or '', str) for k in ('username', 'email', 'password', 'role')):
            return jsonify({'error': 'Invalid request body'}), 400

        username = (data.get('username') or '').strip()
        email = (data.get('email') or '').strip().lower()
        password = data.get('password') or ''
        role = (data.get('role') or 'user').strip()
        # 'Full system library' permission — explicit opt-in only. NOT a
        # default for anyone, admins included.
        full_library = bool(data.get('full_library', False))

        if not username or not email or not password:
            return jsonify({'error': 'Username, email and password are required'}), 400

        pw_error = UserModel.validate_password(password)
        if pw_error:
            return jsonify({'error': pw_error}), 400

        if len(username) > 100 or len(email) > 255 or '@' not in email:
            return jsonify({'error': 'Invalid username or email'}), 400

        if role not in VALID_ROLES:
            return jsonify({'error': f'Invalid role. Must be one of: {", ".join(VALID_ROLES)}'}), 400

        if UserModel.get_user_by_email(email):
            return jsonify({'error': 'A user with this email already exists'}), 409

        try:
            user_id = UserModel.create_user(
                username, email, password, role=role, full_library=full_library)
        except IntegrityError:
            # Unique constraint on username (or a racing duplicate email).
            return jsonify({'error': 'Username or email is already taken'}), 409
        if not user_id:
            return jsonify({'error': 'Username is already taken'}), 409

        _audit('user_created', target_user_id=user_id,
               detail=f"{username} ({role}{', full library' if full_library else ''})")
        user = UserModel.get_user_by_id(user_id)
        return jsonify({'success': True, 'user': serialize_user(user)}), 201

    except Exception:
        current_app.logger.exception('Create user failed')
        return jsonify({'error': 'Could not create user'}), 500


@users_bp.route('/<int:user_id>/role', methods=['POST'])
@require_sysadmin
def update_user_role(user_id):
    """Change a user's role."""
    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not isinstance(data.get('role') or '', str):
            return jsonify({'error': 'Invalid request body'}), 400
        role = (data.get('role') or '').strip()

        if role not in VALID_ROLES:
            return jsonify({'error': f'Invalid role. Must be one of: {", ".join(VALID_ROLES)}'}), 400

        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        if target['role'] == 'sysadmin' and role != 'sysadmin' and UserModel.get_sysadmin_count() <= 1:
            return jsonify({'error': 'Cannot demote the last administrator'}), 400

        UserModel.update_role(user_id, role)
        # The scanned music-folder library comes with the sysadmin role.
        if target['role'] == 'sysadmin' and role != 'sysadmin':
            LibraryAccessModel.revoke_scan_library(user_id)
        elif role == 'sysadmin':
            LibraryAccessModel.backfill_user(user_id)
        _audit('role_changed', target_user_id=user_id,
               detail=f"{target['role']} -> {role}")
        user = UserModel.get_user_by_id(user_id)
        return jsonify({'success': True, 'user': serialize_user(user)})

    except Exception:
        return server_error('change role')


@users_bp.route('/<int:user_id>/reset-password', methods=['POST'])
@require_sysadmin
def reset_user_password(user_id):
    """Set a new password for a user."""
    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'error': 'Invalid request body'}), 400
        password = data.get('password') or ''

        pw_error = UserModel.validate_password(password)
        if pw_error:
            return jsonify({'error': pw_error}), 400

        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        UserModel.update_password(user_id, password)
        SessionModel.revoke_all_for_user(user_id)
        _audit('password_reset_by_admin', target_user_id=user_id)
        return jsonify({'success': True, 'message': 'Password updated successfully'})

    except Exception:
        return server_error('reset password')


@users_bp.route('/<int:user_id>/full-library', methods=['POST'])
@require_sysadmin
def update_user_full_library(user_id):
    """Grant/revoke full-system-library visibility for a user."""
    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'error': 'Invalid request body'}), 400
        flag = bool(data.get('full_library', False))

        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        UserModel.update_full_library(user_id, flag)
        _audit('full_library_changed', target_user_id=user_id,
               detail='granted' if flag else 'revoked')
        user = UserModel.get_user_by_id(user_id)
        return jsonify({'success': True, 'user': serialize_user(user)})
    except Exception:
        return server_error('update library permission')


@users_bp.route('/<int:user_id>', methods=['DELETE'])
@require_sysadmin
def delete_user(user_id):
    """Delete a user account."""
    try:
        if user_id == get_current_user_id():
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
        _audit('user_deleted', target_user_id=user_id, detail=target['username'])
        return jsonify({'success': True, 'message': 'User deleted successfully'})

    except Exception:
        return server_error('delete user')


# ── Per-account library isolation: publishing ────────────────────────────

@users_bp.route('/library/imports', methods=['GET'])
@require_sysadmin
def library_import_stats():
    """Per-user counts of personal (unpublished) imported songs."""
    try:
        return jsonify({'stats': LibraryAccessModel.import_stats()})
    except Exception:
        return server_error('load import stats')


@users_bp.route('/library/publish/<int:song_id>', methods=['POST'])
@require_sysadmin
def publish_song(song_id):
    """Publish a personally-imported song to every account."""
    try:
        from models.song import SongModel

        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        LibraryAccessModel.publish_to_all(song_id)
        _audit('song_published', detail=f'{song_id}: {song["title"]}')
        return jsonify({
            'success': True,
            'message': f'"{song["title"]}" is now visible to all accounts',
        })
    except Exception:
        return server_error('publish song')


@users_bp.route('/library/publish-user/<int:user_id>', methods=['POST'])
@require_sysadmin
def publish_user_imports(user_id):
    """Publish ALL personal imports of one user to every account."""
    try:
        target = UserModel.get_user_by_id(user_id)
        if not target:
            return jsonify({'error': 'User not found'}), 404

        LibraryAccessModel.publish_all_imported_by(user_id)
        _audit('user_imports_published', target_user_id=user_id)
        return jsonify({
            'success': True,
            'message': f'All imports by {target["username"]} are now public',
        })
    except Exception:
        return server_error('publish imports')

