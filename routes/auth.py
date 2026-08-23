from flask import Blueprint, request, jsonify, session
from models.user import UserModel

auth_bp = Blueprint('auth', __name__, url_prefix='/api/auth')

@auth_bp.route('/login', methods=['POST'])
def login():
    """Authenticate user and create session."""
    try:
        data = request.get_json()
        
        email = data.get('email', '').strip().lower()
        password = data.get('password', '')
        
        if not email or not password:
            return jsonify({'error': 'Email and password are required'}), 400
        
        user = UserModel.verify_password(email, password)
        
        if not user:
            return jsonify({'error': 'Invalid email or password'}), 401
        
        # Create session
        session['user_id'] = user['id']
        
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
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@auth_bp.route('/logout', methods=['POST'])
def logout():
    """Clear user session."""
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out successfully'})

@auth_bp.route('/me', methods=['GET'])
def get_current_user():
    """Get currently authenticated user."""
    user_id = session.get('user_id')
    
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

@auth_bp.route('/change-password', methods=['POST'])
def change_password():
    """Change user password."""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    
    try:
        data = request.get_json()
        current_password = data.get('current_password', '')
        new_password = data.get('new_password', '')
        
        if not current_password or not new_password:
            return jsonify({'error': 'Current and new password are required'}), 400
            
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
        
        return jsonify({'success': True, 'message': 'Password updated successfully'})
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@auth_bp.route('/preferences', methods=['POST'])
def update_preferences():
    """Update user preferences."""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
        
    try:
        data = request.get_json()
        preferences = data.get('preferences')
        
        # preferences should be a JSON string or dict? 
        # The DB column is TEXT. If frontend sends a dict, we should probably json.dumps it if we want to store as string, 
        # or rely on the DB driver.
        # But wait, if I store it as TEXT, I should serialize it.
        import json
        if isinstance(preferences, (dict, list)):
            preferences = json.dumps(preferences)
            
        user_id = session['user_id']
        UserModel.update_preferences(user_id, preferences)
        
        return jsonify({'success': True, 'message': 'Preferences updated'})
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def get_current_user_id():
    """Helper to get current user ID from session or request parameters/headers."""
    if 'user_id' in session:
        return session['user_id']
    
    # Check if session cookie string or session token was passed as query param or header
    sess_token = request.args.get('session') or request.headers.get('X-Session-Token')
    if not sess_token:
        # Check raw Cookie header if session wasn't auto-loaded by Flask
        cookie_header = request.headers.get('Cookie')
        if cookie_header:
            import re
            m = re.search(r'session=([^;,]+)', cookie_header)
            if m:
                sess_token = m.group(1)

    if sess_token:
        try:
            if 'session=' in sess_token:
                import re
                m = re.search(r'session=([^;,]+)', sess_token)
                if m:
                    sess_token = m.group(1)
            from flask import current_app
            from flask.sessions import SecureCookieSessionInterface
            serializer = SecureCookieSessionInterface().get_signing_serializer(current_app)
            session_data = serializer.loads(sess_token)
            if session_data and 'user_id' in session_data:
                session['user_id'] = session_data['user_id']
                return session_data['user_id']
        except Exception as e:
            print("Session token parse error:", e)
    return None


def require_auth(f):
    """Decorator to require authentication."""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return decorated


def require_sysadmin(f):
    """Decorator requiring an authenticated sysadmin (role == 'sysadmin')."""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        user = UserModel.get_user_by_id(user_id)
        if not user or user['role'] != 'sysadmin':
            return jsonify({'error': 'Forbidden'}), 403
        return f(*args, **kwargs)
    return decorated


