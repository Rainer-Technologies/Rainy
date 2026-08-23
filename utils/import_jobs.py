"""Reusable import routines for YouTube / Spotify imports.

These functions perform the actual download + database work and report
progress through a callback, returning a result dict. They are shared by:
  * the synchronous / streaming route handlers (foreground imports), and
  * the background job worker (queued imports).

Each function signature:
    fn(url, music_path, on_progress=None) -> dict

`on_progress(percent: int, message: str)` is optional. The returned dict
always contains a boolean `success`; on failure it also has `error`.
"""
import os


def spotify_match_score(track_title, track_artist, result):
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


def _noop(*_args, **_kwargs):
    pass


def _grant_import(owner_user_id, song_id):
    """Grant the importing user access to a song (personal import origin).

    Best-effort: never break an import over an ACL hiccup.
    """
    if not owner_user_id or not song_id:
        return
    try:
        from models.library_access import LibraryAccessModel
        LibraryAccessModel.grant(int(owner_user_id), int(song_id),
                                 origin='import')
    except Exception as e:  # noqa: BLE001
        print(f"[import-jobs] grant failed (user={owner_user_id}, "
              f"song={song_id}): {e}")


def import_youtube_song(url, music_path, on_progress=None, conflict_mode=None,
                        owner_user_id=None):
    """Import a single song from a YouTube / YouTube Music URL."""
    from utils.youtube import YouTubeDownloader
    from utils.scanner import MusicScanner
    from models.song import SongModel

    on_progress = on_progress or _noop
    on_progress(10, 'Connecting to YouTube...')

    downloader = YouTubeDownloader(music_path)
    result = downloader.download(url)

    if not result.get('success'):
        return {'success': False, 'error': result.get('error', 'Download failed')}

    if result.get('already_exists'):
        # Importer still needs to SEE an already-present song.
        try:
            rel = os.path.relpath(result.get('file_path'), music_path)
            existing = SongModel.get_song_by_path(rel)
            if existing:
                _grant_import(owner_user_id, existing['id'])
        except Exception as e:  # noqa: BLE001
            print(f"[import-jobs] grant-on-existing failed: {e}")
        return {
            'success': True,
            'already_exists': True,
            'title': result.get('title'),
            'artist': result.get('artist'),
            'message': result.get('message', 'Song already exists in library'),
        }

    if result.get('file_path'):
        scanner = MusicScanner(music_path)
        metadata = scanner.scan_single_file(result['file_path'])
        if metadata and metadata.get('id'):
            _grant_import(owner_user_id, metadata['id'])
        if result.get('cover_path') and metadata:
            SongModel.update_song_metadata(metadata['path'], {'cover_path': result['cover_path']})

    on_progress(100, 'Done')
    return {
        'success': True,
        'title': result.get('title'),
        'artist': result.get('artist'),
    }


def import_youtube_playlist(url, music_path, on_progress=None, conflict_mode='add',
                            owner_user_id=None):
    """Import a full YouTube / YouTube Music playlist, creating a Rainy playlist."""
    from utils.youtube import YouTubeDownloader
    from utils.scanner import MusicScanner
    from models.song import SongModel
    from models.playlist import PlaylistModel

    on_progress = on_progress or _noop
    conflict_mode = conflict_mode or 'add'
    on_progress(2, 'Fetching playlist...')

    def _dl_progress(current, total, message):
        percent = int((current / total) * 90) if total > 0 else 0
        on_progress(percent, message)

    downloader = YouTubeDownloader(music_path)
    result = downloader.download_playlist(url, progress_callback=_dl_progress)

    if not result.get('success'):
        return {'success': False, 'error': result.get('error', 'Download failed')}

    songs = result.get('songs', [])
    playlist_name = result.get('playlist_name', 'Imported Playlist')

    on_progress(90, 'Creating playlist and updating library...')

    if not songs:
        return {'success': False, 'error': 'No songs were downloaded from the playlist'}

    try:
        existing = PlaylistModel.get_playlist_by_name(playlist_name)
        if existing and conflict_mode == 'override':
            PlaylistModel.clear_playlist_entries(existing['id'])
            created_playlist_id = existing['id']
        elif existing and conflict_mode == 'add':
            created_playlist_id = existing['id']
        elif existing:
            # 'new' — create with a unique suffix
            n = 2
            name = f"{playlist_name} ({n})"
            while PlaylistModel.get_playlist_by_name(name):
                n += 1
                name = f"{playlist_name} ({n})"
            created_playlist_id = PlaylistModel.create_playlist(name)
        else:
            created_playlist_id = PlaylistModel.create_playlist(playlist_name)
    except Exception as e:  # noqa: BLE001
        return {'success': False, 'error': f'Failed to create playlist: {e}'}

    added_count = 0
    total_songs = len(songs)

    for i, song in enumerate(songs):
        file_path = song.get('file_path')
        if file_path:
            try:
                song_id = None
                if song.get('already_exists'):
                    relative_path = os.path.relpath(file_path, music_path)
                    existing_song = SongModel.get_song_by_path(relative_path)
                    if existing_song:
                        song_id = existing_song['id']
                else:
                    scanner = MusicScanner(music_path)
                    metadata = scanner.scan_single_file(file_path)
                    if metadata and metadata.get('id'):
                        song_id = metadata['id']
                        _grant_import(owner_user_id, song_id)
                        if song.get('cover_path') and metadata:
                            SongModel.update_song_metadata(
                                metadata['path'], {'cover_path': song['cover_path']}
                            )

                if song_id:
                    PlaylistModel.add_song_to_playlist(created_playlist_id, song_id)
                    added_count += 1
            except Exception as e:  # noqa: BLE001
                print(f"Error adding song to playlist: {e}")
                continue

        current_percent = 90 + int(((i + 1) / total_songs) * 10)
        on_progress(min(current_percent, 99), f'Adding to library: {song.get("title", "Unknown")}')

    return {
        'success': True,
        'playlist_name': playlist_name,
        'playlist_id': created_playlist_id,
        'song_count': added_count,
    }


def import_spotify_song(url, music_path, on_progress=None, conflict_mode=None,
                        owner_user_id=None):
    """Import a single song from a Spotify track link (matched on YouTube Music)."""
    from utils.spotify import SpotifyImporter
    from utils.metadata import MetadataSearcher
    from utils.youtube import YouTubeDownloader
    from utils.scanner import MusicScanner
    from models.song import SongModel

    on_progress = on_progress or _noop
    on_progress(10, 'Fetching track from Spotify...')

    importer = SpotifyImporter()
    track = importer.fetch_track(url)
    if not track.get('success'):
        return {'success': False, 'error': track.get('error', 'Failed to fetch Spotify track')}

    title = track['title']
    artist = track['artist']

    on_progress(30, 'Matching on YouTube Music...')
    searcher = MetadataSearcher()
    results = searcher.search(f'{title} {artist}', limit=5)
    if not results:
        return {'success': False, 'error': f'No YouTube Music match found for "{title}" by {artist}'}

    best = max(results, key=lambda r: spotify_match_score(title, artist, r))
    video_id = best.get('videoId')
    if not video_id:
        return {'success': False, 'error': 'No playable match found on YouTube Music'}

    on_progress(50, 'Downloading audio...')
    downloader = YouTubeDownloader(music_path)
    result = downloader.download(f'https://www.youtube.com/watch?v={video_id}')

    if not result.get('success'):
        return {'success': False, 'error': result.get('error', 'Download failed')}

    if result.get('already_exists'):
        # Importer still needs to SEE an already-present song.
        try:
            rel = os.path.relpath(result.get('file_path'), music_path)
            existing = SongModel.get_song_by_path(rel)
            if existing:
                _grant_import(owner_user_id, existing['id'])
        except Exception as e:  # noqa: BLE001
            print(f"[import-jobs] grant-on-existing failed: {e}")
        return {
            'success': True,
            'already_exists': True,
            'title': result.get('title') or title,
            'artist': result.get('artist') or artist,
            'message': result.get('message', 'Song already exists in library'),
        }

    if result.get('file_path'):
        scanner = MusicScanner(music_path)
        metadata = scanner.scan_single_file(result['file_path'])
        if metadata and metadata.get('id'):
            _grant_import(owner_user_id, metadata['id'])
        if result.get('cover_path') and metadata:
            SongModel.update_song_metadata(metadata['path'], {'cover_path': result['cover_path']})

    on_progress(100, 'Done')
    return {
        'success': True,
        'title': result.get('title') or title,
        'artist': result.get('artist') or artist,
    }


def import_spotify_playlist(url, music_path, on_progress=None, conflict_mode='add',
                            owner_user_id=None):
    """Import a Spotify playlist (each track matched + downloaded from YouTube Music)."""
    from utils.spotify import SpotifyImporter
    from utils.metadata import MetadataSearcher
    from utils.youtube import YouTubeDownloader
    from utils.scanner import MusicScanner
    from models.song import SongModel
    from models.playlist import PlaylistModel

    on_progress = on_progress or _noop
    conflict_mode = conflict_mode or 'add'
    on_progress(2, 'Fetching playlist from Spotify...')

    importer = SpotifyImporter()
    playlist_data = importer.fetch_playlist(url)
    if not playlist_data.get('success'):
        return {'success': False, 'error': playlist_data.get('error', 'Failed to fetch Spotify playlist')}

    playlist_name = playlist_data['name']
    tracks = playlist_data['tracks']
    total = len(tracks)

    searcher = MetadataSearcher()
    downloader = YouTubeDownloader(music_path)

    try:
        existing = PlaylistModel.get_playlist_by_name(playlist_name)
        if existing and conflict_mode == 'override':
            PlaylistModel.clear_playlist_entries(existing['id'])
            created_playlist_id = existing['id']
        elif existing and conflict_mode == 'add':
            created_playlist_id = existing['id']
        elif existing:
            n = 2
            name = f"{playlist_name} ({n})"
            while PlaylistModel.get_playlist_by_name(name):
                n += 1
                name = f"{playlist_name} ({n})"
            created_playlist_id = PlaylistModel.create_playlist(name)
        else:
            created_playlist_id = PlaylistModel.create_playlist(playlist_name)
    except Exception as e:  # noqa: BLE001
        return {'success': False, 'error': f'Failed to create playlist: {e}'}

    added_count = 0
    failed_count = 0

    for i, track in enumerate(tracks):
        title = track['title']
        artist = track['artist']
        percent = 5 + int((i / total) * 90) if total else 5
        on_progress(percent, f'[{i + 1}/{total}] Searching: {title} - {artist}')

        try:
            results = searcher.search(f'{title} {artist}', limit=5)
            if not results:
                failed_count += 1
                continue

            best = max(results, key=lambda r: spotify_match_score(title, artist, r))
            video_id = best.get('videoId')
            if not video_id:
                failed_count += 1
                continue

            song_result = downloader.download(f'https://www.youtube.com/watch?v={video_id}')
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
                    _grant_import(owner_user_id, song_id)
                    if song_result.get('cover_path') and metadata:
                        SongModel.update_song_metadata(
                            metadata['path'], {'cover_path': song_result['cover_path']}
                        )

            if song_id:
                PlaylistModel.add_song_to_playlist(created_playlist_id, song_id)
                added_count += 1
            else:
                failed_count += 1
        except Exception as e:  # noqa: BLE001
            print(f"Error importing Spotify track '{title}': {e}")
            failed_count += 1
            continue

    on_progress(98, 'Finalizing playlist...')
    return {
        'success': True,
        'playlist_name': playlist_name,
        'playlist_id': created_playlist_id,
        'song_count': added_count,
        'failed_count': failed_count,
    }


# Dispatch table keyed by (source, kind) -> handler.
IMPORT_HANDLERS = {
    ('youtube', 'song'): import_youtube_song,
    ('youtube', 'playlist'): import_youtube_playlist,
    ('spotify', 'song'): import_spotify_song,
    ('spotify', 'playlist'): import_spotify_playlist,
}
