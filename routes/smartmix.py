"""Smart mix / auto-mix / radio mode endpoint."""
from flask import Blueprint, request, jsonify, session
from functools import wraps
from models.database import Database
from models.song_rating import SongRatingModel

smartmix_bp = Blueprint('smartmix', __name__, url_prefix='/api/smartmix')


from routes.auth import get_current_user_id


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user_id, *args, **kwargs)
    return decorated



@smartmix_bp.route('/generate', methods=['POST'])
@login_required
def generate_mix(user_id):
    """Generate a smart mix queue based on user preferences.
    
    Body params:
        seed_song_id: optional song ID to base the mix on
        mode: 'radio' (similar to seed), 'liked' (from liked songs), 'discovery' (unplayed)
        limit: max songs (default 30)
    """
    data = request.get_json() or {}
    seed_song_id = data.get('seed_song_id')
    mode = data.get('mode', 'radio')
    limit = min(data.get('limit', 30), 100)

    disliked_ids = set(SongRatingModel.get_disliked_song_ids(user_id))
    disliked_filter = ""
    params = []

    if disliked_ids:
        placeholders = ', '.join(['%s'] * len(disliked_ids))
        disliked_filter = f" AND s.id NOT IN ({placeholders})"
        params = list(disliked_ids)

    if mode == 'liked':
        # Mix from liked songs, shuffled
        liked_ids = SongRatingModel.get_liked_song_ids(user_id)
        if not liked_ids:
            return jsonify({'songs': [], 'message': 'No liked songs yet'})
        placeholders = ', '.join(['%s'] * len(liked_ids))
        query = f"""
            SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                   s.track_number, s.year, s.genre, s.cover_path
            FROM songs s
            WHERE s.id IN ({placeholders}){disliked_filter}
            ORDER BY RAND()
            LIMIT %s
        """
        results = Database.execute_query(query, tuple(liked_ids + params + [limit]), fetch_all=True)

    elif mode == 'discovery':
        # Songs the user hasn't played yet
        query = f"""
            SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                   s.track_number, s.year, s.genre, s.cover_path
            FROM songs s
            WHERE s.id NOT IN (
                SELECT DISTINCT song_id FROM play_history WHERE user_id = %s
            ){disliked_filter}
            ORDER BY RAND()
            LIMIT %s
        """
        results = Database.execute_query(query, tuple([user_id] + params + [limit]), fetch_all=True)

    else:
        # Radio mode: find songs similar to seed (same artist, genre, album)
        if not seed_song_id:
            # No seed — just shuffle everything
            query = f"""
                SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                       s.track_number, s.year, s.genre, s.cover_path
                FROM songs s WHERE 1=1{disliked_filter}
                ORDER BY RAND() LIMIT %s
            """
            results = Database.execute_query(query, tuple(params + [limit]), fetch_all=True)
        else:
            seed = Database.execute_query(
                "SELECT artist, genre, album FROM songs WHERE id = %s",
                (seed_song_id,), fetch_one=True
            )
            if not seed:
                return jsonify({'error': 'Seed song not found'}), 404

            # Score songs by similarity: same artist (3pts), same genre (2pts), same album (1pt)
            query = f"""
                SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                       s.track_number, s.year, s.genre, s.cover_path,
                       (CASE WHEN s.artist = %s THEN 3 ELSE 0 END +
                        CASE WHEN s.genre = %s AND s.genre IS NOT NULL AND s.genre != '' THEN 2 ELSE 0 END +
                        CASE WHEN s.album = %s THEN 1 ELSE 0 END) as similarity
                FROM songs s
                WHERE s.id != %s{disliked_filter}
                HAVING similarity > 0
                ORDER BY similarity DESC, RAND()
                LIMIT %s
            """
            seed_params = [seed['artist'], seed.get('genre', ''), seed.get('album', ''), seed_song_id]
            results = Database.execute_query(
                query, tuple(seed_params + params + [limit]), fetch_all=True
            )

            # If not enough similar songs, fill with random
            if len(results) < limit:
                existing_ids = {r['id'] for r in results}
                existing_ids.add(seed_song_id)
                fill_placeholders = ', '.join(['%s'] * len(existing_ids))
                fill_query = f"""
                    SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                           s.track_number, s.year, s.genre, s.cover_path, 0 as similarity
                    FROM songs s
                    WHERE s.id NOT IN ({fill_placeholders}){disliked_filter}
                    ORDER BY RAND()
                    LIMIT %s
                """
                fill_results = Database.execute_query(
                    fill_query, tuple(list(existing_ids) + params + [limit - len(results)]),
                    fetch_all=True
                )
                results.extend(fill_results)

    songs = []
    for row in results:
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

    return jsonify({'songs': songs, 'mode': mode, 'count': len(songs)})
