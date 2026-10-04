from flask import Blueprint, request, jsonify, session
from models.user import UserModel
from routes.auth import server_error

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
    except Exception:
        return server_error()

@setup_bp.route('/complete', methods=['POST'])
def complete_setup():
    """Complete first-time setup with admin user and music path."""
    try:
        # Check if setup is already complete
        if not UserModel.is_first_run():
            return jsonify({'error': 'Setup already completed'}), 400
        
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'error': 'Invalid request body'}), 400

        # Validate required fields
        required_fields = ['username', 'email', 'password', 'music_path']
        for field in required_fields:
            if not data.get(field):
                return jsonify({'error': f'Missing required field: {field}'}), 400
            if not isinstance(data[field], str):
                return jsonify({'error': f'Invalid field: {field}'}), 400

        username = data['username'].strip()
        email = data['email'].strip().lower()
        password = data['password']
        music_path = data['music_path'].strip()
        
        # Validate password length
        pw_error = UserModel.validate_password(password)
        if pw_error:
            return jsonify({'error': pw_error}), 400
        
        # Validate music path exists
        import os
        if not os.path.isdir(music_path):
            return jsonify({'error': 'Music path does not exist or is not a directory'}), 400
        
        # Create admin user, in the language picked on the setup screen
        language = UserModel.normalize_language(data.get('language'))
        user_id = UserModel.create_user(username, email, password, role='sysadmin',
                                        language=language)
        
        # Remember the "No Anime" choice made on the setup form
        if data.get('no_anime') is True:
            import json
            UserModel.update_preferences(user_id, json.dumps({'no_anime': True}))

        # Save music path setting
        from models.settings import SettingsModel
        SettingsModel.set_music_path(music_path)
        
        # Log the user in
        from routes.auth import start_session
        start_session(user_id)
        
        return jsonify({
            'success': True,
            'message': 'Setup completed successfully',
            'user': {
                'id': user_id,
                'username': username,
                'email': email,
                'role': 'sysadmin',
                'language': language
            }
        })

    except Exception:
        from flask import current_app
        current_app.logger.exception('Setup failed')
        return jsonify({'error': 'Setup failed'}), 500
