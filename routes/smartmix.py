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
                "SELECT id, file_path, title, artist, album, duration, "
                "track_number, year, genre, cover_path "
                "FROM songs WHERE id = %s",
                (seed_song_id,), fetch_one=True
            )
            if not seed:
                return jsonify({'error': 'Seed song not found'}), 404

            seed_artist = (seed.get('artist') or '').split(',')[0].strip()

            # Crowd-sourced tags for the seed (strongest first) — used to reward
            # candidates that share genre/mood/style labels with the seed.
            seed_tag_rows = Database.execute_query(
                "SELECT tag_name FROM song_tags WHERE song_id = %s "
                "ORDER BY weight DESC LIMIT 8",
                (seed_song_id,), fetch_all=True
            ) or []
            seed_tags = [r['tag_name'] for r in seed_tag_rows]

            # Score songs by similarity:
            #   same artist  -> 3 pts
            #   same genre   -> 2 pts
            #   similar artist (Last.fm graph) -> 2 pts
            #   shared tags  -> 1 pt each, capped at 3
            #   same album   -> 1 pt
            score_terms = [
                "CASE WHEN s.artist = %s THEN 3 ELSE 0 END",
                "CASE WHEN s.genre = %s AND s.genre IS NOT NULL AND s.genre != '' THEN 2 ELSE 0 END",
                "CASE WHEN EXISTS (SELECT 1 FROM artist_relations ar "
                "WHERE ar.artist_name = %s AND ar.related_artist = s.artist) THEN 2 ELSE 0 END",
                "CASE WHEN s.album = %s THEN 1 ELSE 0 END",
            ]
            score_params = [
                seed['artist'],
                seed.get('genre', '') or '',
                seed_artist,
                seed.get('album', '') or '',
            ]
            if seed_tags:
                placeholders = ', '.join(['%s'] * len(seed_tags))
                score_terms.append(
                    f"LEAST((SELECT COUNT(DISTINCT tag_name) FROM song_tags "
                    f"WHERE song_id = s.id AND tag_name IN ({placeholders})), 3)"
                )
                score_params.extend(seed_tags)

            score_expr = ' + '.join(score_terms)
            query = f"""
                SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                       s.track_number, s.year, s.genre, s.cover_path,
                       ({score_expr}) as similarity
                FROM songs s
                WHERE s.id != %s{disliked_filter}
                HAVING similarity > 0
                ORDER BY similarity DESC, RAND()
                LIMIT %s
            """
            results = Database.execute_query(
                query, tuple(score_params + [seed_song_id] + params + [limit]),
                fetch_all=True
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

            # Include the seed track itself so the "now playing" song leads
            # the radio queue instead of being excluded.
            results.insert(0, seed)

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
