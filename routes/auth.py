from functools import wraps

from flask import Blueprint, request, jsonify, session, current_app, g
from models.audit import AuditModel
from models.session import SessionModel
from models.user import UserModel
from utils import media_token, ratelimit

auth_bp = Blueprint('auth', __name__, url_prefix='/api/auth')

MAX_PREFERENCES_BYTES = 64 * 1024

# Failed-login throttling (per worker process; see utils/ratelimit.py).
LOGIN_WINDOW = 15 * 60
LOGIN_EMAIL_LIMIT = 8
LOGIN_IP_LIMIT = 50


def client_ip():
    return request.remote_addr or ''


def server_error(action=None):
    """500 response for an exception caught in a route: logged with its
    traceback, but its text (SQL, paths) never reaches the client."""
    current_app.logger.exception('%s %s failed', request.method, request.path)
    return jsonify({'error': f'Could not {action}' if action else 'Internal server error'}), 500


def session_lifetime_seconds():
    return int(current_app.config['PERMANENT_SESSION_LIFETIME'].total_seconds())


def start_session(user_id):
    """Begin a fresh server-side session for user_id (rotates any old one)."""
    old = session.get('sid')
    if old:
        SessionModel.revoke(old)
    session.clear()
    token = SessionModel.create(
        user_id, session_lifetime_seconds(),
        user_agent=request.headers.get('User-Agent'), ip=client_ip())
    # Permanent so the cookie survives browser/app restarts (matches the
    # SESSION_LIFETIME_DAYS config in app.py).
    session.permanent = True
    session['user_id'] = user_id
    session['sid'] = token


def validate_session():
    """Drop the cookie session if its server-side record is gone/revoked/expired.

    Returns the user_id of a live session, else None.
    """
    user_id = session.get('user_id')
    if user_id is None:
        return None
    if SessionModel.validate(session.get('sid'), session_lifetime_seconds()) == user_id:
        return user_id
    session.clear()
    return None

@auth_bp.route('/login', methods=['POST'])
def login():
    """Authenticate user and create session."""
    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'error': 'Invalid request body'}), 400

        email = data.get('email', '')
        password = data.get('password', '')
        if not isinstance(email, str) or not isinstance(password, str):
            return jsonify({'error': 'Invalid request body'}), 400
        email = email.strip().lower()

        if not email or not password:
            return jsonify({'error': 'Email and password are required'}), 400
        if len(email) > 255 or len(password.encode('utf-8')) > 1024:
            return jsonify({'error': 'Invalid email or password'}), 401

        ip = client_ip()
        email_key = f'login:email:{email}'
        ip_key = f'login:ip:{ip}'
        if (ratelimit.peek_blocked(email_key, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW)
                or ratelimit.peek_blocked(ip_key, LOGIN_IP_LIMIT, LOGIN_WINDOW)):
            AuditModel.record('login_throttled', ip=ip, detail=email[:200])
            resp = jsonify({'error': 'Too many failed attempts. Try again later.'})
            resp.headers['Retry-After'] = str(LOGIN_WINDOW)
            return resp, 429

        user = UserModel.verify_password(email, password)

        if not user:
            # Only failures count toward the limits.
            ratelimit.check(email_key, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW)
            ratelimit.check(ip_key, LOGIN_IP_LIMIT, LOGIN_WINDOW)
            AuditModel.record('login_failed', ip=ip, detail=email[:200])
            return jsonify({'error': 'Invalid email or password'}), 401

        ratelimit.reset(email_key)
        start_session(user['id'])
        AuditModel.record('login', user_id=user['id'], ip=ip)

        return jsonify({
            'success': True,
            'user': {
                'id': user['id'],
                'username': user['username'],
                'email': user['email'],
                'role': user['role'],
                'full_library': bool(user.get('full_library'))
            }
        })

    except Exception:
        current_app.logger.exception('Login failed')
        return jsonify({'error': 'Login failed'}), 500

@auth_bp.route('/logout', methods=['POST'])
def logout():
    """Revoke and clear the user session."""
    user_id = session.get('user_id')
    SessionModel.revoke(session.get('sid'))
    if user_id:
        AuditModel.record('logout', user_id=user_id, ip=client_ip())
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out successfully'})

@auth_bp.route('/me', methods=['GET'])
def get_current_user():
    """Get currently authenticated user."""
    user_id = validate_session()
    
    if not user_id:
        return jsonify({'authenticated': False}), 401
    
    user = UserModel.get_user_by_id(user_id)
    
    if not user:
        session.clear()
        return jsonify({'authenticated': False}), 401
    
    return jsonify({
        'authenticated': True,
        'user': {
            'id': user['id'],
            'username': user['username'],
            'email': user['email'],
            'role': user['role'],
            'full_library': bool(user.get('full_library')),
            'preferences': user.get('preferences')
        }
    })

@auth_bp.route('/media-token', methods=['GET'])
def get_media_token():
    """Issue a media-only token for clients that embed auth in stream/cover
    URLs (mobile app, Android Auto, notification artwork). Use as ``?mt=``."""
    user_id = validate_session()
    if user_id is None:
        return jsonify({'error': 'Authentication required'}), 401
    return jsonify({
        'token': media_token.issue(user_id),
        'expires_in': media_token.MEDIA_TOKEN_TTL,
    })


@auth_bp.route('/change-password', methods=['POST'])
def change_password():
    """Change user password."""
    if validate_session() is None:
        return jsonify({'error': 'Authentication required'}), 401

    allowed, retry = ratelimit.check(f'pwchange:{session["user_id"]}', 5, 15 * 60)
    if not allowed:
        resp = jsonify({'error': 'Too many attempts. Try again later.'})
        resp.headers['Retry-After'] = str(retry)
        return resp, 429

    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'error': 'Invalid request body'}), 400
        current_password = data.get('current_password', '')
        new_password = data.get('new_password', '')

        if not current_password or not new_password:
            return jsonify({'error': 'Current and new password are required'}), 400
        if not isinstance(current_password, str):
            return jsonify({'error': 'Invalid request body'}), 400
        pw_error = UserModel.validate_password(new_password)
        if pw_error:
            return jsonify({'error': pw_error}), 400

        user_id = session['user_id']
        user = UserModel.get_user_by_id(user_id)
        
        if not user:
            return jsonify({'error': 'User not found'}), 404
            
        # Verify current password
        verified_user = UserModel.verify_password(user['email'], current_password)
        if not verified_user:
            return jsonify({'error': 'Incorrect current password'}), 401
            
        # Update password
        UserModel.update_password(user_id, new_password)
        # Sign out every other device; keep this one.
        SessionModel.revoke_all_for_user(user_id, except_token=session.get('sid'))
        AuditModel.record('password_changed', user_id=user_id, ip=client_ip())

        return jsonify({'success': True, 'message': 'Password updated successfully'})

    except Exception:
        current_app.logger.exception('Password change failed')
        return jsonify({'error': 'Could not update password'}), 500

@auth_bp.route('/preferences', methods=['POST'])
def update_preferences():
    """Update user preferences."""
    if validate_session() is None:
        return jsonify({'error': 'Authentication required'}), 401
        
    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'error': 'Invalid request body'}), 400
        preferences = data.get('preferences')

        # Stored as a JSON object in a TEXT column; cap the size so an
        # account can't park arbitrary data on the server.
        import json
        if not isinstance(preferences, dict):
            return jsonify({'error': 'Preferences must be an object'}), 400
        preferences = json.dumps(preferences)
        if len(preferences) > MAX_PREFERENCES_BYTES:
            return jsonify({'error': 'Preferences are too large'}), 413

        user_id = session['user_id']
        UserModel.update_preferences(user_id, preferences)
        
        return jsonify({'success': True, 'message': 'Preferences updated'})

    except Exception:
        current_app.logger.exception('Preferences update failed')
        return jsonify({'error': 'Could not update preferences'}), 500

def get_current_user_id():
    """Authenticated user id for this request, or None.

    Cookie sessions are checked against the server-side session table.
    Media endpoints (stream/cover) additionally accept a short-lived signed
    ``?mt=`` token for devices that can't send cookies (Chromecast).
    """
    user_id = validate_session()
    if user_id is not None:
        return user_id

    if request.endpoint in media_token.MEDIA_ENDPOINTS:
        token_user = media_token.verify(request.args.get('mt'))
        if token_user is not None:
            g.media_token_user = token_user
            return token_user
    return None


def current_user():
    """The authenticated user's row for this request, or None.

    Looked up once per request (cached on ``g``) so the auth decorators and
    the route body don't each re-query the users table.
    """
    if 'current_user' not in g:
        user_id = get_current_user_id()
        g.current_user = (UserModel.get_user_by_id(user_id)
                          if user_id is not None else None)
    return g.current_user


def is_sysadmin():
    user = current_user()
    return bool(user and user['role'] == 'sysadmin')


def require_auth(f):
    """Decorator to require authentication."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if get_current_user_id() is None:
            return jsonify({'error': 'Authentication required'}), 401
        # A deleted account's still-signed cookie must stop working.
        if not current_user():
            session.clear()
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return decorated


def require_sysadmin(f):
    """Decorator requiring an authenticated sysadmin (role == 'sysadmin')."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if get_current_user_id() is None:
            return jsonify({'error': 'Authentication required'}), 401
        if not is_sysadmin():
            return jsonify({'error': 'Administrator privileges required'}), 403
        return f(*args, **kwargs)
    return decorated


def require_song_access(f):
    """For routes taking a ``song_id``: 404 unless the caller can see it.

    Same response as a missing song, so other accounts' song ids don't leak.
    Stack it under ``require_auth``.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        from models.library_access import LibraryAccessModel
        if not LibraryAccessModel.has_access(get_current_user_id(), kwargs['song_id']):
            return jsonify({'error': 'Song not found'}), 404
        return f(*args, **kwargs)
    return decorated


