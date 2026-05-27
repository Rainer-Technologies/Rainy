from flask import Blueprint, request, jsonify, session
from functools import wraps
from models.song_rating import SongRatingModel
from models.playlist import PlaylistModel


def get_current_user_id():
    """Helper to get current user ID from session."""
    return session.get('user_id')


def login_required(f):
    """Decorator to require authentication."""
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user_id, *args, **kwargs)
    return decorated


ratings_bp = Blueprint('ratings', __name__, url_prefix='/api/ratings')


@ratings_bp.route('', methods=['POST'])
@login_required
def set_rating(user_id):
    """Set or update a rating for a song."""
    data = request.get_json()
    
    if not data or 'song_id' not in data:
        return jsonify({'error': 'song_id is required'}), 400
    
    song_id = data['song_id']
    rating = data.get('rating')  # 'like', 'dislike', or null to remove
    
    print(f"DEBUG set_rating: user_id={user_id}, song_id={song_id}, rating={rating}")
    
    if rating is None:
        SongRatingModel.remove_rating(user_id, song_id)
        return jsonify({'success': True, 'action': 'removed'})
    
    if rating not in ('like', 'dislike'):
        return jsonify({'error': 'rating must be "like" or "dislike"'}), 400
    
    SongRatingModel.set_rating(user_id, song_id, rating)
    
    return jsonify({
        'success': True,
        'action': 'set',
        'rating': rating,
        'song_id': song_id
    })


@ratings_bp.route('/<int:song_id>', methods=['DELETE'])
@login_required
def remove_rating(user_id, song_id):
    """Remove a rating for a song."""
    SongRatingModel.remove_rating(user_id, song_id)
    return jsonify({'success': True, 'action': 'removed'})


@ratings_bp.route('/liked', methods=['GET'])
@login_required
def get_liked_songs(user_id):
    """Get all songs the user has liked with timestamps."""
    limit = request.args.get('limit', type=int, default=100)
    offset = request.args.get('offset', type=int, default=0)
    
    ratings = SongRatingModel.get_user_ratings(user_id, 'like', limit, offset)
    
    songs = []
    for row in ratings:
        songs.append({
            'id': row['song_id'],
            'rating': row['rating'],
            'liked_at': row['created_at'].isoformat() if row['created_at'] else None,
            'title': row['title'],
            'artist': row['artist'],
            'album': row['album'],
            'duration': row['duration'],
            'cover_path': row['cover_path']
        })
    
    return jsonify({'songs': songs})


@ratings_bp.route('/disliked', methods=['GET'])
@login_required
def get_disliked_songs(user_id):
    """Get all songs the user has disliked with timestamps."""
    limit = request.args.get('limit', type=int, default=100)
    offset = request.args.get('offset', type=int, default=0)
    
    ratings = SongRatingModel.get_user_ratings(user_id, 'dislike', limit, offset)
    
    songs = []
    for row in ratings:
        songs.append({
            'id': row['song_id'],
            'rating': row['rating'],
            'disliked_at': row['created_at'].isoformat() if row['created_at'] else None,
            'title': row['title'],
            'artist': row['artist'],
            'album': row['album'],
            'duration': row['duration'],
            'cover_path': row['cover_path']
        })
    
    return jsonify({'songs': songs})


@ratings_bp.route('/batch', methods=['POST'])
@login_required
def get_ratings_for_songs(user_id):
    """Get ratings for a list of songs."""
    data = request.get_json()
    
    if not data or 'song_ids' not in data:
        return jsonify({'error': 'song_ids is required'}), 400
    
    song_ids = data['song_ids']
    if not isinstance(song_ids, list):
        return jsonify({'error': 'song_ids must be an array'}), 400
    
    # Limit batch size to prevent abuse
    if len(song_ids) > 500:
        return jsonify({'error': 'Maximum 500 songs per batch request'}), 400
    
    ratings = SongRatingModel.get_ratings_for_songs(user_id, song_ids)
    
    # Format response: {song_id: {rating, created_at}, ...}
    result = {}
    for song_id, rating_data in ratings.items():
        result[str(song_id)] = {
            'rating': rating_data['rating'],
            'created_at': rating_data['created_at'].isoformat() if rating_data['created_at'] else None
        }
    
    return jsonify({'ratings': result})


@ratings_bp.route('/migration', methods=['POST'])
@login_required
def migrate_likes(user_id):
    """
    Migrate likes from Liked Music playlist to song_ratings table.
    Called once on first load for existing users.
    """
    # Find the user's Liked Music playlist
    playlists = PlaylistModel.get_all_playlists_for_user(user_id)
    liked_playlist = None
    for p in playlists:
        if p['name'].lower() == 'liked music':
            liked_playlist = p
            break
    
    if not liked_playlist:
        return jsonify({'success': True, 'migrated': 0, 'message': 'No Liked Music playlist found'})
    
    migrated = SongRatingModel.migrate_from_playlist(user_id, liked_playlist['id'])
    
    return jsonify({
        'success': True,
        'migrated': migrated,
        'playlist_id': liked_playlist['id']
    })


@ratings_bp.route('/ids/liked', methods=['GET'])
@login_required
def get_liked_ids(user_id):
    """Get just the list of liked song IDs (for quick player state loading)."""
    song_ids = SongRatingModel.get_liked_song_ids(user_id)
    return jsonify({'song_ids': song_ids})


@ratings_bp.route('/ids/disliked', methods=['GET'])
@login_required
def get_disliked_ids(user_id):
    """Get just the list of disliked song IDs (for quick player state loading)."""
    song_ids = SongRatingModel.get_disliked_song_ids(user_id)
    return jsonify({'song_ids': song_ids})


@ratings_bp.route('/cleanup', methods=['POST'])
@login_required
def cleanup_duplicates(user_id):
    """
    Remove duplicate entries from Liked Music playlist and sync ratings.
    Called to fix existing duplicates in the database.
    """
    # Find the user's Liked Music playlist
    playlists = PlaylistModel.get_all_playlists_for_user(user_id)
    liked_playlist = None
    for p in playlists:
        if p['name'].lower() == 'liked music':
            liked_playlist = p
            break
    
    if not liked_playlist:
        return jsonify({'success': True, 'message': 'No Liked Music playlist found', 'removed': 0})
    
    # Remove duplicates from playlist
    removed = PlaylistModel.remove_duplicate_entries(liked_playlist['id'])
    
    # Also ensure ratings table is in sync with playlist
    # Get all songs in playlist
    playlist_songs = PlaylistModel.get_playlist_songs(liked_playlist['id'])
    playlist_song_ids = {song['id'] for song in playlist_songs}
    
    # Get all liked song IDs from ratings table
    liked_rating_ids = set(SongRatingModel.get_liked_song_ids(user_id))
    
    # Find songs in playlist but not in ratings
    missing_from_ratings = playlist_song_ids - liked_rating_ids
    
    # Add missing songs to ratings table
    for song_id in missing_from_ratings:
        SongRatingModel.set_rating(user_id, song_id, 'like')
    
    return jsonify({
        'success': True,
        'message': f'Removed {removed} duplicate entries',
        'removed': removed,
        'synced': len(missing_from_ratings)
    })
