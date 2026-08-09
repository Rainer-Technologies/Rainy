"""Core sync logic: fetch remote playlist, diff with local, add/remove songs."""

import os
import re
import unicodedata

from models.playlist import PlaylistModel


def _norm(s):
    """Normalize a string for fuzzy matching.

    Lowercase, collapse whitespace, drop diacritics (NFKD), strip
    punctuation and "non-song" markers (remix/feat/live/etc.), dedupe
    repeated tokens. The old version only lowercased+collapsed spaces, so
    "De Lejitos - Remix" never matched "De Lejitos (Remix)" and the mirror
    phase deleted songs it had just added (Aug 2026 bug).
    """
    s = (s or '').strip().lower()
    # NFKD: "Ñ" -> "N" + combining tilde; é -> e, etc.
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    # Cut parenthetical feat-lists: "(feat. Maluma & Ozuna)" -> "". The
    # artist names there are credit noise, not part of the title.
    s = re.sub(r'\(?(feat|ft|featuring)[^)]*\)?', ' ', s)
    # Punctuation and symbols -> space ("<3" vs "ᐸ3" both become "").
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    # Drop noise words that vary between sources.
    s = re.sub(
        r'\b(feat|ft|featuring|remix|remastered|remaster|live|en vivo|'
        r'acoustic|official|lyrics|video|audio|version|edit)\b', ' ', s)
    words = s.split()
    # Dedupe repeated tokens ("Artist, Name, Name, ..." credit lists).
    seen, out = set(), []
    for w in words:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return ' '.join(out)


def _track_key(title, artist):
    return f"{_norm(title)}||{_norm(artist)}"


def _tokens(s):
    return set(_norm(s).split())


def _track_similarity(title1, artist1, title2, artist2):
    """Similarity 0..2+ between two tracks (Jaccard on normalized tokens).

    Returns (score, title_score, artist_score). Score = title + 0.8*artist
    (same weighting as import_jobs.spotify_match_score). Titles dominate
    because artist credit lists vary wildly between sources (duplicated
    names, legal names appended) while titles are stable.
    """
    t1, t2 = _tokens(title1), _tokens(title2)
    a1, a2 = _tokens(artist1), _tokens(artist2)

    def _jaccard(x, y):
        if not x or not y:
            return 0.0
        return len(x & y) / len(x | y)

    t = _jaccard(t1, t2)
    a = _jaccard(a1, a2)
    return t + 0.8 * a, t, a


# Minimum combined score to treat a local song as "same as" a remote one.
# Title match alone (>=0.9) is enough (credit lists differ wildly); weak
# title + strong artist is NOT enough (different songs, same artist).
def _same_track(title1, artist1, title2, artist2):
    score, t, a = _track_similarity(title1, artist1, title2, artist2)
    if t >= 0.9:
        return True
    return t >= 0.6 and a >= 0.25


def _fuzzy_find_local(title, artist, local_rows):
    """Best local row fuzzy-matching the remote track, or None."""
    best_row, best_score = None, 0.0
    for row in local_rows:
        score, t, a = _track_similarity(
            title, artist, row.get('title'), row.get('artist'))
        if _same_track(title, artist, row.get('title'), row.get('artist')) \
                and score > best_score:
            best_score, best_row = score, row
    return best_row


def _mirror_removals(playlist_id, local_rows, remote_keys):
    """Remove local songs that don't fuzzy-match ANY remote track.

    Returns (removed_count, removed_details, warning_or_None). A safety cap
    (50% of the playlist) blocks runaway removal — the exact-key diff
    removed 21 of 21 songs it had just added on the first run of this
    feature (Aug 2026); mass removal now needs a human.
    """
    if not local_rows:
        return 0, [], None
    cap = max(3, int(len(local_rows) * 0.5))
    to_remove = []
    for row in local_rows:
        title, artist = row.get('title'), row.get('artist')
        if any(_same_track(title, artist, e.get('title'), e.get('artist'))
               for e in remote_keys.values()):
            continue
        to_remove.append((row['id'], title, artist))
    if len(to_remove) > cap:
        warn = (f"Mirror blocked: {len(to_remove)}/{len(local_rows)} songs "
                f"would be removed (cap {cap}). Nothing removed — check the "
                f"remote playlist / matching before forcing a cleanup.")
        print(f"[sync] {warn}")
        return 0, [], warn
    removed = 0
    removed_details = []
    for sid, t, a in to_remove:
        try:
            PlaylistModel.remove_song_from_playlist(playlist_id, sid)
            removed += 1
            removed_details.append(f"{t} — {a}")
        except Exception:
            pass
    return removed, removed_details, None


def sync_youtube_playlist(playlist_id, url, music_path, sync_mode='mirror', on_progress=None):
    """Sync a local playlist with a remote YouTube playlist.

    Returns dict {added, removed, kept, failed, total_remote, added_details, removed_details}
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
    remote_keys = {}
    remote_list = []
    for e in entries:
        if not e or not e.get('title'):
            continue
        title = (e.get('title') or '').strip()
        artist = (e.get('artist') or e.get('uploader') or 'Unknown Artist').strip()
        key = _track_key(title, artist)
        if key not in remote_keys:
            remote_keys[key] = e
            remote_list.append((key, e))

    total_remote = len(remote_list)
    local_rows = PlaylistModel.get_playlist_songs(playlist_id) or []
    local_map = {}
    for row in local_rows:
        key = _track_key(row.get('title'), row.get('artist'))
        local_map[key] = row['id']

    added = 0
    kept = 0
    failed = 0
    added_details = []
    removed_details = []

    on_progress(5, f'Found {total_remote} remote tracks, syncing…')

    for idx, (key, entry) in enumerate(remote_list):
        # Fuzzy match first — "De Lejitos - Remix" vs "(Remix)" must count
        # as the same track or mirror mode deletes what it just added.
        local_hit = _fuzzy_find_local(
            entry.get('title'), entry.get('artist'), local_rows)
        if local_hit:
            kept += 1
            continue
        title = entry.get('title') or 'Unknown Title'
        artist = entry.get('artist') or entry.get('uploader') or 'Unknown Artist'
        on_progress(5 + int((idx / max(total_remote,1))*85), f'Downloading: {title}')
        try:
            res = dl._download_single_with_info(entry)
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
                added_details.append(f"{title} — {artist}")
                local_map[key] = song_id
            else:
                failed += 1
        except Exception as e:  # noqa
            print(f"[sync] youtube entry failed {entry.get('title')}: {e}")
            failed += 1

    removed = 0
    if sync_mode == 'mirror':
        # Re-read the playlist AFTER adds (the old code diffed a stale
        # snapshot and removed songs added in this same run).
        fresh_rows = PlaylistModel.get_playlist_songs(playlist_id) or []
        removed, removed_details, warn = _mirror_removals(
            playlist_id, fresh_rows, remote_keys)
        if warn:
            return {'success': True, 'added': added, 'removed': removed,
                    'kept': kept, 'failed': failed, 'total_remote': total_remote,
                    'added_details': added_details, 'removed_details': removed_details,
                    'warning': warn}

    return {'success': True, 'added': added, 'removed': removed, 'kept': kept, 'failed': failed, 'total_remote': total_remote, 'added_details': added_details, 'removed_details': removed_details}


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
        if key not in local_map:
            local_map[key] = row['id']

    added = 0
    kept = 0
    failed = 0
    added_details = []
    removed_details = []

    searcher = MetadataSearcher()
    dl = YouTubeDownloader(music_path)
    on_progress(5, f'Found {total_remote} remote tracks, syncing…')

    for idx, (key, track) in enumerate(remote_order):
        # Fuzzy match first (metadata differs between Spotify and the
        # downloaded file's tags — exact keys caused add-then-delete).
        local_hit = _fuzzy_find_local(
            track.get('title'), track.get('artist'), local_rows)
        if local_hit:
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
                added_details.append(f"{title} — {artist}")
                local_map[key] = song_id
            else:
                failed += 1
        except Exception as e:  # noqa
            print(f"[sync] spotify track failed {title}: {e}")
            failed += 1

    removed = 0
    if sync_mode == 'mirror':
        fresh_rows = PlaylistModel.get_playlist_songs(playlist_id) or []
        removed, removed_details, warn = _mirror_removals(
            playlist_id, fresh_rows, remote_keys)
        if warn:
            return {'success': True, 'added': added, 'removed': removed,
                    'kept': kept, 'failed': failed, 'total_remote': total_remote,
                    'added_details': added_details, 'removed_details': removed_details,
                    'warning': warn}

    return {'success': True, 'added': added, 'removed': removed, 'kept': kept, 'failed': failed, 'total_remote': total_remote, 'added_details': added_details, 'removed_details': removed_details}


def sync_playlist(playlist_id, source, url, music_path, sync_mode='mirror', on_progress=None):
    if source == 'youtube':
        return sync_youtube_playlist(playlist_id, url, music_path, sync_mode, on_progress)
    elif source == 'spotify':
        return sync_spotify_playlist(playlist_id, url, music_path, sync_mode, on_progress)
    else:
        return {'success': False, 'error': f'Unknown source {source}'}
