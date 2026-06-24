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
        
    except ImportError:
        return jsonify({'error': 'yt-dlp not installed. Please install it with: pip install yt-dlp'}), 500
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


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