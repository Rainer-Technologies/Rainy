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
                'role': user['role']
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
            'role': user['role']
        }
    })

def require_auth(f):
    """Decorator to require authentication."""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return decorated
