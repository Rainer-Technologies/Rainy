from flask import Blueprint, request, jsonify, session
from functools import wraps
from models.database import Database
from models.library_access import LibraryAccessModel


def _dedupe_artists(raw):
    """Split comma-separated artist strings, deduplicate, and rejoin sorted."""
    if not raw:
        return 'Unknown Artist'
    seen = set()
    artists = []
    for part in raw.split(','):
        name = part.strip()
        if name and name.lower() not in seen:
            seen.add(name.lower())
            artists.append(name)
    return ', '.join(sorted(artists, key=str.lower)) if artists else 'Unknown Artist'

albums_bp = Blueprint('albums', __name__, url_prefix='/api/albums')


from routes.auth import get_current_user_id


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user_id, *args, **kwargs)
    return decorated



@albums_bp.route('/', methods=['GET'])
@login_required
def get_albums(user_id):
    """Get all albums with cover art and song counts."""
    search = request.args.get('search', '').strip()
    sort = request.args.get('sort', 'name')  # name, artist, year, recent

    join_sql, join_params = LibraryAccessModel.access_join(user_id)
    query = f"""
        SELECT s.album,
               GROUP_CONCAT(DISTINCT TRIM(s.artist) ORDER BY TRIM(s.artist) SEPARATOR ', ') as artist,
               COUNT(*) as song_count,
               SUM(s.duration) as total_duration,
               MAX(s.year) as year,
               MAX(s.cover_path) as cover_path,
               MAX(s.scanned_at) as last_scanned
        FROM songs s
        {join_sql}
        WHERE s.album IS NOT NULL AND s.album != '' AND s.album != 'Unknown Album'
    """
    params = list(join_params)

    if search:
        query += " AND (album LIKE %s OR artist LIKE %s)"
        params.extend([f'%{search}%', f'%{search}%'])

    query += " GROUP BY album"

    sort_map = {
        'name': 'album ASC',
        'artist': 'artist ASC, album ASC',
        'year': 'year DESC',
        'recent': 'last_scanned DESC',
    }
    query += f" ORDER BY {sort_map.get(sort, 'album ASC')}"

    results = Database.execute_query(query, tuple(params), fetch_all=True)

    albums = []
    for row in results:
        albums.append({
            'album': row['album'],
            'artist': _dedupe_artists(row['artist']),
            'song_count': row['song_count'],
            'total_duration': row['total_duration'],
            'year': row['year'],
            'cover_path': row['cover_path']
        })

    return jsonify({'albums': albums})


@albums_bp.route('/detail', methods=['GET'])
@login_required
def get_album_detail(user_id):
    """Get all songs in a specific album."""
    album = request.args.get('album', '').strip()
    artist = request.args.get('artist', '').strip()

    if not album:
        return jsonify({'error': 'album parameter is required'}), 400

    join_sql, join_params = LibraryAccessModel.access_join(user_id)
    query = f"""
        SELECT s.id, s.file_path, s.title, s.artist, s.album, s.duration,
               s.track_number, s.year, s.genre, s.cover_path
        FROM songs s
        {join_sql}
        WHERE s.album = %s
    """
    params = [*join_params, album]

    query += " ORDER BY s.track_number ASC, s.title ASC"

    results = Database.execute_query(query, tuple(params), fetch_all=True)

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

    # Get album metadata (scoped to the user's visible songs)
    meta_join_sql, meta_join_params = LibraryAccessModel.access_join(user_id)
    meta_query = f"""
        SELECT s.album,
               GROUP_CONCAT(DISTINCT s.artist ORDER BY s.artist SEPARATOR ', ') as artist,
               COUNT(*) as song_count,
               SUM(s.duration) as total_duration, MAX(s.year) as year,
               MAX(s.cover_path) as cover_path
        FROM songs s
        {meta_join_sql}
        WHERE s.album = %s
    """
    meta_params = [*meta_join_params, album]
    meta_query += " GROUP BY s.album"

    meta = Database.execute_query(meta_query, tuple(meta_params), fetch_one=True)

    return jsonify({
        'album': {
            'album': meta['album'] if meta else album,
            'artist': _dedupe_artists(meta['artist']) if meta else (artist or 'Unknown Artist'),
            'song_count': meta['song_count'] if meta else len(songs),
            'total_duration': meta['total_duration'] if meta else 0,
            'year': meta['year'] if meta else None,
            'cover_path': meta['cover_path'] if meta else None
        },
        'songs': songs
    })
