"""Background worker that drains the lightshow_jobs queue.

  - scope='song'     -> analyse one song into a light show score
  - scope='backfill' -> analyse every song missing an up-to-date score

Same lifecycle as the enrichment worker: one daemon thread per process,
started lazily from the first request; start_worker() is idempotent.
"""
import json
import os
import threading
import time

from models.database import Database
from models.lightshow_job import LightshowJobModel
from utils.lightshow_analyzer import ANALYZER_VERSION

_worker_thread = None
_worker_lock = threading.Lock()
_wakeup = threading.Event()
POLL_INTERVAL = 2.0


def notify():
    """Wake the worker immediately (e.g. right after enqueuing a job)."""
    _wakeup.set()


def enqueue_song(song_id, force=False):
    """Queue one song and wake the worker. Best-effort: never raises."""
    try:
        LightshowJobModel.enqueue_song(song_id, force=force)
        notify()
    except Exception as e:  # noqa: BLE001
        print(f"[lightshow-worker] failed to queue song {song_id}: {e}")


def _song_label(song):
    title = (song.get('title') or 'Unknown title').strip()
    artist = (song.get('artist') or '').split(',')[0].strip()
    if len(title) > 40:
        title = title[:39].rstrip() + '…'
    label = f'"{title}"'
    if artist and artist != 'Unknown Artist':
        label += f' — {artist}'
    return label


def _song_tags(song):
    """(name, weight) pairs used to pick the genre profile."""
    tags = []
    try:
        from models.song_metadata import SongTagsModel
        for t in SongTagsModel.get(song['id']) or []:
            tags.append((t.get('tag_name'), t.get('weight') or 50))
    except Exception:  # noqa: BLE001
        pass
    genre = (song.get('genre') or '').strip()
    if genre:
        tags.append((genre, 100))
    return tags


def analyse_song(song, music_path):
    """Analyse + store one song. Returns a short summary dict."""
    from utils import lightshow_analyzer

    full = os.path.normpath(os.path.join(music_path, song['file_path']))
    if not os.path.isfile(full):
        raise FileNotFoundError(f"Audio file missing: {song['file_path']}")
    score = lightshow_analyzer.analyze_file(full, tags=_song_tags(song))
    if not score:
        raise ValueError('Audio too short or unreadable')
    LightshowJobModel.save_score(song['id'], score)
    return {
        'tempo': score['tempo'],
        'genre': score['profile']['genre'],
        'sections': len(score['sections']),
    }


def _process_song_job(job, music_path):
    job_id = job['id']
    song = Database.execute_query("SELECT * FROM songs WHERE id = %s", (job['song_id'],), fetch_one=True)
    if not song:
        # Deleted meanwhile (e.g. dedupe merged it into an existing song).
        LightshowJobModel.complete(job_id, {'skipped': 'song not found'})
        return
    if not job.get('force_full'):
        existing = LightshowJobModel.get_score(song['id'])
        if existing and existing[0] >= ANALYZER_VERSION:
            LightshowJobModel.complete(job_id, {'skipped': 'up to date'})
            return
    LightshowJobModel.update_progress(job_id, 10, f"{_song_label(song)} · analysing…")
    try:
        summary = analyse_song(song, music_path)
        LightshowJobModel.complete(job_id, summary)
    except Exception as e:  # noqa: BLE001
        print(f"[lightshow-worker] song job {job_id} failed: {e}")
        LightshowJobModel.fail(job_id, str(e))


def _process_backfill_job(job, music_path):
    job_id = job['id']
    force = bool(job.get('force_full'))
    songs = LightshowJobModel.songs_needing_analysis(force=force)
    if job.get('song_ids'):
        try:
            scope = set(json.loads(job['song_ids']))
            songs = [s for s in songs if s['id'] in scope]
        except (ValueError, TypeError):
            pass
    total = len(songs)
    if total == 0:
        LightshowJobModel.complete(job_id, {'total': 0, 'analysed': 0, 'failed': 0, 'forced': force})
        return

    analysed = failed = 0
    for i, song in enumerate(songs):
        LightshowJobModel.update_progress(
            job_id, int(i / total * 100), f"[{i + 1}/{total}] {_song_label(song)}")
        try:
            analyse_song(song, music_path)
            analysed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"[lightshow-worker] backfill song {song['id']} failed: {e}")
        # Let single-song jobs (fresh imports, manual re-analysis) jump in.
        while True:
            urgent = Database.execute_query(
                "SELECT id FROM lightshow_jobs WHERE status = 'queued' AND scope = 'song' LIMIT 1",
                fetch_one=True,
            )
            if not urgent:
                break
            nxt = LightshowJobModel.claim_next()
            if not nxt:
                break
            _process_job(nxt, music_path)

    LightshowJobModel.complete(job_id, {'total': total, 'analysed': analysed, 'failed': failed, 'forced': force})


def _process_job(job, music_path):
    if job['scope'] == 'backfill':
        _process_backfill_job(job, music_path)
    else:
        _process_song_job(job, music_path)


def _worker_loop():
    from models.settings import SettingsModel

    print("[lightshow-worker] started")
    last_recover = 0.0
    while True:
        try:
            if time.time() - last_recover > 60:
                last_recover = time.time()
                LightshowJobModel.recover_stale()
            music_path = SettingsModel.get_music_path()
            job = LightshowJobModel.claim_next() if music_path else None
            if job is None:
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue
            print(f"[lightshow-worker] processing job {job['id']} ({job['scope']})")
            try:
                _process_job(job, music_path)
            except Exception as e:  # noqa: BLE001
                print(f"[lightshow-worker] job {job['id']} crashed: {e}")
                LightshowJobModel.fail(job['id'], str(e))
        except Exception as e:  # noqa: BLE001
            print(f"[lightshow-worker] loop error: {e}")
            time.sleep(POLL_INTERVAL)


def start_worker():
    """Start the background worker thread (idempotent)."""
    global _worker_thread
    with _worker_lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _worker_thread = threading.Thread(target=_worker_loop, name='lightshow-worker', daemon=True)
        _worker_thread.start()
