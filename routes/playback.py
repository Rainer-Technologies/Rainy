from flask import Blueprint, request, jsonify, session
from functools import wraps
from models.playback_history import PlaybackHistoryModel

playback_bp = Blueprint('playback', __name__, url_prefix='/api/playback')


from routes.auth import get_current_user_id


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user_id, *args, **kwargs)
    return decorated



@playback_bp.route('/history', methods=['POST'])
@login_required
def record_play(user_id):
    """Record a song play event."""
    data = request.get_json()
    if not data or 'song_id' not in data:
        return jsonify({'error': 'song_id is required'}), 400

    PlaybackHistoryModel.record_play(
        user_id,
        data['song_id'],
        data.get('position', 0),
        data.get('duration', 0)
    )
    return jsonify({'success': True})


@playback_bp.route('/history', methods=['GET'])
@login_required
def get_recently_played(user_id):
    """Get recently played songs."""
    limit = request.args.get('limit', type=int, default=50)
    offset = request.args.get('offset', type=int, default=0)
    songs = PlaybackHistoryModel.get_recently_played(user_id, limit, offset)
    return jsonify({'songs': songs})


@playback_bp.route('/history/top', methods=['GET'])
@login_required
def get_top_songs(user_id):
    """Get most played songs."""
    limit = request.args.get('limit', type=int, default=50)
    songs = PlaybackHistoryModel.get_play_counts(user_id, limit)
    return jsonify({'songs': songs})


@playback_bp.route('/history/artists', methods=['GET'])
@login_required
def get_top_artists(user_id):
    """Get most listened artists."""
    limit = request.args.get('limit', type=int, default=20)
    artists = PlaybackHistoryModel.get_top_artists(user_id, limit)
    return jsonify({'artists': artists})


@playback_bp.route('/history/genres', methods=['GET'])
@login_required
def get_top_genres(user_id):
    """Get most listened genres."""
    limit = request.args.get('limit', type=int, default=10)
    genres = PlaybackHistoryModel.get_top_genres(user_id, limit)
    return jsonify({'genres': genres})


@playback_bp.route('/stats', methods=['GET'])
@login_required
def get_stats(user_id):
    """Get aggregate listening statistics."""
    stats = PlaybackHistoryModel.get_listening_stats(user_id)
    return jsonify({'stats': stats})


@playback_bp.route('/history', methods=['DELETE'])
@login_required
def clear_history(user_id):
    """Clear all play history."""
    PlaybackHistoryModel.clear_history(user_id)
    return jsonify({'success': True})


# --- Cross-device playback state ---

from models.playback_state import PlaybackStateModel


@playback_bp.route('/state', methods=['POST'])
@login_required
def save_state(user_id):
    """Save playback state for cross-device sync."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    PlaybackStateModel.save_state(
        user_id,
        data.get('song_id'),
        data.get('position', 0),
        data.get('queue', []),
        data.get('queue_index', 0),
        data.get('is_playing', False)
    )
    return jsonify({'success': True})


@playback_bp.route('/state', methods=['GET'])
@login_required
def get_state(user_id):
    """Get saved playback state."""
    state = PlaybackStateModel.get_state(user_id)
    return jsonify({'state': state})


@playback_bp.route('/state', methods=['DELETE'])
@login_required
def clear_state(user_id):
    """Clear saved playback state."""
    PlaybackStateModel.clear_state(user_id)
    return jsonify({'success': True})
