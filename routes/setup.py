from flask import Blueprint, request, jsonify, session
from models.user import UserModel

setup_bp = Blueprint('setup', __name__, url_prefix='/api/setup')

@setup_bp.route('/status', methods=['GET'])
def get_setup_status():
    """Check if first-time setup is needed."""
    try:
        needs_setup = UserModel.is_first_run()
        return jsonify({
            'needs_setup': needs_setup,
            'message': 'Setup required' if needs_setup else 'Setup complete'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@setup_bp.route('/complete', methods=['POST'])
def complete_setup():
    """Complete first-time setup with admin user and music path."""
    try:
        # Check if setup is already complete
        if not UserModel.is_first_run():
            return jsonify({'error': 'Setup already completed'}), 400
        
        data = request.get_json()
        
        # Validate required fields
        required_fields = ['username', 'email', 'password', 'music_path']
        for field in required_fields:
            if not data.get(field):
                return jsonify({'error': f'Missing required field: {field}'}), 400
        
        username = data['username'].strip()
        email = data['email'].strip().lower()
        password = data['password']
        music_path = data['music_path'].strip()
        
        # Validate password length
        if len(password) < 6:
            return jsonify({'error': 'Password must be at least 6 characters'}), 400
        
        # Validate music path exists
        import os
        if not os.path.isdir(music_path):
            return jsonify({'error': 'Music path does not exist or is not a directory'}), 400
        
        # Create admin user
        user_id = UserModel.create_user(username, email, password, role='sysadmin')
        
        # Save music path setting
        from models.settings import SettingsModel
        SettingsModel.set_music_path(music_path)
        
        # Log the user in
        session['user_id'] = user_id
        
        return jsonify({
            'success': True,
            'message': 'Setup completed successfully',
            'user': {
                'id': user_id,
                'username': username,
                'email': email,
                'role': 'sysadmin'
            }
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500
