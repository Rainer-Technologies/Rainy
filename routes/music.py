from flask import Blueprint, jsonify, session, send_file, request
from models.settings import SettingsModel
from models.song import SongModel, ScanHistoryModel
from utils.scanner import MusicScanner
import os

music_bp = Blueprint('music', __name__, url_prefix='/api/music')


def require_auth(f):
    """Decorator to require authentication."""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return decorated


@music_bp.route('/library', methods=['GET'])
@require_auth
def get_library():
    """Get all songs in the music library from database."""
    try:
        music_path = SettingsModel.get_music_path()
        
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        # Get songs from database
        songs = SongModel.get_all_songs()
        
        # If database is empty, suggest running a scan
        if not songs:
            return jsonify({
                'success': True,
                'songs': [],
                'total': 0,
                'message': 'Library is empty. Run a scan to populate the library.'
            })
        
        return jsonify({
            'success': True,
            'songs': songs,
            'total': len(songs)
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/scan', methods=['POST'])
@require_auth
def rescan_library():
    """Quick rescan - find new files and update modified ones."""
    try:
        # Check if a scan is already running
        if ScanHistoryModel.is_scan_running():
            return jsonify({'error': 'A scan is already in progress'}), 409
        
        music_path = SettingsModel.get_music_path()
        
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        if not os.path.isdir(music_path):
            return jsonify({'error': 'Music path does not exist'}), 400
        
        scanner = MusicScanner(music_path)
        stats = scanner.scan_to_database(full_scan=False)
        
        return jsonify({
            'success': True,
            'message': 'Quick scan completed successfully',
            'scan_type': 'quick',
            'stats': stats,
            'total': SongModel.get_song_count()
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/scan/full', methods=['POST'])
@require_auth
def full_rescan_library():
    """Full rescan - clear database and rescan everything."""
    try:
        # Check if a scan is already running
        if ScanHistoryModel.is_scan_running():
            return jsonify({'error': 'A scan is already in progress'}), 409
        
        music_path = SettingsModel.get_music_path()
        
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        if not os.path.isdir(music_path):
            return jsonify({'error': 'Music path does not exist'}), 400
        
        scanner = MusicScanner(music_path)
        stats = scanner.scan_to_database(full_scan=True)
        
        return jsonify({
            'success': True,
            'message': 'Full scan completed successfully',
            'scan_type': 'full',
            'stats': stats,
            'total': SongModel.get_song_count()
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/scan/status', methods=['GET'])
@require_auth
def get_scan_status():
    """Get the status of the most recent scan."""
    try:
        latest_scan = ScanHistoryModel.get_latest_scan()
        
        if not latest_scan:
            return jsonify({
                'success': True,
                'message': 'No scans have been performed yet',
                'has_scan': False
            })
        
        return jsonify({
            'success': True,
            'has_scan': True,
            'scan': {
                'id': latest_scan['id'],
                'type': latest_scan['scan_type'],
                'status': latest_scan['status'],
                'files_found': latest_scan['files_found'],
                'files_added': latest_scan['files_added'],
                'files_updated': latest_scan['files_updated'],
                'files_removed': latest_scan['files_removed'],
                'error': latest_scan['error_message'],
                'started_at': latest_scan['started_at'].isoformat() if latest_scan['started_at'] else None,
                'completed_at': latest_scan['completed_at'].isoformat() if latest_scan['completed_at'] else None
            },
            'library_total': SongModel.get_song_count()
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/stream/<path:song_id>', methods=['GET'])
@require_auth
def stream_song(song_id):
    """Stream an audio file."""
    try:
        music_path = SettingsModel.get_music_path()
        
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        # Decode the song_id (it's the relative path from music root)
        from urllib.parse import unquote
        relative_path = unquote(song_id)
        
        # Build full path and validate it's within music directory
        full_path = os.path.normpath(os.path.join(music_path, relative_path))
        
        # Security check: ensure the path is within music directory
        if not full_path.startswith(os.path.normpath(music_path)):
            return jsonify({'error': 'Invalid path'}), 403
        
        if not os.path.isfile(full_path):
            return jsonify({'error': 'File not found'}), 404
        
        # Determine MIME type
        ext = os.path.splitext(full_path)[1].lower()
        mime_types = {
            '.mp3': 'audio/mpeg',
            '.flac': 'audio/flac',
            '.wav': 'audio/wav',
            '.ogg': 'audio/ogg',
            '.m4a': 'audio/mp4',
            '.aac': 'audio/aac',
            '.wma': 'audio/x-ms-wma'
        }
        
        mime_type = mime_types.get(ext, 'audio/mpeg')
        
        return send_file(
            full_path,
            mimetype=mime_type,
            as_attachment=False
        )
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/info/<path:song_id>', methods=['GET'])
@require_auth
def get_song_info(song_id):
    """Get detailed info for a specific song."""
    try:
        from urllib.parse import unquote
        relative_path = unquote(song_id)
        
        # Get song from database
        song = SongModel.get_song_by_path(relative_path)
        
        if song:
            return jsonify({
                'success': True,
                'song': {
                    'id': song['file_path'],
                    'path': song['file_path'],
                    'title': song['title'],
                    'artist': song['artist'],
                    'album': song['album'],
                    'duration': song['duration'],
                    'track': song['track_number'],
                    'year': song['year'],
                    'genre': song['genre']
                }
            })
        
        return jsonify({'error': 'Song not found'}), 404
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500
