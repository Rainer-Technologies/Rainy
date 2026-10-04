"""Smart mix / auto-mix / radio mode endpoint."""
import random
import threading
import time
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


def _legacy_radio(seed_song_id, limit, disliked_ids, params):
    """Fallback radio: score songs by same artist/genre/tags/album.

    Used when the audio-feature recommender has nothing to work with
    (e.g. songs without enrichment features yet). Kept as the previous
    behavior so radio never regresses to empty.
    """
    seed = Database.execute_query(
        "SELECT id, file_path, title, artist, album, duration, "
        "track_number, year, genre, cover_path "
        "FROM songs WHERE id = %s",
        (seed_song_id,), fetch_one=True
    )
    if not seed:
        return []

    seed_artist = (seed.get('artist') or '').split(',')[0].strip()

    seed_tag_rows = Database.execute_query(
        "SELECT tag_name FROM song_tags WHERE song_id = %s "
        "ORDER BY weight DESC LIMIT 8",
        (seed_song_id,), fetch_all=True
    ) or []
    seed_tags = [r['tag_name'] for r in seed_tag_rows]

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
    disliked_filter = ""
    if disliked_ids:
        placeholders = ', '.join(['%s'] * len(disliked_ids))
        disliked_filter = f" AND s.id NOT IN ({placeholders})"

    query = f"""
        SELECT * FROM (
            SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                   s.track_number, s.year, s.genre, s.cover_path,
                   ({score_expr}) as similarity
            FROM songs s
            WHERE s.id != %s{disliked_filter}
        ) scored
        WHERE similarity > 0
        ORDER BY similarity DESC, RAND()
        LIMIT %s
    """
    results = Database.execute_query(
        query, tuple(score_params + [seed_song_id] + list(disliked_ids) + [limit]),
        fetch_all=True
    ) or []

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
            fill_query, tuple(list(existing_ids) + list(disliked_ids) + [limit - len(results)]),
            fetch_all=True
        ) or []
        results.extend(fill_results)

    # Include the seed track itself so the "now playing" song leads
    # the radio queue instead of being excluded.
    results.insert(0, seed)
    return results



# ---------------------------------------------------------------- mixes ----
# YouTube-Music-style shelf of personalised mixes (see utils/mixes.py).
# Cached briefly per user so tab switches are instant and a mix keeps its
# tracks while you browse; ?refresh=1 rolls a new seed for fresh picks.

_MIX_TTL = 300
_mix_cache = {}   # user_id -> {'ts', 'seed', 'mixes'}
_mix_cache_lock = threading.Lock()


@smartmix_bp.route('/mixes', methods=['GET'])
@login_required
def list_mixes(user_id):
    from utils import mixes as mix_engine

    refresh = request.args.get('refresh') in ('1', 'true')
    with _mix_cache_lock:
        hit = _mix_cache.get(user_id)
        if hit and not refresh and time.time() - hit['ts'] < _MIX_TTL:
            return jsonify({'mixes': hit['mixes'], 'cached': True})

    seed = random.randrange(1 << 30)
    try:
        ctx = mix_engine.load_context(user_id)
        mixes = mix_engine.serialize(ctx, mix_engine.build_mixes(ctx, seed=seed))
    except Exception as e:  # noqa: BLE001
        print(f"[smartmix] mix generation failed: {e}")
        return jsonify({'error': 'Could not build mixes right now'}), 500

    with _mix_cache_lock:
        _mix_cache[user_id] = {'ts': time.time(), 'seed': seed, 'mixes': mixes}
        if len(_mix_cache) > 200:
            oldest = min(_mix_cache, key=lambda u: _mix_cache[u]['ts'])
            _mix_cache.pop(oldest, None)
    return jsonify({'mixes': mixes, 'cached': False})


@smartmix_bp.route('/more', methods=['POST'])
@login_required
def more_from_mix(user_id):
    """Endless playback: songs that follow on from the ones already queued."""
    from utils import mixes as mix_engine

    data = request.get_json() or {}
    mix_id = str(data.get('mix_id') or '')
    recent = [i for i in (data.get('recent_ids') or []) if isinstance(i, int)][-200:]
    limit = max(1, min(int(data.get('limit') or 15), 40))
    try:
        ctx = mix_engine.load_context(user_id)
        ids = mix_engine.extend(ctx, mix_id, recent, limit=limit,
                                seed=random.randrange(1 << 30))
        songs = mix_engine.serialize(ctx, [{
            'id': mix_id, 'kind': 'more', 'shelf': '', 'title': '', 'subtitle': '',
            'tag': None, 'song_ids': ids}])
    except Exception as e:  # noqa: BLE001
        print(f"[smartmix] extend failed: {e}")
        return jsonify({'songs': []})
    return jsonify({'songs': songs[0]['songs'] if songs else []})


@smartmix_bp.route('/save', methods=['POST'])
@login_required
def save_mix(user_id):
    """Save a mix's songs as a regular playlist owned by the caller."""
    from models.library_access import LibraryAccessModel
    from models.playlist import PlaylistModel

    data = request.get_json() or {}
    name = str(data.get('name') or '').strip()[:100]
    song_ids = [i for i in (data.get('song_ids') or []) if isinstance(i, int)][:200]
    if not name or not song_ids:
        return jsonify({'error': 'A name and at least one song are required'}), 400

    visible = LibraryAccessModel.visible_song_ids(user_id)
    song_ids = [i for i in dict.fromkeys(song_ids) if i in visible]
    if not song_ids:
        return jsonify({'error': 'None of those songs are available'}), 400
    try:
        playlist_id = PlaylistModel.create_playlist(name, 'music-note', '#3d7dc4', user_id)
        for sid in song_ids:
            PlaylistModel.add_song_to_playlist(playlist_id, sid)
    except Exception as e:  # noqa: BLE001
        print(f"[smartmix] save failed: {e}")
        return jsonify({'error': 'Could not save the playlist'}), 500
    return jsonify({'success': True, 'id': playlist_id, 'name': name,
                    'count': len(song_ids)})


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
        # Songs the user hasn't played yet, ranked by audio-feature similarity
        # to their taste profile (play-count-weighted average of what they
        # listen to). Falls back to random unplayed if the recommender has no
        # features to work with yet.
        results = []
        try:
            from utils.recommender import discovery as discover_music
            ranked_ids = discover_music(user_id, limit=limit)
            if ranked_ids:
                placeholders = ', '.join(['%s'] * len(ranked_ids))
                query = f"""
                    SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                           s.track_number, s.year, s.genre, s.cover_path
                    FROM songs s
                    WHERE s.id IN ({placeholders}){disliked_filter}
                    ORDER BY FIELD(s.id, {placeholders})
                """
                results = Database.execute_query(
                    query, tuple(ranked_ids + params + ranked_ids), fetch_all=True)
        except Exception as e:  # noqa: BLE001
            print(f"[smartmix] discovery recommender failed, falling back: {e}")

        if not results:
            # Fallback: random unplayed songs
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

    elif mode == 'similar':
        # Pure audio-similarity radio: "songs that sound like this one"
        # (Discogs-EffNet genre tags + essentia audio features).
        if not seed_song_id:
            return jsonify({'error': 'seed_song_id required for similar mode'}), 400
        try:
            from utils.recommender import radio as audio_radio
            ranked_ids = audio_radio(seed_song_id, limit=limit, user_id=user_id)
        except Exception as e:  # noqa: BLE001
            print(f"[smartmix] audio radio failed, falling back to legacy: {e}")
            ranked_ids = []
        if ranked_ids:
            placeholders = ', '.join(['%s'] * len(ranked_ids))
            query = f"""
                SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
                       s.track_number, s.year, s.genre, s.cover_path
                FROM songs s
                WHERE s.id IN ({placeholders}){disliked_filter}
                ORDER BY FIELD(s.id, {placeholders})
            """
            results = Database.execute_query(
                query, tuple(ranked_ids + params + ranked_ids), fetch_all=True)
            # Lead with the seed track like the legacy radio did
            seed = Database.execute_query(
                "SELECT id, file_path, title, artist, album, duration, "
                "track_number, year, genre, cover_path "
                "FROM songs WHERE id = %s",
                (seed_song_id,), fetch_one=True
            )
            if seed:
                results.insert(0, seed)
        else:
            # Fallback: legacy radio (same artist/genre/tags scoring)
            results = _legacy_radio(seed_song_id, limit, disliked_ids, params)

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
            results = _legacy_radio(seed_song_id, limit, disliked_ids, params)

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

    # Per-account library isolation: drop songs this user has no access to.
    from models.library_access import LibraryAccessModel
    songs = LibraryAccessModel.filter_visible(user_id, songs)

    return jsonify({'songs': songs, 'mode': mode, 'count': len(songs)})
