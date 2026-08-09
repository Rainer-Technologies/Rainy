"""Core sync logic: fetch remote playlist, diff with local, add/remove songs."""

import os
import re


def _norm(s):
    return re.sub(r'\s+', ' ', (s or '').strip().lower())


def _track_key(title, artist):
    return f"{_norm(title)}||{_norm(artist)}"


def sync_youtube_playlist(playlist_id, url, music_path, sync_mode='mirror', on_progress=None):
    """Sync a local playlist with a remote YouTube playlist.

    Returns dict {added, removed, kept, failed, total_remote}
    """
    from utils.youtube import YouTubeDownloader
    from utils.scanner import MusicScanner
    from models.song import SongModel
    from models.playlist import PlaylistModel

    def _nop(*a, **k): pass
    on_progress = on_progress or _nop

    on_progress(2, 'Fetching YouTube playlist…')
    dl = YouTubeDownloader(music_path)
    info = dl._extract_playlist_info(url)
    if not info:
        return {'success': False, 'error': 'Could not fetch YouTube playlist info'}
    entries = info.get('entries') or []
    # Build remote key map: key -> entry
    remote_keys = {}
    remote_list = []
    for e in entries:
        if not e or not e.get('title'):
            continue
        title = (e.get('title') or '').strip()
        artist = (e.get('artist') or e.get('uploader') or 'Unknown Artist').strip()
        key = _track_key(title, artist)
        # keep first occurrence of duplicate remote keys
        if key not in remote_keys:
            remote_keys[key] = e
            remote_list.append((key, e))

    total_remote = len(remote_list)
    # Get local playlist songs
    local_rows = PlaylistModel.get_playlist_songs(playlist_id) or []
    local_map = {}  # key -> song_id
    local_song_ids = set()
    for row in local_rows:
        key = _track_key(row.get('title'), row.get('artist'))
        local_map[key] = row['id']
        local_song_ids.add(row['id'])

    # For mirror mode we also need to know which local songs should stay
    keep_keys = set(remote_keys.keys())
    added = 0
    kept = 0
    failed = 0

    on_progress(5, f'Found {total_remote} remote tracks, syncing…')

    for idx, (key, entry) in enumerate(remote_list):
        if key in local_map:
            kept += 1
            continue
        # Need to download / find this track
        title = entry.get('title')
        on_progress(5 + int((idx / max(total_remote,1))*85), f'Downloading: {title}')
        try:
            res = dl._download_single_with_info(entry)
            if not res.get('success') or not res.get('file_path'):
                failed += 1
                continue
            file_path = res['file_path']
            # Resolve song_id
            song_id = None
            if res.get('already_exists'):
                rel = os.path.relpath(file_path, music_path).replace('\\','/')
                # try multiple lookups: by path, then by title/artist
                row = SongModel.get_song_by_path(rel)
                if row:
                    song_id = row['id']
                else:
                    # fallback search by title/artist
                    pass
            else:
                scanner = MusicScanner(music_path)
                meta = scanner.scan_single_file(file_path)
                if meta and meta.get('id'):
                    song_id = meta['id']
                    if res.get('cover_path') and meta:
                        SongModel.update_song_metadata(meta['path'], {'cover_path': res['cover_path']})
            if song_id:
                PlaylistModel.add_song_to_playlist(playlist_id, song_id)
                added += 1
                local_map[key] = song_id
            else:
                failed += 1
        except Exception as e:  # noqa
            print(f"[sync] youtube entry failed {entry.get('title')}: {e}")
            failed += 1

    removed = 0
    if sync_mode == 'mirror':
        # Remove local songs whose key not in remote
        to_remove = []
        for row in local_rows:
            key = _track_key(row.get('title'), row.get('artist'))
            if key not in keep_keys:
                to_remove.append(row['id'])
        for sid in to_remove:
            try:
                PlaylistModel.remove_song_from_playlist(playlist_id, sid)
                removed += 1
            except Exception:
                pass

    return {'success': True, 'added': added, 'removed': removed, 'kept': kept, 'failed': failed, 'total_remote': total_remote}


def sync_spotify_playlist(playlist_id, url, music_path, sync_mode='mirror', on_progress=None):
    """Sync a local playlist with a remote Spotify playlist (via YouTube matches)."""
    from utils.spotify import SpotifyImporter
    from utils.metadata import MetadataSearcher
    from utils.youtube import YouTubeDownloader
    from utils.scanner import MusicScanner
    from utils.import_jobs import spotify_match_score
    from models.song import SongModel
    from models.playlist import PlaylistModel

    def _nop(*a, **k): pass
    on_progress = on_progress or _nop

    on_progress(2, 'Fetching Spotify playlist…')
    imp = SpotifyImporter()
    pdata = imp.fetch_playlist(url)
    if not pdata.get('success'):
        return {'success': False, 'error': pdata.get('error', 'Failed to fetch Spotify playlist')}
    tracks = pdata.get('tracks') or []
    total_remote = len(tracks)
    # Build remote keys
    remote_keys = {}
    remote_order = []
    for t in tracks:
        title = (t.get('title') or '').strip()
        artist = (t.get('artist') or '').strip()
        if not title:
            continue
        key = _track_key(title, artist)
        if key not in remote_keys:
            remote_keys[key] = t
            remote_order.append((key, t))

    local_rows = PlaylistModel.get_playlist_songs(playlist_id) or []
    local_map = {}
    for row in local_rows:
        key = _track_key(row.get('title'), row.get('artist'))
        # keep first id for duplicate keys
        if key not in local_map:
            local_map[key] = row['id']

    keep_keys = set(remote_keys.keys())
    added = 0
    kept = 0
    failed = 0

    searcher = MetadataSearcher()
    dl = YouTubeDownloader(music_path)
    on_progress(5, f'Found {total_remote} remote tracks, syncing…')

    for idx, (key, track) in enumerate(remote_order):
        if key in local_map:
            kept += 1
            continue
        title = track['title']
        artist = track['artist']
        on_progress(5 + int((idx / max(total_remote,1))*85), f'Matching: {title} — {artist}')
        try:
            results = searcher.search(f'{title} {artist}', limit=5)
            if not results:
                failed += 1
                continue
            best = max(results, key=lambda r: spotify_match_score(title, artist, r))
            vid = best.get('videoId')
            if not vid:
                failed += 1
                continue
            res = dl.download(f'https://www.youtube.com/watch?v={vid}')
            if not res.get('success') or not res.get('file_path'):
                failed += 1
                continue
            file_path = res['file_path']
            song_id = None
            if res.get('already_exists'):
                rel = os.path.relpath(file_path, music_path).replace('\\','/')
                row = SongModel.get_song_by_path(rel)
                if row:
                    song_id = row['id']
            else:
                scanner = MusicScanner(music_path)
                meta = scanner.scan_single_file(file_path)
                if meta and meta.get('id'):
                    song_id = meta['id']
                    if res.get('cover_path') and meta:
                        SongModel.update_song_metadata(meta['path'], {'cover_path': res['cover_path']})
            if song_id:
                PlaylistModel.add_song_to_playlist(playlist_id, song_id)
                added += 1
                local_map[key] = song_id
            else:
                failed += 1
        except Exception as e:  # noqa
            print(f"[sync] spotify track failed {title}: {e}")
            failed += 1

    removed = 0
    if sync_mode == 'mirror':
        to_remove = []
        for row in local_rows:
            key = _track_key(row.get('title'), row.get('artist'))
            if key not in keep_keys:
                to_remove.append(row['id'])
        for sid in to_remove:
            try:
                PlaylistModel.remove_song_from_playlist(playlist_id, sid)
                removed += 1
            except Exception:
                pass

    return {'success': True, 'added': added, 'removed': removed, 'kept': kept, 'failed': failed, 'total_remote': total_remote}


def sync_playlist(playlist_id, source, url, music_path, sync_mode='mirror', on_progress=None):
    if source == 'youtube':
        return sync_youtube_playlist(playlist_id, url, music_path, sync_mode, on_progress)
    elif source == 'spotify':
        return sync_spotify_playlist(playlist_id, url, music_path, sync_mode, on_progress)
    else:
        return {'success': False, 'error': f'Unknown source {source}'}
