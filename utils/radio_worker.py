"""Background workers for the song radio (see utils/ytradio.py).

  - Download threads drain `radio_tracks`: fetch the track, register it as
    a transient song and mark it ready for the radios waiting on it.
  - One maintenance thread, when nothing else is going on, slowly learns
    the library's YouTube Music side (each song's video id and its radio —
    what the co-occurrence ranking is built from) and deletes radio
    downloads nobody kept.

Only one set of workers runs per process; start_worker() is idempotent.
Claims use per-claim tokens, so several server processes can each run one.
"""
import os
import threading
import time

from models.database import Database
from models.radio import RadioTrackModel
from utils import ytradio

DOWNLOAD_THREADS = 2
POLL_INTERVAL = 2.0
LEARN_INTERVAL = 3.0          # pause between background YouTube Music calls
IDLE_INTERVAL = 60.0
CLEANUP_INTERVAL = 3600.0
STARTUP_DELAY = 30.0

_threads = []
_lock = threading.Lock()
_wakeup = threading.Event()


def notify():
    """Wake the download threads (right after queueing a track)."""
    _wakeup.set()


# ---------------------------------------------------------------- downloads

def _register(track, file_path, music_path):
    """Turn a downloaded file into a transient song. Returns its song id
    (an existing song's id when the file duplicates one)."""
    from models.song import SongModel
    from utils import dedupe
    from utils.scanner import MusicScanner

    video_id = track['video_id']
    metadata = MusicScanner(music_path).scan_single_file(file_path, analysis=False)
    if not metadata or not metadata.get('id'):
        raise RuntimeError('Could not read the downloaded file')
    song_id = metadata['id']
    Database.execute_query(
        "UPDATE songs SET transient = 1, youtube_id = %s, youtube_matched_at = NOW() "
        "WHERE id = %s", (video_id, song_id))

    # Title/artist/album as YouTube Music lists them: the file's tags credit
    # every songwriter as an artist. What the radio queued is the fallback.
    info = None
    try:
        info = ytradio.track_info(video_id)
    except Exception as e:  # noqa: BLE001
        print(f"[radio-worker] no track info for {video_id}: {e}")
    info = info or track
    if info.get('title'):
        SongModel.update_song_metadata(metadata['path'], {
            'title': info['title'],
            'artist': info.get('artist') or None,
            'album': info.get('album') or None,
        })

    dup = dedupe.finalize_new_song(file_path, song_id, duration=metadata.get('duration'))
    if dup:
        return dup[0]
    _queue_analysis(song_id)
    return song_id


def _queue_analysis(song_id):
    """Enrichment and lyrics for a new radio song, now that it carries the
    title and artist to look them up with. The (heavy) light show analysis
    waits until someone plays or keeps the song."""
    try:
        from models.enrichment_job import EnrichmentJobModel
        from utils import enrichment_worker
        EnrichmentJobModel.enqueue_song(song_id)
        enrichment_worker.notify()
    except Exception as e:  # noqa: BLE001
        print(f"[radio-worker] failed to queue enrichment for song {song_id}: {e}")
    from utils import lyrics_worker
    lyrics_worker.enqueue_song(song_id)


def _download(track, music_path):
    from utils.youtube import YouTubeDownloader

    video_id = track['video_id']
    existing = Database.execute_query(
        "SELECT id FROM songs WHERE youtube_id = %s LIMIT 1", (video_id,), fetch_one=True)
    if existing:
        RadioTrackModel.mark_ready(video_id, existing['id'])
        return
    result = YouTubeDownloader(music_path).download_radio_track(
        video_id, ytradio.radio_dir(music_path))
    if not result.get('success'):
        RadioTrackModel.fail(video_id, result.get('error') or 'Download failed')
        return
    RadioTrackModel.mark_ready(video_id, _register(track, result['file_path'], music_path))


def _download_loop():
    from models.settings import SettingsModel

    while True:
        try:
            music_path = SettingsModel.get_music_path()
            track = RadioTrackModel.claim_next() if music_path else None
            if track is None:
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue
            try:
                _download(track, music_path)
            except Exception as e:  # noqa: BLE001
                print(f"[radio-worker] {track['video_id']} failed: {e}")
                RadioTrackModel.fail(track['video_id'], e)
        except Exception as e:  # noqa: BLE001
            print(f"[radio-worker] loop error: {e}")
            time.sleep(POLL_INTERVAL)


# -------------------------------------------------------------- maintenance

def _learn_one():
    """One small step of getting to know the library on YouTube Music.
    Returns False when there is nothing left to do."""
    song = Database.execute_query(
        "SELECT id, title, artist, duration, youtube_id, youtube_matched_at, youtube_match_version "
        "FROM songs WHERE transient = 0 AND youtube_id IS NULL "
        "AND (youtube_matched_at IS NULL OR youtube_match_version < %s) "
        "ORDER BY id DESC LIMIT 1", (ytradio.MATCH_VERSION,), fetch_one=True)
    if song:
        ytradio.ensure_video_id(song)
        return True
    row = Database.execute_query(
        "SELECT s.youtube_id FROM songs s WHERE s.transient = 0 AND s.youtube_id IS NOT NULL "
        "AND NOT EXISTS (SELECT 1 FROM yt_radio_cache c WHERE c.video_id = s.youtube_id) "
        "ORDER BY s.id DESC LIMIT 1", fetch_one=True)
    if row:
        if not ytradio.fetch_radio(row['youtube_id']):
            # Nothing came back: remember that, or this song is retried forever.
            from models.radio import RadioCacheModel
            RadioCacheModel.put(row['youtube_id'], {'deep': False, 'tracks': []})
        return True
    return False


def _maintenance_loop():
    from models.settings import SettingsModel

    time.sleep(STARTUP_DELAY)
    last_cleanup = 0.0
    while True:
        try:
            if time.time() - last_cleanup >= CLEANUP_INTERVAL:
                last_cleanup = time.time()
                RadioTrackModel.recover_stale()
                music_path = SettingsModel.get_music_path()
                if music_path:
                    deleted, promoted = ytradio.cleanup(music_path)
                    if deleted or promoted:
                        print(f"[radio-worker] cleanup: {deleted} deleted, {promoted} kept")
            time.sleep(LEARN_INTERVAL if _learn_one() else IDLE_INTERVAL)
        except Exception as e:  # noqa: BLE001
            print(f"[radio-worker] maintenance error: {e}")
            time.sleep(IDLE_INTERVAL)


def start_worker():
    """Start the radio workers (idempotent).

    RAINY_RADIO_BACKGROUND=0 turns off the maintenance thread (background
    YouTube Music lookups and cleanup); downloads still work.
    """
    with _lock:
        if any(t.is_alive() for t in _threads):
            return
        _threads.clear()
        for i in range(DOWNLOAD_THREADS):
            _threads.append(threading.Thread(
                target=_download_loop, name=f'radio-download-{i}', daemon=True))
        if os.environ.get('RAINY_RADIO_BACKGROUND', '1') != '0':
            _threads.append(threading.Thread(
                target=_maintenance_loop, name='radio-maintenance', daemon=True))
        for t in _threads:
            t.start()
