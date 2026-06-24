from flask import Blueprint, jsonify, request, session
from models.playlist import PlaylistModel
from routes.auth import require_auth

playlists_bp = Blueprint('playlists', __name__)

@playlists_bp.route('/', methods=['GET'])
@require_auth
def get_playlists():
    """Get all playlists."""
    user_id = session.get('user_id')
    playlists = PlaylistModel.get_all_playlists_for_user(user_id)
    return jsonify(playlists or [])

@playlists_bp.route('/', methods=['POST'])
@require_auth
def create_playlist():
    """Create a new playlist."""
    data = request.get_json()
    if not data or 'name' not in data:
        return jsonify({'error': 'Name is required'}), 400
    
    icon = data.get('icon', 'music-note')
    icon_color = data.get('icon_color', '#888888')
    private = bool(data.get('private', False))
    owner_user_id = session.get('user_id') if private else None
    
    try:
        playlist_id = PlaylistModel.create_playlist(data['name'], icon, icon_color, owner_user_id)
        return jsonify({
            'success': True, 
            'id': playlist_id,
            'name': data['name'],
            'icon': icon,
            'icon_color': icon_color,
            'owner_user_id': owner_user_id
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@playlists_bp.route('/<int:playlist_id>', methods=['GET'])
@require_auth
def get_playlist(playlist_id):
    """Get playlist details and songs."""
    playlist = PlaylistModel.get_playlist_by_id(playlist_id)
    if not playlist:
        return jsonify({'error': 'Playlist not found'}), 404
    
    # Ownership check: if private, only owner can access
    if playlist.get('owner_user_id') is not None and playlist.get('owner_user_id') != session.get('user_id'):
        return jsonify({'error': 'Forbidden'}), 403
        
    raw_songs = PlaylistModel.get_playlist_songs(playlist_id)
    
    # Transform songs to match expected frontend format (same as SongModel)
    songs = []
    for row in (raw_songs or []):
        songs.append({
            'id': row['id'],
            'path': row['file_path'],
            'title': row['title'],
            'artist': row['artist'],
            'album': row['album'],
            'duration': row['duration'],
            'track': row['track_number'],
            'year': row['year'],
            'genre': row['genre'],
            'cover_path': row['cover_path']
        })
    
    return jsonify({
        'id': playlist['id'],
        'name': playlist['name'],
        'icon': playlist.get('icon', 'music-note'),
        'icon_color': playlist.get('icon_color', '#fa586a'),
        'created_at': playlist['created_at'],
        'songs': songs
    })

@playlists_bp.route('/<int:playlist_id>', methods=['DELETE'])
@require_auth
def delete_playlist(playlist_id):
    """Delete a playlist."""
    try:
        PlaylistModel.delete_playlist(playlist_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@playlists_bp.route('/<int:playlist_id>', methods=['PUT'])
@require_auth
def update_playlist(playlist_id):
    """Update a playlist (name, icon, color)."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
        
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        # Ownership check: only owner can modify private playlist
        if playlist.get('owner_user_id') is not None and playlist.get('owner_user_id') != session.get('user_id'):
            return jsonify({'error': 'Forbidden'}), 403
        
        # Update name if provided
        if 'name' in data:
            PlaylistModel.update_playlist_name(playlist_id, data['name'])
        
        # Update appearance if provided
        if 'icon' in data or 'icon_color' in data:
            icon = data.get('icon', playlist.get('icon', 'music-note'))
            icon_color = data.get('icon_color', playlist.get('icon_color', '#fa586a'))
            PlaylistModel.update_playlist_appearance(playlist_id, icon, icon_color)
        
        # Update privacy if provided
        if 'private' in data:
            owner_user_id = session.get('user_id') if bool(data.get('private')) else None
            PlaylistModel.update_playlist_privacy(playlist_id, owner_user_id)
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@playlists_bp.route('/<int:playlist_id>/songs', methods=['POST'])
@require_auth
def add_song(playlist_id):
    """Add a song to a playlist."""
    data = request_get_json = request.get_json()
    if not data or 'song_id' not in data:
        return jsonify({'error': 'Song ID is required'}), 400
        
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        if playlist.get('owner_user_id') is not None and playlist.get('owner_user_id') != session.get('user_id'):
            return jsonify({'error': 'Forbidden'}), 403
        PlaylistModel.add_song_to_playlist(playlist_id, data['song_id'])
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@playlists_bp.route('/<int:playlist_id>/songs/<int:song_id>', methods=['DELETE'])
@require_auth
def remove_song(playlist_id, song_id):
    """Remove a song from a playlist."""
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        if playlist.get('owner_user_id') is not None and playlist.get('owner_user_id') != session.get('user_id'):
            return jsonify({'error': 'Forbidden'}), 403
        PlaylistModel.remove_song_from_playlist(playlist_id, song_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/download', methods=['GET'])
@require_auth
def download_playlist(playlist_id):
    """Download all songs in a playlist as a zip file."""
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        
        # Ownership check: if private, only owner can access
        if playlist.get('owner_user_id') is not None and playlist.get('owner_user_id') != session.get('user_id'):
            return jsonify({'error': 'Forbidden'}), 403
            
        songs = PlaylistModel.get_playlist_songs(playlist_id)
        if not songs:
            return jsonify({'error': 'Playlist is empty'}), 400
            
        from models.settings import SettingsModel
        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
            
        import io
        import zipfile
        import os
        import re
        from flask import send_file
        
        memory_file = io.BytesIO()
        with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            for song in songs:
                relative_path = song['file_path']
                full_path = os.path.normpath(os.path.join(music_path, relative_path))
                if full_path.startswith(os.path.normpath(music_path)) and os.path.isfile(full_path):
                    filename = os.path.basename(full_path)
                    zf.write(full_path, arcname=filename)
                    
        memory_file.seek(0)
        playlist_name = playlist['name']
        safe_name = re.sub(r'[^a-zA-Z0-9_\- ]', '', playlist_name)
        if not safe_name:
            safe_name = f"playlist_{playlist_id}"
        zip_filename = f"{safe_name}.zip"
        
        return send_file(
            memory_file,
            mimetype='application/zip',
            as_attachment=True,
            download_name=zip_filename
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
