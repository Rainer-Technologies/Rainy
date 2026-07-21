from flask import Blueprint, jsonify, session, send_file, request
from models.settings import SettingsModel
from models.song import SongModel, ScanHistoryModel
from utils.scanner import MusicScanner
from routes.auth import require_auth
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
        
        # Get all songs
        all_songs = SongModel.get_all_songs()
        
        # If database is empty, suggest running a scan
        if not all_songs:
            return jsonify({
                'success': True,
                'sections': [],
                'all_songs': [],
                'total': 0,
                'message': 'Library is empty. Run a scan to populate the library.'
            })
        
        # Get recently added songs (last 20)
        recently_added = SongModel.get_recently_added(20)
        
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
            'total': len(all_songs)
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


@music_bp.route('/song/<int:song_id>', methods=['DELETE'])
@require_auth
def delete_song(song_id):
    """Delete a song from the database and disk."""
    try:
        music_path = SettingsModel.get_music_path()
        
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
        
        # Check if song exists in database
        song = SongModel.get_song_by_id(song_id)
        if not song:
            return jsonify({'error': 'Song not found'}), 404
        
        file_path = song['file_path']
        cover_path = song.get('cover_path')
        
        # Delete song file from disk
        full_song_path = os.path.normpath(os.path.join(music_path, file_path))
        if full_song_path.startswith(os.path.normpath(music_path)) and os.path.isfile(full_song_path):
            os.remove(full_song_path)
        
        # Delete cover image if it exists
        if cover_path:
            full_cover_path = os.path.normpath(os.path.join(music_path, cover_path))
            if full_cover_path.startswith(os.path.normpath(music_path)) and os.path.isfile(full_cover_path):
                os.remove(full_cover_path)
        
        # Delete from database
        SongModel.delete_song_by_id(song_id)
        
        return jsonify({
            'success': True,
            'message': 'Song removed from library and disk'
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
            '.wma': 'audio/x-ms-wma'
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
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/info/<int:song_id>', methods=['GET'])
@require_auth
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
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        
        relative_path = song['file_path']
        
        # Prepare metadata update
        metadata = {}
        
        if data.get('title'):
            metadata['title'] = data['title']
        if data.get('artist'):
            metadata['artist'] = data['artist']
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
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        allowed_extensions = {'.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.wma'}
        
        uploaded = 0
        errors = []
        
        for file in files:
            if file.filename:
                ext = os.path.splitext(file.filename)[1].lower()
                if ext in allowed_extensions:
                    # Save file to music library root
                    safe_filename = os.path.basename(file.filename)
                    save_path = os.path.join(music_path, safe_filename)
                    
                    # Handle duplicate filenames
                    if os.path.exists(save_path):
                        base, ext = os.path.splitext(safe_filename)
                        counter = 1
                        while os.path.exists(save_path):
                            save_path = os.path.join(music_path, f"{base}_{counter}{ext}")
                            counter += 1
                    
                    file.save(save_path)
                    
                    # Add to database with metadata extraction
                    scanner = MusicScanner(music_path)
                    scanner.scan_single_file(save_path)
                    uploaded += 1
                else:
                    errors.append(f"Invalid file type: {file.filename}")
        
        return jsonify({
            'success': True,
            'uploaded': uploaded,
            'errors': errors if errors else None
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
                    created_playlist_id = PlaylistModel.create_playlist(playlist_name)
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
                            else:
                                # New song - add to database
                                scanner = MusicScanner(music_path)
                                metadata = scanner.scan_single_file(file_path)
                                
                                if metadata and metadata.get('id'):
                                    song_id = metadata['id']
                                    
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
                
                yield json.dumps({
                    'type': 'result',
                    'data': {
                        'success': True,
                        'playlist_name': playlist_name,
                        'playlist_id': created_playlist_id,
                        'song_count': added_count
                    }
                }) + '\n'
            else:
                yield json.dumps({
                    'type': 'error',
                    'error': result.get('error', 'Download failed')
                }) + '\n'

        return Response(stream_with_context(generate()), mimetype='application/x-ndjson')
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
            if result.get('cover_path') and metadata:
                SongModel.update_song_metadata(metadata['path'], {'cover_path': result['cover_path']})

        return jsonify({
            'success': True,
            'title': result.get('title') or title,
            'artist': result.get('artist') or artist
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
                created_playlist_id = PlaylistModel.create_playlist(playlist_name)
            except Exception as e:
                yield json.dumps({
                    'type': 'error',
                    'error': f'Failed to create playlist: {e}'
                }) + '\n'
                return

            added_count = 0
            failed_count = 0

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
                    else:
                        scanner = MusicScanner(music_path)
                        metadata = scanner.scan_single_file(file_path)
                        if metadata and metadata.get('id'):
                            song_id = metadata['id']
                            if song_result.get('cover_path') and metadata:
                                SongModel.update_song_metadata(
                                    metadata['path'],
                                    {'cover_path': song_result['cover_path']}
                                )

                    if song_id:
                        PlaylistModel.add_song_to_playlist(created_playlist_id, song_id)
                        added_count += 1
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

            yield json.dumps({
                'type': 'result',
                'data': {
                    'success': True,
                    'playlist_name': playlist_name,
                    'playlist_id': created_playlist_id,
                    'song_count': added_count,
                    'failed_count': failed_count,
                }
            }) + '\n'

        return Response(stream_with_context(generate()), mimetype='application/x-ndjson')
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/artists/scrape-descriptions', methods=['POST'])
@require_auth
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
        
        relative_path = song['file_path']
        full_path = os.path.normpath(os.path.join(music_path, relative_path))
        
        if not full_path.startswith(os.path.normpath(music_path)):
            return jsonify({'error': 'Invalid path'}), 403
        
        if not os.path.isfile(full_path):
            return jsonify({'error': 'File not found'}), 404
            
        filename = os.path.basename(full_path)
        return send_file(full_path, as_attachment=True, download_name=filename)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/discover/search', methods=['GET'])
@require_auth
def discover_search():
    """Search for songs on YouTube Music."""
    try:
        query = request.args.get('q', '').strip()
        if not query:
            return jsonify([])
            
        from utils.metadata import MetadataSearcher
        searcher = MetadataSearcher()
        results = searcher.search(query)
        return jsonify(results)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/discover/preview/<video_id>', methods=['GET'])
@require_auth
def discover_preview(video_id):
    """Proxy the audio stream from YouTube for previewing."""
    try:
        import yt_dlp
        import requests
        from flask import Response, stream_with_context
        
        url = f"https://www.youtube.com/watch?v={video_id}"
        ydl_opts = {
            'format': 'bestaudio/best',
            'quiet': True,
            'no_warnings': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            stream_url = info.get('url')
            
        if not stream_url:
            return jsonify({'error': 'Failed to extract stream URL'}), 404
            
        # Set request headers for streaming
        req_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
        if 'Range' in request.headers:
            req_headers['Range'] = request.headers['Range']
            
        r = requests.get(stream_url, headers=req_headers, stream=True, timeout=15)
        
        res_headers = {}
        for h in ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']:
            if h in r.headers:
                res_headers[h] = r.headers[h]
                
        def generate():
            for chunk in r.iter_content(chunk_size=4096):
                yield chunk
                
        return Response(
            stream_with_context(generate()),
            status=r.status_code,
            headers=res_headers
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


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
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/artists/<path:artist_name>', methods=['POST'])
@require_auth
def update_artist_metadata(artist_name):
    """Save or update bio description and custom image URL for an artist."""
    try:
        from models.database import Database
        data = request.get_json() or {}
        description = data.get('description', '').strip()
        image_url = data.get('image_url', '').strip()

        # Insert or update using MySQL INSERT INTO ... ON DUPLICATE KEY UPDATE
        query = """
            INSERT INTO artists_metadata (artist_name, description, image_url)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE description = %s, image_url = %s
        """
        Database.execute_query(query, (artist_name, description, image_url, description, image_url))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/song/<int:song_id>/lightshow', methods=['GET'])
@require_auth
def get_lightshow(song_id):
    """Retrieve the pregenerated light show for a song, or 404 if none exists."""
    try:
        from models.database import Database
        import json
        result = Database.execute_query(
            "SELECT data FROM song_lightshows WHERE song_id = %s", (song_id,), fetch_one=True)
        if not result:
            return jsonify({'error': 'No light show for this song'}), 404
        return jsonify({'success': True, 'lightshow': json.loads(result['data'])})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/song/<int:song_id>/lightshow', methods=['POST'])
@require_auth
def save_lightshow(song_id):
    """Save or replace the pregenerated light show for a song."""
    try:
        from models.database import Database
        import json
        if not SongModel.get_song_by_id(song_id):
            return jsonify({'error': 'Song not found'}), 404
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No light show data provided'}), 400
        payload = json.dumps(data)
        query = """
            INSERT INTO song_lightshows (song_id, data)
            VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE data = %s
        """
        Database.execute_query(query, (song_id, payload, payload))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/song/<int:song_id>/lightshow', methods=['DELETE'])
@require_auth
def delete_lightshow(song_id):
    """Remove the pregenerated light show for a song."""
    try:
        from models.database import Database
        Database.execute_query("DELETE FROM song_lightshows WHERE song_id = %s", (song_id,))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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


@music_bp.route('/song/<int:song_id>/lyrics', methods=['GET'])
@require_auth
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

        if not found:
            return jsonify({'error': 'No lyrics found for this song', 'state': 'not_found'}), 404

        return jsonify({
            'success': True,
            'lyrics': {'synced': synced or [], 'plain': plain or ''}
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/song/<int:song_id>/lyrics', methods=['DELETE'])
@require_auth
def delete_lyrics(song_id):
    """Clear cached lyrics so they can be re-fetched."""
    try:
        from models.database import Database
        Database.execute_query("DELETE FROM song_lyrics WHERE song_id = %s", (song_id,))
        Database.execute_query("DELETE FROM song_lyrics_words WHERE song_id = %s", (song_id,))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/song/<int:song_id>/lyrics-words', methods=['GET'])
@require_auth
def get_lyrics_words(song_id):
    """Return forced-alignment word timestamps for a song's lyrics.

    Computes them on first request (slow: runs faster-whisper) and caches the
    result in song_lyrics_words. Pass ?refresh=1 to recompute.
    """
    try:
        from models.database import Database
        import json
        import time as _time

        def _log(msg):
            print(f'[lyrics-align] song={song_id} {msg}', flush=True)

        refresh = request.args.get('refresh') == '1'
        _log(f'request (refresh={refresh})')

        cached = Database.execute_query(
            "SELECT data FROM song_lyrics_words WHERE song_id = %s",
            (song_id,), fetch_one=True)
        if cached:
            words = json.loads(cached['data'])
            _log(f'cache HIT — {len(words)} lines (no whisper run)')
            return jsonify({'success': True, 'words': words})

        # Cache-only by default: opening the panel must never trigger the heavy
        # Whisper run. The batch job (or ?refresh=1) does the alignment.
        if not refresh:
            _log('cache miss (cache-only mode) — not computing on view')
            return jsonify({'error': 'Word timing not computed yet'}), 404

        _log('cache miss (refresh) — will run alignment')

        song = SongModel.get_song_by_id(song_id)
        if not song:
            _log('404: song not found')
            return jsonify({'error': 'Song not found'}), 404

        lyr = Database.execute_query(
            "SELECT synced, plain FROM song_lyrics WHERE song_id = %s AND found = 1",
            (song_id,), fetch_one=True)
        if not lyr:
            _log('404: no cached lyrics with found=1')
            return jsonify({'error': 'No lyrics available to align'}), 404

        lines = []
        source = None
        if lyr.get('synced'):
            try:
                synced = json.loads(lyr['synced'])
                lines = [l.get('text', '') for l in synced if l.get('text') is not None]
                if lines:
                    source = 'synced'
            except Exception as e:
                _log(f'warn: synced json parse failed: {e}')
                lines = []
        if not lines and lyr.get('plain'):
            lines = [ln for ln in (lyr['plain'] or '').split('\n')]
            if lines:
                source = 'plain'
        if not lines:
            _log('404: lyrics had no usable lines')
            return jsonify({'error': 'No lyrics available to align'}), 404
        _log(f'lyrics loaded: {len(lines)} lines (source={source})')

        music_path = SettingsModel.get_music_path()
        if not music_path:
            _log('400: music path not configured')
            return jsonify({'error': 'Music path not configured'}), 400

        # file_path is stored relative to the music directory (same as /stream)
        relative_path = song.get('file_path') or song.get('path')
        if not relative_path:
            _log('404: song has no file_path')
            return jsonify({'error': 'Audio file not found for alignment'}), 404
        audio_path = os.path.normpath(os.path.join(music_path, relative_path))
        if not audio_path.startswith(os.path.normpath(music_path)) or not os.path.isfile(audio_path):
            _log(f'404: resolved audio not a file: {audio_path}')
            return jsonify({'error': 'Audio file not found for alignment'}), 404
        _log(f'audio resolved: {audio_path}')

        from utils.lyrics_align import align_lyrics_words
        t0 = _time.time()
        words = align_lyrics_words(audio_path, lines)
        _log(f'align_lyrics_words returned in {_time.time() - t0:.1f}s '
             f'-> {"OK" if words else "None"}')
        if not words:
            _log('500: alignment produced no result')
            return jsonify({'error': 'Alignment produced no result'}), 500

        payload = json.dumps(words)
        Database.execute_query(
            """INSERT INTO song_lyrics_words (song_id, data)
               VALUES (%s, %s)
               ON DUPLICATE KEY UPDATE data = %s""",
            (song_id, payload, payload))
        _log(f'cached {len(words)} lines of word times')
        return jsonify({'success': True, 'words': words})
    except Exception as e:
        print(f'[lyrics-align] song={song_id} EXCEPTION: {e}', flush=True)
        return jsonify({'error': str(e)}), 500


# Re-entrancy guards so the heavy batch jobs can't be double-triggered.
_lyrics_fetch_job_running = False
_lyrics_align_job_running = False


@music_bp.route('/jobs/lyrics', methods=['POST'])
@require_auth
def job_fetch_lyrics():
    """Batch job: pull LRCLIB lyrics for every song that doesn't have them yet.

    Streams NDJSON progress. Skips songs whose lyrics are already cached
    (found=1) so re-runs are cheap.
    """
    global _lyrics_fetch_job_running
    from flask import Response, stream_with_context
    from models.database import Database
    import json

    if _lyrics_fetch_job_running:
        return jsonify({'error': 'A lyrics fetch job is already running'}), 409

    def generate():
        global _lyrics_fetch_job_running
        _lyrics_fetch_job_running = True
        try:
            all_songs = Database.execute_query(
                "SELECT id, title, artist, album, duration FROM songs ORDER BY id",
                fetch_all=True)
            have = {r['song_id'] for r in Database.execute_query(
                "SELECT song_id FROM song_lyrics WHERE found = 1", fetch_all=True)}

            total = len(all_songs)
            yield json.dumps({'type': 'start', 'total': total}) + '\n'
            if total == 0:
                yield json.dumps({'type': 'done', 'fetched': 0, 'skipped': 0, 'failed': 0}) + '\n'
                return

            fetched = skipped = failed = 0
            for i, row in enumerate(all_songs, 1):
                yield json.dumps({
                    'type': 'progress', 'current': i, 'total': total,
                    'title': row['title'], 'artist': row['artist']
                }) + '\n'

                if row['id'] in have:
                    skipped += 1
                    continue

                try:
                    synced, plain = _fetch_lyrics_from_lrclib(
                        row['title'], row['artist'], row['album'], row['duration'])
                    found = 1 if (synced or plain) else 0
                    synced_json = json.dumps(synced) if synced else None
                    plain_text = plain or None
                    Database.execute_query(
                        """INSERT INTO song_lyrics (song_id, found, synced, plain)
                           VALUES (%s, %s, %s, %s)
                           ON DUPLICATE KEY UPDATE found = %s, synced = %s, plain = %s""",
                        (row['id'], found, synced_json, plain_text,
                         found, synced_json, plain_text))
                    if found:
                        fetched += 1
                    else:
                        failed += 1
                except Exception as e:
                    print(f'[lyrics-job] fetch failed song={row["id"]}: {e}', flush=True)
                    failed += 1

            yield json.dumps({
                'type': 'done', 'fetched': fetched, 'skipped': skipped, 'failed': failed
            }) + '\n'
        except Exception as e:
            print(f'[lyrics-job] fetch EXCEPTION: {e}', flush=True)
            yield json.dumps({'type': 'error', 'error': str(e)}) + '\n'
        finally:
            _lyrics_fetch_job_running = False

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')


@music_bp.route('/jobs/lyrics-words', methods=['POST'])
@require_auth
def job_align_lyrics():
    """Batch job: run forced word-timing alignment for every song that has lyrics.

    Streams NDJSON progress. This is the expensive (Whisper) job — run it once
    and the per-song view becomes instant from cache. Skips already-aligned
    songs so re-runs only process new ones.
    """
    global _lyrics_align_job_running
    from flask import Response, stream_with_context
    from models.database import Database
    import json

    if _lyrics_align_job_running:
        return jsonify({'error': 'A lyrics alignment job is already running'}), 409

    def _lines_from_row(r):
        lines = []
        if r.get('synced'):
            try:
                synced = json.loads(r['synced'])
                lines = [l.get('text', '') for l in synced if l.get('text') is not None]
            except Exception:
                lines = []
        if not lines and r.get('plain'):
            lines = [ln for ln in (r['plain'] or '').split('\n')]
        return lines

    def generate():
        global _lyrics_align_job_running
        _lyrics_align_job_running = True
        try:
            rows = Database.execute_query(
                """SELECT s.id, s.title, s.artist, s.file_path, sl.synced, sl.plain
                   FROM songs s
                   JOIN song_lyrics sl ON sl.song_id = s.id AND sl.found = 1
                   ORDER BY s.id""",
                fetch_all=True)
            have_words = {r['song_id'] for r in Database.execute_query(
                "SELECT song_id FROM song_lyrics_words", fetch_all=True)}

            music_path = SettingsModel.get_music_path()
            norm_music = os.path.normpath(music_path) if music_path else None

            total = len(rows)
            yield json.dumps({'type': 'start', 'total': total}) + '\n'
            if total == 0:
                yield json.dumps({'type': 'done', 'aligned': 0, 'skipped': 0, 'failed': 0}) + '\n'
                return
            if not music_path:
                yield json.dumps({'type': 'error', 'error': 'Music path not configured'}) + '\n'
                return

            from utils.lyrics_align import align_lyrics_words

            aligned = skipped = failed = 0
            for i, row in enumerate(rows, 1):
                yield json.dumps({
                    'type': 'progress', 'current': i, 'total': total,
                    'title': row['title'], 'artist': row['artist']
                }) + '\n'

                if row['id'] in have_words:
                    skipped += 1
                    continue

                lines = _lines_from_row(row)
                rel = row.get('file_path')
                if not lines or not rel:
                    failed += 1
                    continue
                audio_path = os.path.normpath(os.path.join(music_path, rel))
                if not audio_path.startswith(norm_music) or not os.path.isfile(audio_path):
                    print(f'[lyrics-job] align skip song={row["id"]}: audio not found ({audio_path})', flush=True)
                    failed += 1
                    continue

                try:
                    words = align_lyrics_words(audio_path, lines)
                    if not words:
                        failed += 1
                        continue
                    payload = json.dumps(words)
                    Database.execute_query(
                        """INSERT INTO song_lyrics_words (song_id, data)
                           VALUES (%s, %s)
                           ON DUPLICATE KEY UPDATE data = %s""",
                        (row['id'], payload, payload))
                    aligned += 1
                except Exception as e:
                    print(f'[lyrics-job] align failed song={row["id"]}: {e}', flush=True)
                    failed += 1

            yield json.dumps({
                'type': 'done', 'aligned': aligned, 'skipped': skipped, 'failed': failed
            }) + '\n'
        except Exception as e:
            print(f'[lyrics-job] align EXCEPTION: {e}', flush=True)
            yield json.dumps({'type': 'error', 'error': str(e)}) + '\n'
        finally:
            _lyrics_align_job_running = False

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')


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
@require_auth
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
    """Get all songs in the library and flag which ones have this artist credited."""
    try:
        from models.database import Database
        query = "SELECT id, title, artist, album FROM songs ORDER BY artist, album, track_number"
        all_songs = Database.execute_query(query, fetch_all=True)

        songs_out = []
        for s in all_songs:
            raw = s.get('artist') or ''
            artist_list = [a.strip() for a in raw.split(',') if a.strip()]
            has_artist = artist_name in artist_list
            songs_out.append({
                'id': s['id'],
                'title': s['title'],
                'artist': s['artist'],
                'album': s.get('album') or '',
                'has_artist': has_artist
            })

        return jsonify({'success': True, 'songs': songs_out})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@music_bp.route('/artists/<path:artist_name>/songs/<int:song_id>', methods=['POST'])
@require_auth
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

        if action == 'add':
            if artist_name not in artists:
                artists.append(artist_name)
        elif action == 'remove':
            artists = [a for a in artists if a != artist_name]
        else:
            return jsonify({'error': 'Invalid action; use "add" or "remove"'}), 400

        new_artist_str = ', '.join(artists) if artists else 'Unknown Artist'
        Database.execute_query("UPDATE songs SET artist = %s WHERE id = %s", (new_artist_str, song_id))
        return jsonify({'success': True, 'new_artist': new_artist_str})
    except Exception as e:
        return jsonify({'error': str(e)}), 500