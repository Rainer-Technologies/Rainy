from flask import Blueprint, jsonify, session, send_file, request
from models.settings import SettingsModel
from models.song import SongModel, ScanHistoryModel
from models.database import Database
from utils.scanner import MusicScanner
from routes.auth import (get_current_user_id, is_sysadmin, require_auth,
                         require_song_access, require_song_play_access,
                         require_sysadmin, server_error)
import os

music_bp = Blueprint('music', __name__, url_prefix='/api/music')


@music_bp.route('/library', methods=['GET'])
@require_auth
def get_library():
    """Get all songs in the music library from database, organized by sections."""
    try:
        music_path = SettingsModel.get_music_path()
        
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        # Per-account isolation: only songs this user has access to.
        # Sysadmins backfill first so newly scanned songs appear.
        user_id = get_current_user_id()
        from models.library_access import LibraryAccessModel
        if is_sysadmin():
            LibraryAccessModel.backfill_user(user_id)

        # Get all songs visible to this user
        all_songs = SongModel.get_all_songs(user_id=user_id)
        # Lets the client's change watcher know which state it has rendered.
        version = SongModel.get_library_version(user_id)
        
        # If database is empty, suggest running a scan
        if not all_songs:
            return jsonify({
                'success': True,
                'sections': [],
                'all_songs': [],
                'total': 0,
                'version': version,
                'message': 'Library is empty. Run a scan to populate the library.'
            })
        
        # Get recently added songs (last 20)
        recently_added = SongModel.get_recently_added(20, user_id=user_id)
        
        # Build sections
        sections = []
        
        if recently_added:
            sections.append({
                'id': 'recently-added',
                'title': 'Recently Added',
                'type': 'horizontal', # horizontal scrolling carousel
                'songs': recently_added
            })
        
        # Add "All Songs" section
        sections.append({
            'id': 'all-songs',
            'title': 'All Songs',
            'type': 'grid', # full grid view
            'songs': all_songs
        })
        
        return jsonify({
            'success': True,
            'sections': sections,
            'all_songs': all_songs,  # Keep for backward compatibility and search
            'total': len(all_songs),
            'version': version
        })
        
    except Exception:
        return server_error()


@music_bp.route('/library/version', methods=['GET'])
@require_auth
def get_library_version():
    """Fingerprints of the user's songs and playlists.

    Polled by open clients so new songs/playlists (added from another tab,
    device, user, or a background job) show up without a page reload. Both
    values are opaque: compare them, never parse them.
    """
    from models.playlist import PlaylistModel
    user_id = get_current_user_id()
    return jsonify({
        'songs': SongModel.get_library_version(user_id),
        'playlists': PlaylistModel.get_version_for_user(user_id),
    })


@music_bp.route('/tempo', methods=['GET'])
@require_auth
def get_tempo_map():
    """Return analysed BPM values keyed by song ID for tempo-aware shuffle."""
    try:
        rows = Database.execute_query(
            """
            SELECT song_id, tempo_bpm
            FROM song_features
            WHERE tempo_bpm IS NOT NULL AND tempo_bpm > 0
            """,
            fetch_all=True,
        ) or []

        return jsonify({
            'tempos': [
                {
                    'song_id': row['song_id'],
                    'tempo_bpm': float(row['tempo_bpm']),
                }
                for row in rows
            ]
        })
    except Exception:
        return server_error()


@music_bp.route('/scan', methods=['POST'])
@require_sysadmin
def rescan_library():
    """Quick rescan - find new files and update modified ones.

    Sysadmin-only: a scan touches the whole shared music folder and feeds the
    admin-only scanned library."""
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
        
    except Exception:
        return server_error()


@music_bp.route('/scan/full', methods=['POST'])
@require_sysadmin
def full_rescan_library():
    """Full rescan - re-read the tags of every file, updating rows in place."""
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
        
    except Exception:
        return server_error()


@music_bp.route('/scan/status', methods=['GET'])
@require_auth
def get_scan_status():
    """Get the status of the most recent scan."""
    try:
        from models.library_access import LibraryAccessModel
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
            'library_total': (SongModel.get_song_count() if is_sysadmin() else
                              len(LibraryAccessModel.visible_song_ids(get_current_user_id())))
        })
        
    except Exception:
        return server_error()


def _remove_song_files(songs):
    """Delete the audio files of songs whose rows are already gone, plus
    each cover image no remaining song or playlist still uses.

    Only paths inside the music folder are touched. Best-effort: the rows
    are already deleted, so a file that can't be removed is just logged.
    """
    from flask import current_app
    music_path = SettingsModel.get_music_path()
    if not music_path:
        return
    root = os.path.realpath(music_path)

    def inside(rel):
        full = os.path.realpath(os.path.join(root, rel.replace('\\', '/')))
        return full if full != root and os.path.commonpath([root, full]) == root else None

    def remove(full):
        try:
            if full and os.path.isfile(full):
                os.remove(full)
        except OSError:
            current_app.logger.exception('Could not delete %s', full)

    for song in songs:
        if song.get('file_path'):
            remove(inside(song['file_path']))
        cover = song.get('cover_path')
        if cover and not Database.execute_query(
                "SELECT 1 FROM songs WHERE cover_path = %s "
                "UNION SELECT 1 FROM playlists WHERE cover_path = %s",
                (cover, cover), fetch_one=True):
            remove(inside(cover))


@music_bp.route('/song/<int:song_id>', methods=['DELETE'])
@require_auth
def delete_song(song_id):
    """Remove a song from the requester's library.

    - Admins: full delete (database row + file + cover) as before.
    - Regular users: the song is REMOVED FROM THEIR LIBRARY only — the file
      and row stay if it is published or in the scanned admin library, or
      if ANY other account has access to it.
      Only when this user is the sole owner (their own personal import) is
      the file+row deleted from the system too.
    """
    try:
        music_path = SettingsModel.get_music_path()

        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400

        # Check if song exists in database
        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        user_id = get_current_user_id()
        from models.library_access import LibraryAccessModel
        if not LibraryAccessModel.has_access(user_id, song_id):
            return jsonify({'error': 'Song not found'}), 404

        is_admin = is_sysadmin()

        if not is_admin:
            # Regular user: revoke-only unless this song is exclusively theirs
            # (their own personal import, not in the shared folder).
            communal = LibraryAccessModel.song_is_communal(song_id)
            others = LibraryAccessModel.access_count_excluding(user_id, song_id)
            if communal or others > 0:
                LibraryAccessModel.revoke(user_id, song_id)
                return jsonify({
                    'success': True,
                    'removed': 'library',
                    'message': 'Song removed from your library'
                })

        # Delete the row first, then the file and (if now unused) the cover.
        SongModel.delete_song_by_id(song_id)
        _remove_song_files([song])

        return jsonify({
            'success': True,
            'removed': 'system' if is_admin else 'library',
            'message': 'Song removed from library and disk'
        })

    except Exception:
        return server_error()


@music_bp.route('/stream/<int:song_id>', methods=['GET'])
@require_auth
def stream_song(song_id):
    """Stream an audio file with range request support."""
    try:
        music_path = SettingsModel.get_music_path()
        
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        from flask import Response

        # Look up song by ID to get file path
        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        # Per-account isolation: 404 (not 403) so clients treat it as
        # "doesn't exist in your library".
        from models.library_access import LibraryAccessModel
        if not LibraryAccessModel.can_play(get_current_user_id(), song_id):
            return jsonify({'error': 'Song not found'}), 404

        relative_path = song['file_path']
        
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
            '.wma': 'audio/x-ms-wma',
            '.mkv': 'video/x-matroska'
        }
        
        mime_type = mime_types.get(ext, 'audio/mpeg')
        file_size = os.path.getsize(full_path)
        
        # Handle Range requests for proper audio streaming
        range_header = request.headers.get('Range')
        
        if range_header:
            # Parse range header (e.g., "bytes=0-1023")
            byte_range = range_header.replace('bytes=', '').split('-')
            start = int(byte_range[0]) if byte_range[0] else 0
            end = int(byte_range[1]) if byte_range[1] else file_size - 1
            
            # Ensure valid range
            if start >= file_size:
                return Response(status=416)  # Range Not Satisfiable
            
            end = min(end, file_size - 1)
            length = end - start + 1
        else:
            # No range - stream full file
            start = 0
            end = file_size - 1
            length = file_size
        
        def generate():
            chunk_size = 64 * 1024  # 64KB chunks for better streaming
            with open(full_path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    read_size = min(chunk_size, remaining)
                    data = f.read(read_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data
        
        if range_header:
            response = Response(generate(), status=206, mimetype=mime_type)
            response.headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
        else:
            response = Response(generate(), status=200, mimetype=mime_type)
        
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['Content-Length'] = length
        response.headers['Cache-Control'] = 'no-cache'
        return response
        
    except Exception:
        return server_error()


def _cast_base_url():
    """Absolute, LAN-reachable base URL for Chromecast media, always plain
    HTTP. The Chromecast fetches stream/cover URLs itself and cannot validate
    a self-signed HTTPS cert, so even when the UI is served over HTTPS (for
    the sender SDK) the media must come from the HTTP listener."""
    from config import Config
    host = request.host.split(':')[0]
    return f'http://{host}:{Config.HTTP_PORT}/'


def _cast_media_token():
    """Short-lived, media-only token embeddable in URLs for devices (e.g.
    Chromecast) that fetch media directly and can't send our cookies. Unlike
    the session cookie it only opens stream/cover and expires on its own."""
    from utils import media_token
    return media_token.issue(get_current_user_id())


def _cast_urls_for_song(song):
    """Build absolute, token-authenticated stream/cover URLs for a song row."""
    from urllib.parse import quote
    base = _cast_base_url()
    token = _cast_media_token()
    query = f'?mt={quote(token)}' if token else ''
    result = {
        'id': song['id'],
        'url': f"{base}api/music/stream/{song['id']}{query}",
    }
    cover_path = song.get('cover_path')
    if cover_path:
        result['cover_url'] = f"{base}api/music/cover/{quote(cover_path, safe='/')}{query}"
    return result


@music_bp.route('/cast-url/<int:song_id>', methods=['GET'])
@require_auth
@require_song_play_access
def cast_url(song_id):
    """Return an absolute, token-authenticated stream URL a Chromecast can
    fetch directly (Cast receivers can't use the browser's session cookie)."""
    song = SongModel.get_song_by_id(song_id)
    if not song:
        return jsonify({'error': 'Song not found'}), 404
    return jsonify({'success': True, **_cast_urls_for_song(song)})


@music_bp.route('/cast-urls', methods=['POST'])
@require_auth
def cast_urls():
    """Batch variant of /cast-url: resolve absolute stream URLs for a whole
    queue in one round trip. Body: {"song_ids": [1, 2, 3]}."""
    from models.library_access import LibraryAccessModel
    data = request.get_json(silent=True) or {}
    song_ids = data.get('song_ids') or []
    user_id = get_current_user_id()
    urls = {}
    for raw_id in song_ids:
        try:
            sid = int(raw_id)
        except (TypeError, ValueError):
            continue
        if not LibraryAccessModel.can_play(user_id, sid):
            continue
        song = SongModel.get_song_by_id(sid)
        if song:
            urls[str(sid)] = _cast_urls_for_song(song)
    return jsonify({'success': True, 'urls': urls})


@music_bp.route('/info/<int:song_id>', methods=['GET'])
@require_auth
@require_song_play_access
def get_song_info(song_id):
    """Get detailed info for a specific song."""
    try:
        # Get song from database by ID
        song = SongModel.get_song_by_id(song_id)
        
        if song:
            return jsonify({
                'success': True,
                'song': {
                    'id': song['id'],
                    'path': song['file_path'],
                    'title': song['title'],
                    'artist': song['artist'],
                    'album': song['album'],
                    'duration': song['duration'],
                    'track': song['track_number'],
                    'year': song['year'],
                    'genre': song['genre'],
                    'cover_path': song.get('cover_path')
                }
            })
        
        return jsonify({'error': 'Song not found'}), 404
        
    except Exception:
        return server_error()


@music_bp.route('/metadata/search', methods=['POST'])
@require_auth
def search_metadata():
    """Search for song metadata using YouTube Music."""
    try:
        from utils.metadata import MetadataSearcher
        
        data = request.get_json()
        query = data.get('query', '')
        
        if not query:
            return jsonify({'error': 'Search query is required'}), 400
        
        searcher = MetadataSearcher()
        results = searcher.search(query, limit=10)
        
        return jsonify({
            'success': True,
            'results': results
        })
        
    except Exception:
        return server_error()


@music_bp.route('/metadata/apply/<int:song_id>', methods=['POST'])
@require_auth
def apply_metadata(song_id):
    """Apply selected metadata to a song."""
    try:
        from utils.metadata import MetadataSearcher
        
        data = request.get_json()
        
        # Get the song to verify it exists
        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        # Per-account isolation: only users who can see/hear the song may
        # edit its metadata (a shared-library song's metadata is
        # system-wide, so this is a write the account must be allowed to
        # make — otherwise any logged-in user could rewrite any song).
        from models.library_access import LibraryAccessModel
        if not LibraryAccessModel.has_access(get_current_user_id(), song_id):
            return jsonify({'error': 'Song not found'}), 404
        
        relative_path = song['file_path']
        
        # Prepare metadata update
        metadata = {}
        
        if data.get('title'):
            metadata['title'] = data['title']
        if data.get('artist'):
            # Deduplicate comma-separated artists (e.g. "A, A, A" -> "A")
            raw_artist = str(data['artist']).strip()
            seen_a = set()
            deduped_a = []
            for part in raw_artist.split(','):
                name = part.strip()
                if not name:
                    continue
                key = name.lower()
                if key not in seen_a:
                    seen_a.add(key)
                    deduped_a.append(name)
            metadata['artist'] = ', '.join(deduped_a) if deduped_a else raw_artist
        if data.get('album'):
            metadata['album'] = data['album']
        if data.get('year'):
            metadata['year'] = data['year']
        if data.get('genre'):
            metadata['genre'] = data['genre']
        
        # Download cover art if URL provided
        if data.get('cover_url'):
            music_path = SettingsModel.get_music_path()
            if music_path:
                searcher = MetadataSearcher()
                # Use song file path hash as cover filename for uniqueness
                import hashlib
                cover_filename = hashlib.md5(relative_path.encode()).hexdigest()
                cover_path = searcher.download_cover(
                    data['cover_url'], 
                    music_path, 
                    cover_filename
                )
                if cover_path:
                    metadata['cover_path'] = cover_path
        
        # Update the song metadata
        if metadata:
            SongModel.update_song_metadata(relative_path, metadata)
        
        # Return updated song info
        updated_song = SongModel.get_song_by_id(song_id)
        
        return jsonify({
            'success': True,
            'message': 'Metadata updated successfully',
            'song': {
                'id': updated_song['id'],
                'path': updated_song['file_path'],
                'title': updated_song['title'],
                'artist': updated_song['artist'],
                'album': updated_song['album'],
                'duration': updated_song['duration'],
                'track': updated_song['track_number'],
                'year': updated_song['year'],
                'genre': updated_song['genre'],
                'cover_path': updated_song.get('cover_path')
            }
        })
        
    except Exception:
        return server_error()


@music_bp.route('/cover/<path:cover_path>', methods=['GET'])
@require_auth
def serve_cover(cover_path):
    """Serve cover art images."""
    try:
        from urllib.parse import unquote
        
        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        relative_path = unquote(cover_path)
        
        # Normalize Windows-style separators stored in the DB (covers\\x.jpg)
        # to POSIX ones — otherwise the Linux server 404s every backslash
        # cover, breaking seed covers the moment a radio starts (bug fixed
        # Aug 2026).
        relative_path = relative_path.replace('\\', '/')
        
        # Security: only allow access to 'covers' directory
        # Check standard path separators
        is_covers_dir = relative_path.startswith('covers/') or relative_path.startswith('covers\\')
        if not is_covers_dir:
             return jsonify({'error': 'Invalid cover path'}), 403

        # Build full path
        full_path = os.path.normpath(os.path.join(music_path, relative_path))
        covers_dir = os.path.normpath(os.path.join(music_path, 'covers'))
        
        # Security check: ensure file is specifically within the covers directory
        if not full_path.startswith(covers_dir):
            return jsonify({'error': 'Access denied'}), 403
        
        if not os.path.isfile(full_path):
            return jsonify({'error': 'Cover not found'}), 404
        
        # Determine MIME type
        ext = os.path.splitext(full_path)[1].lower()
        mime_types = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif'
        }
        
        mime_type = mime_types.get(ext, 'image/jpeg')
        
        return send_file(full_path, mimetype=mime_type)
        
    except Exception:
        return server_error()


@music_bp.route('/upload', methods=['POST'])
@require_auth
def upload_files():
    """Upload audio files to the music library."""
    try:
        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        if 'files' not in request.files:
            return jsonify({'error': 'No files provided'}), 400
        
        files = request.files.getlist('files')
        if not files:
            return jsonify({'error': 'No files provided'}), 400
        
        # Allowed audio extensions
        allowed_extensions = {'.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.wma', '.mkv'}
        
        uploaded = 0
        errors = []
        
        for file in files:
            if file.filename:
                ext = os.path.splitext(file.filename)[1].lower()
                if ext in allowed_extensions:
                    # Save file to music library root
                    safe_filename = os.path.basename(file.filename)
                    save_path = os.path.join(music_path, safe_filename)
                    
                    # Dedupe: if this exact file already exists on the system,
                    # just enable it on the uploading account instead of
                    # storing a second copy.
                    if os.path.exists(save_path):
                        rel = os.path.relpath(save_path, music_path).replace('\\', '/')
                        existing_song = SongModel.get_song_by_path(rel)
                        if existing_song:
                            from models.library_access import LibraryAccessModel
                            try:
                                LibraryAccessModel.on_scan_added([existing_song['id']])
                            except Exception:
                                pass
                            uploaded += 1
                            continue
                        # Unknown leftover file: keep the old suffix behavior
                        base, ext = os.path.splitext(safe_filename)
                        counter = 1
                        while os.path.exists(save_path):
                            save_path = os.path.join(music_path, f"{base}_{counter}{ext}")
                            counter += 1
                    
                    file.save(save_path)
                    
                    # Add to database with metadata extraction. Uploads land in
                    # the SHARED music folder, so — like a disk scan — they are
                    # communal: every account gets access (and the uploader
                    # sees their own file immediately).
                    scanner = MusicScanner(music_path)
                    metadata = scanner.scan_single_file(save_path)
                    if metadata and metadata.get('id'):
                        # Cross-source dedupe: if the uploaded audio matches an
                        # existing song (hash or fingerprint), drop the copy
                        # and link the uploader to the existing row instead.
                        from utils import dedupe
                        dup = dedupe.finalize_new_song(
                            save_path, metadata['id'],
                            duration=metadata.get('duration'))
                        target_id = dup[0] if dup else metadata['id']
                        try:
                            from models.library_access import LibraryAccessModel
                            # Uploader always sees their own upload.
                            LibraryAccessModel.grant(
                                get_current_user_id(), target_id,
                                origin='import')
                            # Shared-folder semantics: admins get it too.
                            LibraryAccessModel.on_scan_added([target_id])
                        except Exception:
                            pass
                    uploaded += 1
                else:
                    errors.append(f"Invalid file type: {file.filename}")
        
        return jsonify({
            'success': True,
            'uploaded': uploaded,
            'errors': errors if errors else None
        })
        
    except Exception:
        return server_error()


@music_bp.route('/youtube-import', methods=['POST'])
@require_auth
def youtube_import():
    """Import a song from YouTube/YouTube Music."""
    try:
        from utils.youtube import YouTubeDownloader
        
        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        data = request.get_json()
        url = data.get('url', '').strip()
        
        if not url:
            return jsonify({'error': 'No URL provided'}), 400
        
        downloader = YouTubeDownloader(music_path)
        result = downloader.download(url)
        
        if result.get('success'):
            # Check if song already exists (don't re-add to database)
            if result.get('already_exists'):
                # The importer must still SEE the song even if someone else
                # had imported it before.
                try:
                    rel = os.path.relpath(result.get('file_path'), music_path)
                    existing = SongModel.get_song_by_path(rel)
                    if existing:
                        from models.library_access import LibraryAccessModel
                        LibraryAccessModel.grant(get_current_user_id(),
                                                 existing['id'], origin='import')
                except Exception as e:  # noqa: BLE001
                    print(f"[import] grant-on-existing failed: {e}")
                return jsonify({
                    'success': True,
                    'already_exists': True,
                    'title': result.get('title'),
                    'artist': result.get('artist'),
                    'message': result.get('message', 'Song already exists in library')
                })
            
            # Add to database (new song)
            if result.get('file_path'):
                scanner = MusicScanner(music_path)
                metadata = scanner.scan_single_file(result['file_path'])

                if metadata and metadata.get('id'):
                    # Cross-source dedupe: different file/encode of a song
                    # already on the system → enable the existing song.
                    from utils import dedupe
                    dup = dedupe.finalize_new_song(
                        result['file_path'], metadata['id'],
                        duration=metadata.get('duration'))
                    if dup:
                        existing_id, kind, score = dup
                        from models.library_access import LibraryAccessModel
                        LibraryAccessModel.grant(get_current_user_id(),
                                                 existing_id, origin='import')
                        return jsonify({
                            'success': True,
                            'already_exists': True,
                            'title': result.get('title'),
                            'artist': result.get('artist'),
                            'message': f'Song already exists in library '
                                       f'(matched by {kind}, {score:.0%} similar)'
                        })
                    from models.library_access import LibraryAccessModel
                    LibraryAccessModel.grant(get_current_user_id(),
                                             metadata['id'], origin='import')

                # Update cover_path if thumbnail was downloaded
                if result.get('cover_path') and metadata:
                    SongModel.update_song_metadata(metadata['path'], {'cover_path': result['cover_path']})

            return jsonify({
                'success': True,
                'title': result.get('title'),
                'artist': result.get('artist')
            })
        else:
            return jsonify({
                'success': False,
                'error': result.get('error', 'Download failed')
            }), 400
        
    except ImportError:
        return jsonify({'error': 'yt-dlp not installed. Please install it with: pip install yt-dlp'}), 500
    except Exception:
        return server_error()


@music_bp.route('/import-playlist-precheck', methods=['POST'])
@require_auth
def import_playlist_precheck():
    """Resolve the name of an imported playlist and report whether a playlist
    with that name already exists, so the client can offer Add vs Override
    before any downloading happens.

    Body: { source: 'youtube'|'spotify', url }
    Returns: { success, playlist_name, exists, existing_id }
    """
    try:
        from models.playlist import PlaylistModel

        data = request.get_json() or {}
        source = (data.get('source') or '').lower()
        url = (data.get('url') or '').strip()

        if not url:
            return jsonify({'error': 'No URL provided'}), 400

        playlist_name = None
        try:
            if source == 'youtube':
                from utils.youtube import YouTubeDownloader
                music_path = SettingsModel.get_music_path()
                downloader = YouTubeDownloader(music_path)
                info = downloader._extract_playlist_info(url)
                if info:
                    playlist_name = info.get('title') or 'Imported Playlist'
            elif source == 'spotify':
                from utils.spotify import SpotifyImporter
                importer = SpotifyImporter()
                pdata = importer.fetch_playlist(url)
                if pdata.get('success'):
                    playlist_name = pdata.get('name') or 'Imported Playlist'
            else:
                return jsonify({'error': 'Unknown source'}), 400
        except Exception as e:
            return jsonify({'error': f'Could not read playlist: {e}'}), 400

        if not playlist_name:
            return jsonify({'error': 'Could not determine playlist name'}), 400

        # Per-account isolation: only the user's OWN playlists count as a
        # name collision — another account's playlist is never touched.
        existing = PlaylistModel.get_playlist_by_name(
            playlist_name, session.get('user_id'))
        return jsonify({
            'success': True,
            'playlist_name': playlist_name,
            'exists': bool(existing),
            'existing_id': existing['id'] if existing else None,
        })
    except Exception:
        return server_error()


class _ImportPlaylistConflict(Exception):
    """Raised when an import targets a playlist name that already exists and
    no explicit conflict_mode was supplied."""


def _resolve_import_playlist(playlist_model, playlist_name, conflict_mode,
                             owner_user_id=None):
    """Decide which playlist an import should write into.

    conflict_mode:
      - None / 'ask'  -> create new, but raise if name already exists
      - 'add'         -> reuse the existing playlist (append new songs)
      - 'override'    -> reuse the existing playlist but wipe its songs first
      - 'new'         -> always create a fresh playlist (auto-suffix name)

    Returns the playlist id to write into.
    """
    # Per-account isolation: a same-named playlist owned by ANOTHER account
    # must never be reused or merged into.
    existing = playlist_model.get_playlist_by_name(
        playlist_name, owner_user_id)

    if conflict_mode in ('add', 'override') and existing:
        if conflict_mode == 'override':
            playlist_model.clear_playlist_entries(existing['id'])
        return existing['id']

    if conflict_mode == 'new':
        # Force a unique name so we never collide.
        base = playlist_name
        n = 2
        name = f"{base} ({n})"
        while playlist_model.get_playlist_by_name(name, owner_user_id):
            n += 1
            name = f"{base} ({n})"
        return playlist_model.create_playlist(
            name, owner_user_id=owner_user_id)

    # Default behaviour: create, but refuse to silently clobber an existing one.
    if existing:
        raise _ImportPlaylistConflict(
            f"A playlist named “{playlist_name}” already exists"
        )
    return playlist_model.create_playlist(
        playlist_name, owner_user_id=owner_user_id)


@music_bp.route('/youtube-playlist-import', methods=['POST'])
@require_auth
def youtube_playlist_import():
    """Import a playlist from YouTube/YouTube Music (Streaming response)."""
    try:
        from utils.youtube import YouTubeDownloader
        from models.playlist import PlaylistModel
        from flask import Response, stream_with_context
        import json
        
        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        data = request.get_json()
        url = data.get('url', '').strip()
        
        if not url:
            return jsonify({'error': 'No URL provided'}), 400

        def generate():
            import threading
            import queue
            
            q = queue.Queue()
            
            def on_progress(current, total, message):
                percent = 0
                if total > 0:
                    percent = int((current / total) * 90) # Leave 10% for DB operations
                
                q.put(json.dumps({
                    'type': 'progress',
                    'percent': percent,
                    'message': message
                }) + '\n')

            def worker():
                try:
                    downloader = YouTubeDownloader(music_path)
                    result = downloader.download_playlist(url, progress_callback=on_progress)
                    q.put({'type': 'result_obj', 'data': result})
                except Exception as e:
                    q.put({'type': 'error_obj', 'error': str(e)})
                finally:
                    q.put(None) # Sentinel

            t = threading.Thread(target=worker)
            t.start()
            
            playlist_result = None
            
            while True:
                item = q.get()
                if item is None:
                    break
                
                if isinstance(item, dict):
                    if item.get('type') == 'result_obj':
                        playlist_result = item['data']
                    elif item.get('type') == 'error_obj':
                        yield json.dumps({
                            'type': 'error',
                            'error': item['error']
                        }) + '\n'
                        return
                else:
                    yield item
            
            t.join()
            
            if not playlist_result:
                # Should have been handled by error_obj
                return

            result = playlist_result
            if result.get('success'):
                songs = result.get('songs', [])
                playlist_name = result.get('playlist_name', 'Imported Playlist')
                
                yield json.dumps({
                    'type': 'progress',
                    'percent': 90,
                    'message': 'Creating playlist and updating library...'
                }) + '\n'
                
                if not songs:
                    yield json.dumps({
                        'type': 'error',
                        'error': 'No songs were downloaded from the playlist'
                    }) + '\n'
                    return
                
                created_playlist_id = None
                try:
                    created_playlist_id = _resolve_import_playlist(
                        PlaylistModel, playlist_name, data.get('conflict_mode'),
                        session.get('user_id')
                    )
                except Exception as e:
                    yield json.dumps({
                        'type': 'error',
                        'error': f'Failed to create playlist: {str(e)}'
                    }) + '\n'
                    return
                
                added_count = 0
                total_songs = len(songs)
                
                for i, song in enumerate(songs):
                    file_path = song.get('file_path')
                    if file_path:
                        try:
                            song_id = None
                            
                            # Check if song already existed (wasn't downloaded)
                            if song.get('already_exists'):
                                # Look up existing song by file path
                                relative_path = os.path.relpath(file_path, music_path)
                                existing_song = SongModel.get_song_by_path(relative_path)
                                if existing_song:
                                    song_id = existing_song['id']
                                    # Deduped download: the importer still
                                    # gets the song enabled on their account,
                                    # instead of a second file copy.
                                    from models.library_access import LibraryAccessModel
                                    LibraryAccessModel.grant(
                                        session.get('user_id'), song_id,
                                        origin='import')
                            else:
                                # New song - add to database
                                scanner = MusicScanner(music_path)
                                metadata = scanner.scan_single_file(file_path)

                                if metadata and metadata.get('id'):
                                    song_id = metadata['id']
                                    # Cross-source dedupe: reuse an existing
                                    # song row (delete the redundant file).
                                    from utils import dedupe
                                    dup = dedupe.finalize_new_song(
                                        file_path, song_id,
                                        duration=metadata.get('duration'))
                                    if dup:
                                        song_id = dup[0]
                                        from models.library_access import LibraryAccessModel
                                        LibraryAccessModel.grant(
                                            session.get('user_id'), song_id,
                                            origin='import')
                                    else:
                                        from models.library_access import LibraryAccessModel
                                        LibraryAccessModel.grant(
                                            session.get('user_id'), song_id,
                                            origin='import')

                                        if song.get('cover_path') and metadata:
                                            SongModel.update_song_metadata(metadata['path'], {'cover_path': song['cover_path']})
                            
                            # Add to playlist if we have a song ID
                            if song_id:
                                PlaylistModel.add_song_to_playlist(created_playlist_id, song_id)
                                added_count += 1
                        except Exception as e:
                            print(f"Error adding song to playlist: {e}")
                            continue
                    
                    # Report DB progress (90% -> 100%)
                    current_percent = 90 + int(((i + 1) / total_songs) * 10)
                    yield json.dumps({
                        'type': 'progress',
                        'percent': min(current_percent, 99),
                        'message': f'Adding to library: {song.get("title", "Unknown")}'
                    }) + '\n'
                
                # Default behaviour: end the download with a generated mosaic cover.
                yield json.dumps({
                    'type': 'progress',
                    'percent': 99,
                    'message': 'Generating playlist cover...'
                }) + '\n'

                from utils.playlist_cover import generate_and_save_cover
                cover_path = generate_and_save_cover(
                    created_playlist_id, songs, music_path,
                    owner_user_id=session.get('user_id'))

                yield json.dumps({
                    'type': 'result',
                    'data': {
                        'success': True,
                        'playlist_name': playlist_name,
                        'playlist_id': created_playlist_id,
                        'song_count': added_count,
                        'cover_path': cover_path
                    }
                }) + '\n'
            else:
                yield json.dumps({
                    'type': 'error',
                    'error': result.get('error', 'Download failed')
                }) + '\n'

        return Response(stream_with_context(generate()), mimetype='application/x-ndjson')
    except Exception:
        return server_error()


def _spotify_match_score(track_title, track_artist, result):
    """Score a YouTube Music search result against a Spotify track."""
    def _tokens(s):
        return set((s or '').lower().split())

    title_score = 0.0
    rt = _tokens(result.get('title'))
    tt = _tokens(track_title)
    if rt and tt:
        title_score = len(rt & tt) / len(rt | tt)

    artist_score = 0.0
    ra = _tokens(result.get('artist'))
    ta = _tokens(track_artist)
    if ra and ta:
        artist_score = len(ra & ta) / len(ra | ta)

    return title_score + artist_score * 0.8


@music_bp.route('/spotify-import', methods=['POST'])
@require_auth
def spotify_import():
    """Import a single song from a Spotify track link."""
    try:
        from utils.spotify import SpotifyImporter
        from utils.metadata import MetadataSearcher
        from utils.youtube import YouTubeDownloader

        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400

        data = request.get_json()
        url = (data.get('url') or '').strip() if data else ''

        if not url:
            return jsonify({'error': 'No URL provided'}), 400

        importer = SpotifyImporter()
        track = importer.fetch_track(url)
        if not track.get('success'):
            return jsonify({'error': track.get('error', 'Failed to fetch Spotify track')}), 400

        title = track['title']
        artist = track['artist']

        searcher = MetadataSearcher()
        results = searcher.search(f'{title} {artist}', limit=5)
        if not results:
            return jsonify({'error': f'No YouTube Music match found for "{title}" by {artist}'}), 404

        best = max(results, key=lambda r: _spotify_match_score(title, artist, r))
        video_id = best.get('videoId')
        if not video_id:
            return jsonify({'error': 'No playable match found on YouTube Music'}), 404

        downloader = YouTubeDownloader(music_path)
        result = downloader.download(f'https://www.youtube.com/watch?v={video_id}')

        if not result.get('success'):
            return jsonify({'error': result.get('error', 'Download failed')}), 400

        if result.get('already_exists'):
            # Deduped download: enable the existing song on this account
            # instead of downloading a second copy.
            try:
                rel = os.path.relpath(result.get('file_path'), music_path)
                existing = SongModel.get_song_by_path(rel)
                if existing:
                    from models.library_access import LibraryAccessModel
                    LibraryAccessModel.grant(get_current_user_id(),
                                             existing['id'], origin='import')
            except Exception as e:  # noqa: BLE001
                print(f"[import] grant-on-existing failed: {e}")
            return jsonify({
                'success': True,
                'already_exists': True,
                'title': result.get('title') or title,
                'artist': result.get('artist') or artist,
                'message': result.get('message', 'Song already exists in library')
            })

        if result.get('file_path'):
            scanner = MusicScanner(music_path)
            metadata = scanner.scan_single_file(result['file_path'])
            if metadata and metadata.get('id'):
                # Cross-source dedupe: different file/encode of a song already
                # on the system → enable the existing song.
                from utils import dedupe
                dup = dedupe.finalize_new_song(
                    result['file_path'], metadata['id'],
                    duration=metadata.get('duration'))
                if dup:
                    existing_id, kind, score = dup
                    from models.library_access import LibraryAccessModel
                    LibraryAccessModel.grant(get_current_user_id(),
                                             existing_id, origin='import')
                    return jsonify({
                        'success': True,
                        'already_exists': True,
                        'title': result.get('title') or title,
                        'artist': result.get('artist') or artist,
                        'message': f'Song already exists in library '
                                   f'(matched by {kind}, {score:.0%} similar)'
                    })
                from models.library_access import LibraryAccessModel
                LibraryAccessModel.grant(get_current_user_id(),
                                         metadata['id'], origin='import')
            if result.get('cover_path') and metadata:
                SongModel.update_song_metadata(metadata['path'], {'cover_path': result['cover_path']})

        return jsonify({
            'success': True,
            'title': result.get('title') or title,
            'artist': result.get('artist') or artist
        })

    except Exception:
        return server_error()


@music_bp.route('/spotify-playlist-import', methods=['POST'])
@require_auth
def spotify_playlist_import():
    """Import a playlist from Spotify (Streaming response)."""
    try:
        from utils.spotify import SpotifyImporter
        from utils.metadata import MetadataSearcher
        from utils.youtube import YouTubeDownloader
        from models.playlist import PlaylistModel
        from flask import Response, stream_with_context
        import json

        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400

        data = request.get_json()
        url = (data.get('url') or '').strip() if data else ''

        if not url:
            return jsonify({'error': 'No URL provided'}), 400

        def generate():
            importer = SpotifyImporter()

            yield json.dumps({
                'type': 'progress', 'percent': 2,
                'message': 'Fetching playlist from Spotify...'
            }) + '\n'

            playlist_data = importer.fetch_playlist(url)
            if not playlist_data.get('success'):
                yield json.dumps({
                    'type': 'error',
                    'error': playlist_data.get('error', 'Failed to fetch Spotify playlist')
                }) + '\n'
                return

            playlist_name = playlist_data['name']
            tracks = playlist_data['tracks']
            total = len(tracks)

            searcher = MetadataSearcher()
            downloader = YouTubeDownloader(music_path)

            created_playlist_id = None
            try:
                created_playlist_id = _resolve_import_playlist(
                    PlaylistModel, playlist_name, data.get('conflict_mode'),
                    session.get('user_id')
                )
            except Exception as e:
                yield json.dumps({
                    'type': 'error',
                    'error': f'Failed to create playlist: {e}'
                }) + '\n'
                return

            added_count = 0
            failed_count = 0
            cover_songs = []

            for i, track in enumerate(tracks):
                title = track['title']
                artist = track['artist']
                percent = 5 + int((i / total) * 90)

                yield json.dumps({
                    'type': 'progress', 'percent': percent,
                    'message': f'[{i + 1}/{total}] Searching: {title} - {artist}'
                }) + '\n'

                try:
                    query = f'{title} {artist}'
                    results = searcher.search(query, limit=5)

                    if not results:
                        failed_count += 1
                        continue

                    best = max(results, key=lambda r: _spotify_match_score(title, artist, r))
                    video_id = best.get('videoId')
                    if not video_id:
                        failed_count += 1
                        continue

                    video_url = f'https://www.youtube.com/watch?v={video_id}'
                    song_result = downloader.download(video_url)

                    if not song_result.get('success') or not song_result.get('file_path'):
                        failed_count += 1
                        continue

                    song_id = None
                    file_path = song_result['file_path']

                    if song_result.get('already_exists'):
                        relative_path = os.path.relpath(file_path, music_path)
                        existing_song = SongModel.get_song_by_path(relative_path)
                        if existing_song:
                            song_id = existing_song['id']
                            # Deduped download: enable on the importer's
                            # account instead of storing a second file.
                            from models.library_access import LibraryAccessModel
                            LibraryAccessModel.grant(
                                session.get('user_id'), song_id,
                                origin='import')
                    else:
                        scanner = MusicScanner(music_path)
                        metadata = scanner.scan_single_file(file_path)
                        if metadata and metadata.get('id'):
                            song_id = metadata['id']
                            # Cross-source dedupe: reuse an existing song row
                            # (delete the redundant file) instead of a dupe.
                            from utils import dedupe
                            dup = dedupe.finalize_new_song(
                                file_path, song_id,
                                duration=metadata.get('duration'))
                            if dup:
                                song_id = dup[0]
                                from models.library_access import LibraryAccessModel
                                LibraryAccessModel.grant(
                                    session.get('user_id'), song_id,
                                    origin='import')
                            else:
                                from models.library_access import LibraryAccessModel
                                LibraryAccessModel.grant(
                                    session.get('user_id'), song_id,
                                    origin='import')
                                if song_result.get('cover_path') and metadata:
                                    SongModel.update_song_metadata(
                                        metadata['path'],
                                        {'cover_path': song_result['cover_path']}
                                    )

                    if song_id:
                        PlaylistModel.add_song_to_playlist(created_playlist_id, song_id)
                        added_count += 1
                        cover_songs.append({'cover_path': song_result.get('cover_path')})
                    else:
                        failed_count += 1

                except Exception as e:
                    print(f"Error importing Spotify track '{title}': {e}")
                    failed_count += 1
                    continue

            yield json.dumps({
                'type': 'progress', 'percent': 98,
                'message': 'Finalizing playlist...'
            }) + '\n'

            # Default behaviour: end the download with a generated mosaic cover.
            yield json.dumps({
                'type': 'progress', 'percent': 99,
                'message': 'Generating playlist cover...'
            }) + '\n'

            from utils.playlist_cover import generate_and_save_cover
            cover_path = generate_and_save_cover(
                created_playlist_id, cover_songs, music_path,
                owner_user_id=session.get('user_id'))

            yield json.dumps({
                'type': 'result',
                'data': {
                    'success': True,
                    'playlist_name': playlist_name,
                    'playlist_id': created_playlist_id,
                    'song_count': added_count,
                    'failed_count': failed_count,
                    'cover_path': cover_path,
                }
            }) + '\n'

        return Response(stream_with_context(generate()), mimetype='application/x-ndjson')
    except Exception:
        return server_error()


# ==================== Background Import Jobs ====================

def _serialize_job(job):
    """Convert an import_jobs row into a JSON-safe dict for the frontend."""
    import json as _json
    result = job.get('result')
    if isinstance(result, str) and result:
        try:
            result = _json.loads(result)
        except (ValueError, TypeError):
            pass

    def _ts(value):
        return value.isoformat() if value else None

    return {
        'id': job['id'],
        'source': job['source'],
        'kind': job['kind'],
        'url': job['url'],
        'status': job['status'],
        'progress': job.get('progress') or 0,
        'message': job.get('message'),
        'result': result,
        'error': job.get('error_message'),
        'created_at': _ts(job.get('created_at')),
        'started_at': _ts(job.get('started_at')),
        'completed_at': _ts(job.get('completed_at')),
    }


@music_bp.route('/import-jobs', methods=['POST'])
@require_auth
def enqueue_import_job():
    """Queue a YouTube/Spotify import to run in the background."""
    from flask import session
    from models.import_job import ImportJobModel
    from utils import job_worker

    data = request.get_json() or {}
    source = data.get('source')
    kind = data.get('kind')
    url = (data.get('url') or '').strip()
    conflict_mode = data.get('conflict_mode')

    if source not in ('youtube', 'spotify'):
        return jsonify({'error': 'Invalid source'}), 400
    if kind not in ('song', 'playlist'):
        return jsonify({'error': 'Invalid kind'}), 400
    if not url:
        return jsonify({'error': 'No URL provided'}), 400
    if conflict_mode not in (None, 'add', 'override', 'new'):
        return jsonify({'error': 'Invalid conflict_mode'}), 400

    job_id = ImportJobModel.enqueue(
        session.get('user_id'), source, kind, url, conflict_mode
    )
    job_worker.notify()  # wake the worker so it picks the job up immediately

    job = ImportJobModel.get(job_id)
    return jsonify({'success': True, 'job': _serialize_job(job)})


@music_bp.route('/import-jobs', methods=['GET'])
@require_auth
def list_import_jobs():
    """Return the live queue (queued + running) and recent history.

    Regular users see ONLY their own jobs; sysadmins see everything."""
    from models.import_job import ImportJobModel

    user_id = None if is_sysadmin() else get_current_user_id()

    active = ImportJobModel.active_jobs(user_id=user_id)
    history = ImportJobModel.list_recent(limit=25, user_id=user_id)

    return jsonify({
        'success': True,
        'queue': [_serialize_job(j) for j in active],
        'history': [_serialize_job(j) for j in history],
        'running': ImportJobModel.is_any_running(),
    })


@music_bp.route('/import-jobs/<int:job_id>', methods=['GET'])
@require_auth
def get_import_job(job_id):
    """Return a single job's current state (for polling)."""
    from models.import_job import ImportJobModel

    job = ImportJobModel.get(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404

    # Per-account isolation: only the owner (or a sysadmin) may see a job.
    if not is_sysadmin() and job.get('user_id') != get_current_user_id():
        return jsonify({'error': 'Job not found'}), 404

    return jsonify({'success': True, 'job': _serialize_job(job)})


@music_bp.route('/import-jobs/<int:job_id>', methods=['DELETE'])
@require_auth
def cancel_import_job(job_id):
    """Cancel a queued (not yet running) job — owners only (or sysadmins)."""
    from models.import_job import ImportJobModel

    job = ImportJobModel.get(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404

    if not is_sysadmin() and job.get('user_id') != get_current_user_id():
        return jsonify({'error': 'Forbidden'}), 403

    if job['status'] != 'queued':
        return jsonify({'error': f"Cannot cancel a job that is {job['status']}"}), 400

    cancelled = ImportJobModel.cancel(job_id)
    return jsonify({'success': cancelled})


# ==================== Song Metadata Enrichment ====================

def _serialize_enrichment_job(job):
    """Convert an enrichment_jobs row into a JSON-safe dict."""
    import json as _json
    result = job.get('result')
    if isinstance(result, str) and result:
        try:
            result = _json.loads(result)
        except (ValueError, TypeError):
            pass

    def _ts(value):
        return value.isoformat() if value else None

    return {
        'id': job['id'],
        'song_id': job.get('song_id'),
        'scope': job.get('scope'),
        'force': bool(job.get('force_full')),
        'status': job['status'],
        'progress': job.get('progress') or 0,
        'message': job.get('message'),
        'result': result,
        'error': job.get('error_message'),
        'created_at': _ts(job.get('created_at')),
        'started_at': _ts(job.get('started_at')),
        'completed_at': _ts(job.get('completed_at')),
    }


@music_bp.route('/songs/<int:song_id>/metadata', methods=['GET'])
@require_auth
@require_song_play_access
def get_song_metadata(song_id):
    """Return all enrichment metadata for a song (features, tags, similar artists)."""
    from models.song_metadata import SongMetadataModel

    data = SongMetadataModel.get_full(song_id)
    if not data:
        return jsonify({'error': 'Song not found'}), 404
    return jsonify({'success': True, 'metadata': data})


@music_bp.route('/songs/<int:song_id>/enrich', methods=['POST'])
@require_auth
def enrich_song(song_id):
    """Queue background enrichment for a single song.

    Body params:
        force: when true, redo audio analysis even if features already exist.
    """
    from models.database import Database
    from models.enrichment_job import EnrichmentJobModel
    from utils import enrichment_worker

    song = Database.execute_query(
        "SELECT id FROM songs WHERE id = %s", (song_id,), fetch_one=True,
    )
    if not song:
        return jsonify({'error': 'Song not found'}), 404

    # Per-account scoping: only songs the user can actually see may be
    # enriched from their account.
    from models.library_access import LibraryAccessModel
    if not LibraryAccessModel.has_access(get_current_user_id(), song_id):
        return jsonify({'error': 'Song not found'}), 404

    data = request.get_json(silent=True) or {}
    force = bool(data.get('force'))

    job_id = EnrichmentJobModel.enqueue_song(song_id, force=force)
    enrichment_worker.notify()

    job = EnrichmentJobModel.get(job_id)
    return jsonify({'success': True, 'job': _serialize_enrichment_job(job)})


@music_bp.route('/enrich/backfill', methods=['POST'])
@require_auth
def backfill_metadata():
    """Queue a library-wide metadata backfill.

    Body params:
        force: when false (default) only songs not yet analysed are processed;
               when true the whole library is re-analysed from scratch.
    """
    from models.enrichment_job import EnrichmentJobModel
    from utils import enrichment_worker

    data = request.get_json(silent=True) or {}
    denied = _forced_backfill_denied(data)
    if denied:
        return denied
    force = bool(data.get('force'))

    # Per-account scoping: a regular user's backfill covers their own visible
    # library; only sysadmins can enqueue a whole-library analysis.
    from models.library_access import LibraryAccessModel
    if is_sysadmin():
        song_ids = None
    else:
        song_ids = sorted(
            LibraryAccessModel.visible_song_ids(get_current_user_id()))

    job_id = EnrichmentJobModel.enqueue_backfill(force=force, song_ids=song_ids)
    enrichment_worker.notify()

    job = EnrichmentJobModel.get(job_id)
    return jsonify({'success': True, 'job': _serialize_enrichment_job(job)})


@music_bp.route('/enrich/status', methods=['GET'])
@require_auth
def enrichment_status():
    """Return the live queue, recent history and latest job (for polling)."""
    from models.enrichment_job import EnrichmentJobModel

    latest = EnrichmentJobModel.latest()
    queue = EnrichmentJobModel.active_jobs() or []
    history = EnrichmentJobModel.list_recent(limit=25) or []
    return jsonify({
        'success': True,
        'running': EnrichmentJobModel.is_any_running(),
        'job': _serialize_enrichment_job(latest) if latest else None,
        'queue': [_serialize_enrichment_job(j) for j in queue],
        'history': [_serialize_enrichment_job(j) for j in history],
    })


@music_bp.route('/artists/scrape-descriptions', methods=['POST'])
@require_sysadmin
def scrape_all_artist_descriptions():
    """Scrape descriptions for all artists missing one. Streams NDJSON progress."""
    from flask import Response, stream_with_context
    from models.database import Database
    from utils.metadata import MetadataSearcher
    import json

    def generate():
        try:
            all_songs = Database.execute_query("SELECT DISTINCT artist FROM songs", fetch_all=True)
            artist_names = set()
            for row in all_songs:
                raw = row.get('artist') or ''
                for name in raw.split(','):
                    name = name.strip()
                    if name and name != 'Unknown Artist':
                        artist_names.add(name)

            existing = Database.execute_query(
                "SELECT artist_name FROM artists_metadata WHERE description IS NOT NULL AND description != ''",
                fetch_all=True
            )
            already_done = {r['artist_name'] for r in existing}
            to_scrape = sorted(artist_names - already_done)
            total = len(to_scrape)

            yield json.dumps({'type': 'start', 'total': total}) + '\n'

            if total == 0:
                yield json.dumps({'type': 'done', 'scraped': 0, 'skipped': 0, 'failed': 0}) + '\n'
                return

            searcher = MetadataSearcher()
            scraped = 0
            failed = 0

            for i, name in enumerate(to_scrape):
                yield json.dumps({'type': 'progress', 'current': i + 1, 'total': total, 'artist': name}) + '\n'
                try:
                    candidates = searcher.search_artist_candidates(name, limit=1)
                    if candidates and candidates[0].get('description'):
                        c = candidates[0]
                        Database.execute_query(
                            """INSERT INTO artists_metadata (artist_name, description)
                               VALUES (%s, %s)
                               ON DUPLICATE KEY UPDATE description = VALUES(description)""",
                            (name, c['description'])
                        )
                        scraped += 1
                    else:
                        failed += 1
                except Exception:
                    failed += 1

            yield json.dumps({'type': 'done', 'scraped': scraped, 'skipped': len(already_done), 'failed': failed}) + '\n'
        except Exception as e:
            yield json.dumps({'type': 'error', 'error': str(e)}) + '\n'

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')


@music_bp.route('/download/<int:song_id>', methods=['GET'])
@require_auth
def download_song(song_id):
    """Download an audio file directly from the server."""
    try:
        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found'}), 404
        
        # Per-account isolation: only users who can see/hear the song may
        # download it (same rule as /stream — otherwise any logged-in user
        # could grab any file by id).
        from models.library_access import LibraryAccessModel
        if not LibraryAccessModel.has_access(get_current_user_id(), song_id):
            return jsonify({'error': 'Song not found'}), 404
        
        relative_path = song['file_path']
        full_path = os.path.normpath(os.path.join(music_path, relative_path))
        
        if not full_path.startswith(os.path.normpath(music_path)):
            return jsonify({'error': 'Invalid path'}), 403
        
        if not os.path.isfile(full_path):
            return jsonify({'error': 'File not found'}), 404
            
        filename = os.path.basename(full_path)
        return send_file(full_path, as_attachment=True, download_name=filename)
        
    except Exception:
        return server_error()


@music_bp.route('/discover/search', methods=['GET'])
@require_auth
def discover_search():
    """Search for songs on YouTube Music, flagging any already in the library."""
    try:
        query = request.args.get('q', '').strip()
        if not query:
            return jsonify([])

        from utils.metadata import MetadataSearcher
        from models.duplicates import _norm
        from models.database import Database

        searcher = MetadataSearcher()
        results = searcher.search(query)

        # Build a normalized title+artist -> song id lookup from the library so
        # the client can mark tracks that are already downloaded.
        lib_rows = Database.execute_query(
            "SELECT id, title, artist FROM songs", fetch_all=True)
        lib_index = {}
        for row in lib_rows:
            key = _norm(row.get('title')) + '||' + _norm(row.get('artist'))
            lib_index.setdefault(key, row['id'])

        for song in results:
            key = _norm(song.get('title')) + '||' + _norm(song.get('artist'))
            match_id = lib_index.get(key)
            song['in_library'] = match_id is not None
            song['library_song_id'] = match_id

        return jsonify(results)
    except Exception:
        return server_error()


@music_bp.route('/discover/preview/<video_id>', methods=['GET'])
@require_auth
def discover_preview(video_id):
    """Proxy the audio stream from YouTube for previewing.

    Supports HTTP Range requests so clients can seek. The extracted googlevideo
    URL is cached briefly so seeking doesn't re-run the (slow) yt-dlp
    extraction on every byte-range request.
    """
    import time
    from utils import ytdlp_manager as yt_dlp
    import requests
    from flask import Response, stream_with_context

    try:
        # --- Resolve the direct stream URL (cached per video for 5 minutes) ---
        cache = getattr(discover_preview, '_url_cache', None)
        if cache is None:
            cache = {}
            discover_preview._url_cache = cache

        entry = cache.get(video_id)
        now = time.time()
        if entry and entry['expires'] > now:
            stream_url = entry['url']
        else:
            url = f"https://www.youtube.com/watch?v={video_id}"
            ydl_opts = {
                'format': 'bestaudio/best',
                'quiet': True,
                'no_warnings': True,
            }
            stream_url = None
            last_error = None
            for attempt in range(1, 4):
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                        stream_url = info.get('url')
                    break
                except Exception as e:
                    last_error = str(e)
                    if attempt < 3:
                        delay = 2 * (2 ** (attempt - 1))
                        print(f"⚠️  YouTube preview extraction failed (attempt {attempt}/3): {last_error}")
                        time.sleep(delay)
                    else:
                        print(f"❌ YouTube preview extraction failed after 3 attempts: {last_error}")

            if not stream_url:
                return jsonify({'error': f'Failed to extract stream URL: {last_error}'}), 404

            # Cache for 5 minutes (googlevideo URLs last hours, but keep it fresh).
            cache[video_id] = {'url': stream_url, 'expires': now + 300}
            # Trim cache if it grows unbounded.
            if len(cache) > 200:
                for k in [k for k, v in cache.items() if v['expires'] <= now]:
                    cache.pop(k, None)

        # --- Proxy the (possibly ranged) request to googlevideo ---
        req_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
        if 'Range' in request.headers:
            req_headers['Range'] = request.headers['Range']

        r = requests.get(stream_url, headers=req_headers, stream=True, timeout=15)

        # If googlevideo rejected a stale cached URL, re-extract once and retry.
        if r.status_code >= 400 and 'Range' not in request.headers:
            cache.pop(video_id, None)
            try:
                with yt_dlp.YoutubeDL({'format': 'bestaudio/best', 'quiet': True, 'no_warnings': True}) as ydl:
                    stream_url = ydl.extract_info(
                        f"https://www.youtube.com/watch?v={video_id}",
                        download=False).get('url')
                if stream_url:
                    cache[video_id] = {'url': stream_url, 'expires': time.time() + 300}
                    r = requests.get(stream_url, headers=req_headers, stream=True, timeout=15)
            except Exception:
                pass

        res_headers = {}
        for h in ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']:
            if h in r.headers:
                res_headers[h] = r.headers[h]
        # Guarantee clients know they can seek.
        res_headers.setdefault('Accept-Ranges', 'bytes')

        def generate():
            for chunk in r.iter_content(chunk_size=8192):
                yield chunk

        return Response(
            stream_with_context(generate()),
            status=r.status_code,
            headers=res_headers
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return server_error()


@music_bp.route('/artists/<path:artist_name>', methods=['GET'])
@require_auth
def get_artist_metadata(artist_name):
    """Retrieve bio description and custom image URL for an artist."""
    try:
        from models.database import Database
        query = "SELECT description, image_url FROM artists_metadata WHERE artist_name = %s"
        result = Database.execute_query(query, (artist_name,), fetch_one=True)
        if result:
            return jsonify({
                'description': result.get('description') or '',
                'image_url': result.get('image_url') or ''
            })
        return jsonify({
            'description': '',
            'image_url': ''
        })
    except Exception:
        return server_error()


def _visible_songs(user_id):
    """(id, title, artist, album) of every song the user can see."""
    from models.library_access import LibraryAccessModel
    join_sql, join_params = LibraryAccessModel.access_join(user_id)
    return Database.execute_query(
        f"SELECT s.id, s.title, s.artist, s.album FROM songs s {join_sql} "
        "ORDER BY s.artist, s.album, s.track_number",
        join_params, fetch_all=True) or []


def _credits_artist(song, artist_name):
    target = artist_name.strip().lower()
    return any(a.strip().lower() == target
               for a in (song.get('artist') or '').split(','))


@music_bp.route('/artists/<path:artist_name>', methods=['POST'])
@require_auth
def update_artist_metadata(artist_name):
    """Save or update bio description and custom image URL for an artist.

    Artist profiles are shared by every account, so only a sysadmin or a
    user with one of the artist's songs in their library may edit one."""
    try:
        from models.database import Database
        data = request.get_json() or {}
        description = data.get('description', '').strip()
        image_url = data.get('image_url', '').strip()

        if image_url and not image_url.lower().startswith(('https://', 'http://')):
            return jsonify({'error': 'Image URL must start with http:// or https://'}), 400
        if not is_sysadmin() and not any(
                _credits_artist(song, artist_name)
                for song in _visible_songs(get_current_user_id())):
            return jsonify({'error': 'Artist not found in your library'}), 404

        # Insert or update using MySQL INSERT INTO ... ON DUPLICATE KEY UPDATE
        query = """
            INSERT INTO artists_metadata (artist_name, description, image_url)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE description = %s, image_url = %s
        """
        Database.execute_query(query, (artist_name, description, image_url, description, image_url))
        return jsonify({'success': True})
    except Exception:
        return server_error()


def _serialize_lightshow_job(job):
    """Convert a lightshow_jobs row into a JSON-safe dict."""
    import json as _json
    if not job:
        return None
    result = job.get('result')
    if isinstance(result, str) and result:
        try:
            result = _json.loads(result)
        except (ValueError, TypeError):
            pass

    def _ts(value):
        return value.isoformat() if value else None

    return {
        'id': job['id'],
        'song_id': job.get('song_id'),
        'scope': job.get('scope'),
        'force': bool(job.get('force_full')),
        'status': job['status'],
        'progress': job.get('progress') or 0,
        'message': job.get('message'),
        'result': result,
        'error': job.get('error_message'),
        'created_at': _ts(job.get('created_at')),
        'started_at': _ts(job.get('started_at')),
        'completed_at': _ts(job.get('completed_at')),
    }


@music_bp.route('/song/<int:song_id>/lightshow', methods=['GET'])
@require_auth
@require_song_play_access
def get_lightshow(song_id):
    """Return the song's light show score.

    Songs without an up-to-date score get an analysis job queued on the spot
    (so older libraries fill in lazily as people listen) and the response
    says it is pending; the player runs the live fallback meanwhile.
    """
    try:
        from models.lightshow_job import LightshowJobModel
        from utils import lightshow_worker
        from utils.lightshow_analyzer import ANALYZER_VERSION

        stored = LightshowJobModel.get_score(song_id)
        if stored and stored[0] >= ANALYZER_VERSION:
            return jsonify({'success': True, 'lightshow': stored[1]})
        if not SongModel.get_song_by_id(song_id):
            return jsonify({'error': 'Song not found'}), 404

        job = LightshowJobModel.song_job_state(song_id)
        # Don't loop on a song whose analysis already failed; the user can
        # retry explicitly from the song settings.
        if not job or job['status'] not in ('queued', 'running', 'failed'):
            lightshow_worker.enqueue_song(song_id)
            job = LightshowJobModel.song_job_state(song_id)
        return jsonify({
            'success': False,
            'pending': bool(job and job['status'] in ('queued', 'running')),
            'job': _serialize_lightshow_job(job),
        })
    except Exception:
        return server_error()


@music_bp.route('/song/<int:song_id>/lightshow/status', methods=['GET'])
@require_auth
@require_song_play_access
def get_lightshow_status(song_id):
    """Summary of a song's show (no envelopes) + its latest analysis job."""
    try:
        from models.lightshow_job import LightshowJobModel
        from utils.lightshow_analyzer import ANALYZER_VERSION

        stored = LightshowJobModel.get_score(song_id)
        summary = None
        if stored:
            version, data = stored
            summary = {
                'version': version,
                'current': version >= ANALYZER_VERSION,
                'duration': data.get('duration'),
                'tempo': data.get('tempo') or data.get('bpm'),
                'profile': data.get('profile'),
                'sections': data.get('sections') if version >= ANALYZER_VERSION else [],
                'events': data.get('events') if version >= ANALYZER_VERSION else [],
            }
        return jsonify({
            'success': True,
            'show': summary,
            'job': _serialize_lightshow_job(LightshowJobModel.song_job_state(song_id)),
        })
    except Exception:
        return server_error()


@music_bp.route('/song/<int:song_id>/lightshow/analyze', methods=['POST'])
@require_auth
@require_song_access
def analyze_lightshow(song_id):
    """Queue a (forced) light show re-analysis for one song."""
    try:
        from models.lightshow_job import LightshowJobModel
        from utils import lightshow_worker

        if not SongModel.get_song_by_id(song_id):
            return jsonify({'error': 'Song not found'}), 404
        job_id = LightshowJobModel.enqueue_song(song_id, force=True)
        lightshow_worker.notify()
        return jsonify({'success': True, 'job': _serialize_lightshow_job(LightshowJobModel.get(job_id))})
    except Exception:
        return server_error()


@music_bp.route('/song/<int:song_id>/lightshow', methods=['DELETE'])
@require_auth
@require_song_access
def delete_lightshow(song_id):
    """Remove the stored light show for a song."""
    try:
        from models.lightshow_job import LightshowJobModel
        LightshowJobModel.delete_score(song_id)
        return jsonify({'success': True})
    except Exception:
        return server_error()


def _forced_backfill_denied(data):
    """403 when a non-admin asks for a forced backfill, else None.

    Forcing re-analyses songs every account shares (the results are stored
    once per song) and is heavy, so it is reserved for sysadmins; a regular
    "Run" only fills in the user's songs that are missing data."""
    if data.get('force') and not is_sysadmin():
        return jsonify({'error': 'Only an administrator can force a re-analysis'}), 403
    return None


def _lightshow_scope_ids():
    """None for sysadmins (whole library), else the user's visible songs."""
    from models.library_access import LibraryAccessModel
    if is_sysadmin():
        return None
    return sorted(LibraryAccessModel.visible_song_ids(get_current_user_id()))


def _visible_jobs(jobs, scope_ids):
    """Drop per-song jobs (their messages name the song) for songs outside
    scope_ids; library-wide jobs stay. scope_ids None = everything."""
    jobs = jobs or []
    if scope_ids is None:
        return jobs
    visible = set(scope_ids)
    return [j for j in jobs
            if j.get('song_id') is None or j['song_id'] in visible]


@music_bp.route('/lightshow/backfill', methods=['POST'])
@require_auth
def backfill_lightshows():
    """Queue a library-wide light show analysis.

    Body params:
        force: false (default) = only songs without an up-to-date show;
               true = re-analyse everything.
    """
    try:
        from models.lightshow_job import LightshowJobModel
        from utils import lightshow_worker

        data = request.get_json(silent=True) or {}
        denied = _forced_backfill_denied(data)
        if denied:
            return denied
        job_id = LightshowJobModel.enqueue_backfill(
            force=bool(data.get('force')), song_ids=_lightshow_scope_ids())
        lightshow_worker.notify()
        return jsonify({'success': True, 'job': _serialize_lightshow_job(LightshowJobModel.get(job_id))})
    except Exception:
        return server_error()


@music_bp.route('/lightshow/jobs', methods=['GET'])
@require_auth
def lightshow_jobs():
    """Live queue, recent history and library coverage (for polling)."""
    try:
        from models.lightshow_job import LightshowJobModel

        scope = _lightshow_scope_ids()
        ready, total = LightshowJobModel.coverage(scope)
        return jsonify({
            'success': True,
            'coverage': {'ready': ready, 'total': total},
            'queue': [_serialize_lightshow_job(j) for j in _visible_jobs(LightshowJobModel.active_jobs(), scope)],
            'history': [_serialize_lightshow_job(j) for j in _visible_jobs(LightshowJobModel.list_recent(), scope)],
        })
    except Exception:
        return server_error()


@music_bp.route('/ytdlp/status', methods=['GET'])
@require_auth
def ytdlp_status():
    """Installed vs latest yt-dlp, JS runtime and last update result."""
    from utils import ytdlp_manager
    return jsonify({'success': True, 'ytdlp': ytdlp_manager.status()})


@music_bp.route('/ytdlp/update', methods=['POST'])
@require_sysadmin
def ytdlp_update():
    """Check PyPI and upgrade yt-dlp now (blocking, up to a few minutes)."""
    from utils import ytdlp_manager
    data = request.get_json(silent=True) or {}
    st = ytdlp_manager.check(force_update=bool(data.get('force')), reason='manual')
    last = st.get('last_update') or {}
    if last.get('error') and not last.get('ok'):
        return jsonify({'success': False, 'error': last['error'], 'ytdlp': st}), 500
    return jsonify({'success': True, 'ytdlp': st})


def _parse_lrc(lrc_text):
    """Parse an LRC string into a sorted list of {time, text} objects."""
    import re
    lines = []
    stamp_re = re.compile(r'\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]')
    for raw in (lrc_text or '').splitlines():
        stamps = stamp_re.findall(raw)
        if not stamps:
            continue
        text = stamp_re.sub('', raw).strip()
        for minutes, seconds, frac in stamps:
            t = int(minutes) * 60 + int(seconds)
            if frac:
                t += int((frac + '000')[:3]) / 1000.0
            lines.append((round(t, 3), text))
    lines.sort(key=lambda item: item[0])
    return [{'time': t, 'text': txt} for t, txt in lines]


import re as _re

_LRCLIB_HEADERS = {
    'User-Agent': 'Rainy Music Player (https://github.com/Ferripro321/Rainy)'
}
_LRCLIB_BASE = 'https://lrclib.net/api'

# Title: strip bracketed tags and trailing "feat." clauses
_LRCLIB_BRACKETS = _re.compile(r'[\(\[].*?[\)\]]')
_LRCLIB_FEAT = _re.compile(r'\s+(?:feat\.?|ft\.?|featuring)\b.*', _re.I)
_LRCLIB_WS = _re.compile(r'\s+')
# Artist: split on the separators people actually use between co-artists
_LRCLIB_ARTIST_SPLIT = _re.compile(
    r'\s*(?:,|&|;|/|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing)\s*', _re.I)
# Artist: strip channel/brand suffixes per segment
_LRCLIB_ARTIST_SUFFIX = _re.compile(
    r'\s*[-–]\s*(?:topic|vevo|official(?:\s+(?:video|audio|channel))?)\s*$', _re.I)


def _clean_title(title):
    if not title:
        return ''
    t = _LRCLIB_BRACKETS.sub(' ', title)
    t = _LRCLIB_FEAT.sub('', t)
    return _LRCLIB_WS.sub(' ', t).strip()


def _artist_segments(artist):
    if not artist:
        return []
    out = []
    for part in _LRCLIB_ARTIST_SPLIT.split(artist):
        part = _LRCLIB_ARTIST_SUFFIX.sub('', part)
        part = _LRCLIB_BRACKETS.sub('', part)
        part = _LRCLIB_WS.sub(' ', part).strip()
        if part:
            out.append(part)
    return out


def _primary_artist(artist):
    segs = _artist_segments(artist)
    return segs[0] if segs else (artist or '').strip()


def _token_similarity(a, b):
    a = (a or '').lower().split()
    b = (b or '').lower().split()
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    return len(sa & sb) / len(sa | sb)


def _score_record(record, title, artist, duration):
    score = 0.0
    rec_dur = record.get('duration') or 0
    if duration and rec_dur:
        score += max(0.0, 1.0 - abs(rec_dur - duration) / 30.0)
    score += _token_similarity(record.get('trackName'), title)
    score += _token_similarity(record.get('artistName'), artist) * 0.8
    if record.get('syncedLyrics'):
        score += 0.5
    return score


def _fetch_lyrics_from_lrclib(title, artist, album, duration):
    """Query LRCLIB for lyrics using a laddered, normalized search with scoring.

    Returns (synced_list, plain_text) or (None, None).
    """
    import requests

    raw_title = (title or '').strip()
    raw_artist = (artist or '').strip()
    clean_title = _clean_title(raw_title) or raw_title
    primary = _primary_artist(raw_artist) or raw_artist

    attempts = []

    def add(method, params):
        key = (method, tuple(sorted(params.items())))
        if not params.get('track_name') and not params.get('q'):
            return
        if key not in seen:
            seen.add(key)
            attempts.append((method, params))

    seen = set()

    get_params = {'track_name': clean_title, 'artist_name': primary}
    if album and album not in ('Unknown Album', ''):
        get_params['album_name'] = album
    if duration:
        get_params['duration'] = int(duration)
    add('get', get_params)
    add('get', {'track_name': raw_title, 'artist_name': raw_artist,
                **({'duration': int(duration)} if duration else {})})

    add('search', {'track_name': clean_title, 'artist_name': primary})
    add('search', {'track_name': raw_title, 'artist_name': raw_artist})
    add('search', {'q': f'{clean_title} {primary}'.strip()})
    add('search', {'q': f'{clean_title} - {primary}'.strip()})
    add('search', {'q': f'{primary} {clean_title}'.strip()})
    add('search', {'q': f'{raw_artist} {raw_title}'.strip()})

    best = None
    best_score = -1.0
    for method, params in attempts:
        try:
            resp = requests.get(
                f'{_LRCLIB_BASE}/{method}', params=params,
                headers=_LRCLIB_HEADERS, timeout=10)
        except Exception:
            continue
        if resp.status_code != 200:
            continue
        try:
            data = resp.json()
        except Exception:
            continue

        candidates = []
        if method == 'get':
            if isinstance(data, dict) and data.get('id'):
                candidates = [data]
        elif isinstance(data, list):
            candidates = data

        for record in candidates:
            if not record:
                continue
            if not (record.get('syncedLyrics') or record.get('plainLyrics')):
                continue
            sc = _score_record(record, clean_title, primary, duration)
            if sc > best_score:
                best_score = sc
                best = record

        if best_score >= 2.5:
            break

    if not best:
        return None, None

    synced = _parse_lrc(best.get('syncedLyrics'))
    plain = (best.get('plainLyrics') or '').strip()
    if not synced and not plain:
        return None, None
    return synced, plain


_LRC_STAMPS = _re.compile(r'\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]')


def _lyrics_snippet(record, max_lines=4):
    """First few non-empty lines of a record's lyrics, timestamps stripped."""
    text = record.get('plainLyrics') or record.get('syncedLyrics') or ''
    lines = []
    for raw in text.splitlines():
        line = _LRC_STAMPS.sub('', raw).strip()
        if line:
            lines.append(line)
        if len(lines) >= max_lines:
            break
    return '\n'.join(lines)


def _search_lyrics_candidates(query):
    """Search LRCLIB for lyrics matching a free-text query.

    Returns a deduplicated list of candidate dicts, synced-first and ranked by
    similarity to the query.
    """
    import requests

    query = (query or '').strip()
    if not query:
        return []

    seen = set()
    records = []
    attempts = [{'q': query}, {'track_name': query}]
    for params in attempts:
        try:
            resp = requests.get(
                f'{_LRCLIB_BASE}/search', params=params,
                headers=_LRCLIB_HEADERS, timeout=10)
        except Exception:
            continue
        if resp.status_code != 200:
            continue
        try:
            data = resp.json()
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for record in data:
            if not record or not record.get('id'):
                continue
            if not (record.get('syncedLyrics') or record.get('plainLyrics')):
                continue
            if record['id'] in seen:
                continue
            seen.add(record['id'])
            records.append(record)

    def rank(record):
        name = f"{record.get('trackName') or ''} {record.get('artistName') or ''}"
        return (1 if record.get('syncedLyrics') else 0,
                _token_similarity(name, query))

    records.sort(key=rank, reverse=True)
    return [
        {
            'id': record['id'],
            'title': record.get('trackName') or '',
            'artist': record.get('artistName') or '',
            'album': record.get('albumName') or '',
            'duration': record.get('duration') or 0,
            'synced': bool(record.get('syncedLyrics')),
            'snippet': _lyrics_snippet(record),
        }
        for record in records[:15]
    ]


@music_bp.route('/lyrics/search', methods=['POST'])
@require_auth
def search_lyrics():
    """Search LRCLIB for lyrics candidates so the user can pick one manually."""
    try:
        body = request.get_json(silent=True) or {}
        query = (body.get('query') or '').strip()
        if not query:
            return jsonify({'error': 'Missing search query'}), 400

        results = _search_lyrics_candidates(query)
        return jsonify({'success': True, 'results': results})
    except Exception:
        return server_error()


def _queue_word_sync(song_id):
    """Queue a word-timing alignment for lyrics that were just added or replaced."""
    from utils import lyrics_worker
    lyrics_worker.enqueue_song(song_id)


@music_bp.route('/song/<int:song_id>/lyrics', methods=['GET'])
@require_auth
@require_song_play_access
def get_lyrics(song_id):
    """Return cached lyrics for a song (cache-only by default).

    By default this never contacts LRCLIB — it only reads the cache, so opening
    the lyrics panel is always instant. A 404 carries a `state` so the UI can
    distinguish "never fetched" (show a Fetch button) from "fetched, none on
    LRCLIB" (show a Retry). Pass ?refresh=1 to force a fetch + cache (the
    individual Fetch / Retry actions).
    """
    try:
        from models.database import Database
        import json

        refresh = request.args.get('refresh') == '1'

        if not refresh:
            cached = Database.execute_query(
                "SELECT found, synced, plain FROM song_lyrics WHERE song_id = %s",
                (song_id,), fetch_one=True)
            if cached and cached.get('found'):
                return jsonify({
                    'success': True,
                    'lyrics': {
                        'synced': json.loads(cached['synced']) if cached.get('synced') else [],
                        'plain': cached.get('plain') or '',
                    }
                })
            # Cache-only: report why there's nothing, without fetching.
            state = 'not_found' if cached else 'not_fetched'
            msg = ('No lyrics found for this song' if state == 'not_found'
                   else 'Lyrics have not been fetched for this song')
            return jsonify({'error': msg, 'state': state}), 404

        # Forced fetch (individual Fetch / Retry button).
        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found', 'state': 'not_found'}), 404

        synced, plain = _fetch_lyrics_from_lrclib(
            song.get('title'), song.get('artist'),
            song.get('album'), song.get('duration'))

        found = 1 if (synced or plain) else 0
        synced_json = json.dumps(synced) if synced else None
        plain_text = plain or None
        Database.execute_query(
            """INSERT INTO song_lyrics (song_id, found, synced, plain)
               VALUES (%s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE found = %s, synced = %s, plain = %s""",
            (song_id, found, synced_json, plain_text,
             found, synced_json, plain_text))
        # Word timings were aligned against the previous lyrics — drop them.
        Database.execute_query("DELETE FROM song_lyrics_words WHERE song_id = %s", (song_id,))
        if synced:
            _queue_word_sync(song_id)

        if not found:
            return jsonify({'error': 'No lyrics found for this song', 'state': 'not_found'}), 404

        return jsonify({
            'success': True,
            'lyrics': {'synced': synced or [], 'plain': plain or ''}
        })
    except Exception:
        return server_error()


@music_bp.route('/song/<int:song_id>/lyrics', methods=['DELETE'])
@require_auth
@require_song_access
def delete_lyrics(song_id):
    """Clear cached lyrics so they can be re-fetched."""
    try:
        from models.database import Database
        Database.execute_query("DELETE FROM song_lyrics WHERE song_id = %s", (song_id,))
        Database.execute_query("DELETE FROM song_lyrics_words WHERE song_id = %s", (song_id,))
        return jsonify({'success': True})
    except Exception:
        return server_error()


@music_bp.route('/song/<int:song_id>/lyrics', methods=['POST'])
@require_auth
@require_song_access
def apply_lyrics(song_id):
    """Manually apply a specific LRCLIB record as this song's lyrics."""
    try:
        from models.database import Database
        import json
        import requests

        body = request.get_json(silent=True) or {}
        lrclib_id = body.get('lrclib_id')
        if not lrclib_id:
            return jsonify({'error': 'Missing lrclib_id'}), 400

        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        try:
            resp = requests.get(
                f'{_LRCLIB_BASE}/get/{int(lrclib_id)}',
                headers=_LRCLIB_HEADERS, timeout=10)
        except Exception:
            return jsonify({'error': 'Could not reach LRCLIB'}), 502
        if resp.status_code != 200:
            return jsonify({'error': 'Lyrics record not found on LRCLIB'}), 404

        try:
            record = resp.json()
        except Exception:
            return jsonify({'error': 'Invalid response from LRCLIB'}), 502

        synced = _parse_lrc(record.get('syncedLyrics'))
        plain = (record.get('plainLyrics') or '').strip()
        if not synced and not plain:
            return jsonify({'error': 'That record has no lyrics'}), 404

        synced_json = json.dumps(synced) if synced else None
        plain_text = plain or None
        Database.execute_query(
            """INSERT INTO song_lyrics (song_id, found, synced, plain)
               VALUES (%s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE found = %s, synced = %s, plain = %s""",
            (song_id, 1, synced_json, plain_text, 1, synced_json, plain_text))
        # Word timings were aligned against the previous lyrics — drop them.
        Database.execute_query("DELETE FROM song_lyrics_words WHERE song_id = %s", (song_id,))
        if synced:
            _queue_word_sync(song_id)

        return jsonify({
            'success': True,
            'lyrics': {'synced': synced or [], 'plain': plain or ''}
        })
    except Exception:
        return server_error()


@music_bp.route('/song/<int:song_id>/lyrics-words', methods=['GET'])
@require_auth
@require_song_play_access
def get_lyrics_words(song_id):
    """Return a song's aligned word timings.

    Songs without current timings get an analysis job queued on the spot (so
    a library fills in lazily as people open lyrics) and the response says it
    is pending; the player estimates word timing meanwhile and re-checks.
    """
    try:
        from models.lyrics_job import LyricsJobModel
        from utils import lyrics_worker
        from utils.lyrics_align import ALIGN_VERSION

        stored = LyricsJobModel.get_words(song_id)
        if stored and stored[0] >= ALIGN_VERSION:
            return jsonify({'success': True, 'words': stored[1], 'language': stored[2]})

        if not SongModel.get_song_by_id(song_id):
            return jsonify({'error': 'Song not found'}), 404
        lyr = LyricsJobModel.get_lyrics(song_id)
        if not lyr or not lyr.get('found') or not lyr.get('synced'):
            return jsonify({'error': 'No synced lyrics to align', 'pending': False}), 404

        job = LyricsJobModel.song_job_state(song_id)
        # Don't loop on a song whose analysis already failed — unless its
        # lyrics were replaced since; the user can also retry explicitly.
        lyrics_changed = bool(
            job and job['status'] == 'failed' and lyr.get('updated_at') and job.get('completed_at')
            and lyr['updated_at'] > job['completed_at'])
        if not job or job['status'] not in ('queued', 'running', 'failed') or lyrics_changed:
            lyrics_worker.enqueue_song(song_id)
            job = LyricsJobModel.song_job_state(song_id)
        return jsonify({
            'success': False,
            'pending': bool(job and job['status'] in ('queued', 'running')),
            'job': _serialize_lightshow_job(job),
        })
    except Exception:
        return server_error()


@music_bp.route('/song/<int:song_id>/lyrics-words/analyze', methods=['POST'])
@require_auth
@require_song_access
def analyze_lyrics_words(song_id):
    """Queue a forced lyrics re-alignment for one song."""
    try:
        from models.lyrics_job import LyricsJobModel
        from utils import lyrics_worker

        if not SongModel.get_song_by_id(song_id):
            return jsonify({'error': 'Song not found'}), 404
        job_id = LyricsJobModel.enqueue_song(song_id, force=True)
        lyrics_worker.notify()
        return jsonify({'success': True, 'job': _serialize_lightshow_job(LyricsJobModel.get(job_id))})
    except Exception:
        return server_error()


@music_bp.route('/lyrics/backfill', methods=['POST'])
@require_auth
def backfill_lyrics():
    """Queue a library-wide lyrics analysis (fetch missing lyrics + align words).

    Body params:
        force: false (default) = only songs that still need it;
               true = re-align every song that has synced lyrics.
    """
    try:
        from models.lyrics_job import LyricsJobModel
        from utils import lyrics_worker

        data = request.get_json(silent=True) or {}
        denied = _forced_backfill_denied(data)
        if denied:
            return denied
        job_id = LyricsJobModel.enqueue_backfill(
            force=bool(data.get('force')), song_ids=_lightshow_scope_ids())
        lyrics_worker.notify()
        return jsonify({'success': True, 'job': _serialize_lightshow_job(LyricsJobModel.get(job_id))})
    except Exception:
        return server_error()


@music_bp.route('/lyrics/jobs', methods=['GET'])
@require_auth
def lyrics_jobs():
    """Live queue, recent history and library coverage (for polling)."""
    try:
        from models.lyrics_job import LyricsJobModel

        scope = _lightshow_scope_ids()
        return jsonify({
            'success': True,
            'coverage': LyricsJobModel.coverage(scope),
            'queue': [_serialize_lightshow_job(j) for j in _visible_jobs(LyricsJobModel.active_jobs(), scope)],
            'history': [_serialize_lightshow_job(j) for j in _visible_jobs(LyricsJobModel.list_recent(), scope)],
        })
    except Exception:
        return server_error()


@music_bp.route('/artists/<path:artist_name>/scrape', methods=['POST'])
@require_auth
def scrape_artist_info(artist_name):
    """Fetch candidate artist bios/images from YouTube Music."""
    try:
        from utils.metadata import MetadataSearcher
        candidates = MetadataSearcher().search_artist_candidates(artist_name, limit=5)
        if not candidates:
            return jsonify({'success': False, 'error': 'No YouTube Music results found for this artist'}), 404
        return jsonify({'success': True, 'candidates': candidates})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@music_bp.route('/artists/scrape-all', methods=['POST'])
@require_sysadmin
def scrape_all_artists():
    """Scrape images for all artists missing one. Streams NDJSON progress."""
    from flask import Response, stream_with_context
    from models.database import Database
    from utils.metadata import MetadataSearcher
    import json

    def generate():
        try:
            all_songs = Database.execute_query("SELECT DISTINCT artist FROM songs", fetch_all=True)
            artist_names = set()
            for row in all_songs:
                raw = row.get('artist') or ''
                for name in raw.split(','):
                    name = name.strip()
                    if name and name != 'Unknown Artist':
                        artist_names.add(name)

            existing = Database.execute_query(
                "SELECT artist_name FROM artists_metadata WHERE image_url IS NOT NULL AND image_url != ''",
                fetch_all=True
            )
            already_done = {r['artist_name'] for r in existing}
            to_scrape = sorted(artist_names - already_done)
            total = len(to_scrape)

            yield json.dumps({'type': 'start', 'total': total}) + '\n'

            if total == 0:
                yield json.dumps({'type': 'done', 'scraped': 0, 'skipped': 0, 'failed': 0}) + '\n'
                return

            searcher = MetadataSearcher()
            scraped = 0
            failed = 0

            for i, name in enumerate(to_scrape):
                yield json.dumps({'type': 'progress', 'current': i + 1, 'total': total, 'artist': name}) + '\n'
                try:
                    candidates = searcher.search_artist_candidates(name, limit=1)
                    if candidates and candidates[0].get('image_url'):
                        c = candidates[0]
                        Database.execute_query(
                            """INSERT INTO artists_metadata (artist_name, description, image_url)
                               VALUES (%s, %s, %s)
                               ON DUPLICATE KEY UPDATE image_url = VALUES(image_url),
                               description = CASE WHEN description IS NULL OR description = '' THEN VALUES(description) ELSE description END""",
                            (name, c.get('description', ''), c['image_url'])
                        )
                        scraped += 1
                    else:
                        failed += 1
                except Exception:
                    failed += 1

            yield json.dumps({'type': 'done', 'scraped': scraped, 'skipped': len(already_done), 'failed': failed}) + '\n'
        except Exception as e:
            yield json.dumps({'type': 'error', 'error': str(e)}) + '\n'

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')


@music_bp.route('/artists/<path:artist_name>/songs', methods=['GET'])
@require_auth
def get_artist_songs(artist_name):
    """Get the user's songs and flag which ones have this artist credited."""
    try:
        songs_out = [{
            'id': s['id'],
            'title': s['title'],
            'artist': s['artist'],
            'album': s.get('album') or '',
            'has_artist': _credits_artist(s, artist_name),
        } for s in _visible_songs(get_current_user_id())]

        return jsonify({'success': True, 'songs': songs_out})
    except Exception:
        return server_error()


@music_bp.route('/artists/<path:artist_name>/songs/<int:song_id>', methods=['POST'])
@require_auth
@require_song_access
def toggle_artist_on_song(artist_name, song_id):
    """Add or remove an artist credit from a song's artist field."""
    try:
        from models.database import Database
        data = request.get_json() or {}
        action = data.get('action')  # 'add' or 'remove'

        song = Database.execute_query("SELECT id, artist FROM songs WHERE id = %s", (song_id,), fetch_one=True)
        if not song:
            return jsonify({'error': 'Song not found'}), 404

        raw = song.get('artist') or ''
        artists = [a.strip() for a in raw.split(',') if a.strip()]
        target = artist_name.strip().lower()

        if action == 'add':
            if not any(a.lower() == target for a in artists):
                artists.append(artist_name.strip())
        elif action == 'remove':
            artists = [a for a in artists if a.lower() != target]
        else:
            return jsonify({'error': 'Invalid action; use "add" or "remove"'}), 400

        new_artist_str = ', '.join(artists) if artists else 'Unknown Artist'
        Database.execute_query("UPDATE songs SET artist = %s WHERE id = %s", (new_artist_str, song_id))
        return jsonify({'success': True, 'new_artist': new_artist_str})
    except Exception:
        return server_error()

def _duplicate_groups():
    """Duplicate groups the caller can see, each flagged with can_merge.

    Sysadmins see and may merge every group. Other accounts see duplicates
    among their own songs and may merge a group only when every copy is
    theirs alone (a merge deletes the other copies for everyone)."""
    from models.duplicates import DuplicateModel
    from models.library_access import LibraryAccessModel
    groups = DuplicateModel.find_groups()
    if is_sysadmin():
        return [{**g, 'can_merge': True} for g in groups]
    user_id = get_current_user_id()
    visible = LibraryAccessModel.visible_song_ids(user_id)
    groups = [g for g in (
        {**g, 'songs': [s for s in g['songs'] if s['id'] in visible]}
        for g in groups) if len(g['songs']) > 1]
    exclusive = LibraryAccessModel.exclusive_song_ids(
        user_id, [s['id'] for g in groups for s in g['songs']])
    return [{**g, 'can_merge': all(s['id'] in exclusive for s in g['songs'])}
            for g in groups]


@music_bp.route('/duplicates', methods=['GET'])
@require_auth
def get_duplicates():
    """Find groups of duplicate songs in the caller's library."""
    try:
        groups = _duplicate_groups()
        total_dupes = sum(len(g['songs']) - 1 for g in groups)
        return jsonify({
            'success': True,
            'groups': groups,
            'group_count': len(groups),
            'duplicate_count': total_dupes,
        })
    except Exception:
        return server_error()


@music_bp.route('/duplicates/merge', methods=['POST'])
@require_auth
def merge_duplicates():
    """Merge a group of duplicate songs into one keeper.

    Body: { song_ids: [..], keeper_id?: int }
    """
    try:
        from models.duplicates import DuplicateModel
        from models.library_access import LibraryAccessModel
        data = request.get_json(silent=True) or {}
        try:
            song_ids = [int(i) for i in (data.get('song_ids') or [])]
        except (TypeError, ValueError):
            return jsonify({'error': 'Invalid song_ids'}), 400
        if not is_sysadmin() and LibraryAccessModel.exclusive_song_ids(
                get_current_user_id(), song_ids) != set(song_ids):
            return jsonify({'error': 'Only an administrator can merge songs '
                                     'other accounts share'}), 403
        result = DuplicateModel.merge_group(song_ids, keeper_id=data.get('keeper_id'))
        if not result.get('success'):
            return jsonify(result), 400
        _remove_song_files(result.pop('removed_files'))
        return jsonify(result)
    except Exception:
        return server_error()


@music_bp.route('/artists/fix', methods=['POST'])
@require_sysadmin
def fix_artist_metadata():
    """Fix duplicate artist names in existing songs (e.g. 'A, A, A' -> 'A')."""
    try:
        from models.song import SongModel
        fixed = SongModel.fix_artist_duplicates()
        return jsonify({'success': True, 'fixed': fixed})
    except Exception:
        return server_error()


@music_bp.route('/duplicates/merge-all', methods=['POST'])
@require_auth
def merge_all_duplicates():
    """Auto-merge every group the caller may merge, keeping the best
    candidate in each."""
    try:
        from models.duplicates import DuplicateModel
        groups = [g for g in _duplicate_groups() if g['can_merge']]
        merged = 0
        removed = 0
        for g in groups:
            ids = [s['id'] for s in g['songs']]
            try:
                res = DuplicateModel.merge_group(ids)
                if res.get('success'):
                    merged += 1
                    removed += res.get('removed_count', 0)
                    _remove_song_files(res['removed_files'])
            except Exception as e:
                print(f"merge group failed: {e}")
                continue
        return jsonify({
            'success': True,
            'groups_merged': merged,
            'songs_removed': removed,
        })
    except Exception:
        return server_error()
