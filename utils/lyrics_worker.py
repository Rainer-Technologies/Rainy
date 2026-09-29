"""Background worker that drains the lyrics_jobs queue.

  - scope='song'     -> analyse one song (fetch lyrics if never looked up,
                        then align the words to the audio)
  - scope='backfill' -> analyse every song that still needs it

Same lifecycle as the light show worker: one daemon thread per process,
started lazily from the first request; start_worker() is idempotent.
"""
import json
import os
import threading
import time

from models.database import Database
from models.lyrics_job import LyricsJobModel
from utils.lyrics_align import ALIGN_VERSION

_worker_thread = None
_worker_lock = threading.Lock()
_wakeup = threading.Event()
POLL_INTERVAL = 2.0
MAX_REPORTED_FAILURES = 5


def notify():
    """Wake the worker immediately (e.g. right after enqueuing a job)."""
    _wakeup.set()


def enqueue_song(song_id, force=False):
    """Queue one song and wake the worker. Best-effort: never raises."""
    try:
        job_id = LyricsJobModel.enqueue_song(song_id, force=force)
        notify()
        return job_id
    except Exception as e:  # noqa: BLE001
        print(f"[lyrics-worker] failed to queue song {song_id}: {e}")
        return None


def _song_label(song):
    title = (song.get('title') or 'Unknown title').strip()
    artist = (song.get('artist') or '').split(',')[0].strip()
    if len(title) > 40:
        title = title[:39].rstrip() + '…'
    label = f'"{title}"'
    if artist and artist != 'Unknown Artist':
        label += f' — {artist}'
    return label


def _fetch_lyrics(song):
    """Look the song up on LRCLIB and store the result. Returns the new row."""
    from routes.music import _fetch_lyrics_from_lrclib
    synced, plain = _fetch_lyrics_from_lrclib(
        song.get('title'), song.get('artist'), song.get('album'), song.get('duration'))
    LyricsJobModel.save_lyrics(song['id'], synced, plain)
    return LyricsJobModel.get_lyrics(song['id'])


def analyse_song(song, music_path, force=False, progress=None):
    """Fetch (if needed) + align one song. Returns a short summary dict.

    ``progress(done, total)`` is called as the aligner works through the lyrics.
    Raises on failure; a song that simply has no synced lyrics is a skip.
    """
    from utils import lyrics_align

    summary = {}
    row = LyricsJobModel.get_lyrics(song['id'])
    if row is None:
        row = _fetch_lyrics(song)
        summary['fetched'] = bool(row and row.get('found'))
    if not row or not row.get('found') or not row.get('synced'):
        summary['skipped'] = 'no synced lyrics'
        return summary

    if not force:
        existing = LyricsJobModel.get_words(song['id'])
        if existing and existing[0] >= ALIGN_VERSION:
            summary['skipped'] = 'up to date'
            return summary

    synced = json.loads(row['synced'])
    full = os.path.normpath(os.path.join(music_path, song['file_path']))
    if not os.path.isfile(full):
        raise FileNotFoundError(f"Audio file missing: {song['file_path']}")

    out = lyrics_align.align_synced_lyrics(full, synced, progress=progress)
    LyricsJobModel.save_words(song['id'], out['words'], out['language'])
    summary.update(out['stats'])
    summary['language'] = out['language']
    return summary


def _process_song_job(job, music_path):
    job_id = job['id']
    song = Database.execute_query("SELECT * FROM songs WHERE id = %s", (job['song_id'],), fetch_one=True)
    if not song:
        # Deleted meanwhile (e.g. dedupe merged it into an existing song).
        LyricsJobModel.complete(job_id, {'skipped': 'song not found'})
        return
    label = _song_label(song)
    LyricsJobModel.update_progress(job_id, 5, f"{label} · starting…")

    def progress(done, total):
        LyricsJobModel.update_progress(
            job_id, 5 + int(90 * done / max(total, 1)), f"{label} · line {done}/{total}")

    try:
        summary = analyse_song(song, music_path, force=bool(job.get('force_full')), progress=progress)
        LyricsJobModel.complete(job_id, summary)
    except Exception as e:  # noqa: BLE001
        print(f"[lyrics-worker] song job {job_id} failed: {e}")
        LyricsJobModel.fail(job_id, str(e))


def _process_backfill_job(job, music_path):
    job_id = job['id']
    force = bool(job.get('force_full'))
    songs = LyricsJobModel.songs_needing_analysis(force=force)
    if job.get('song_ids'):
        try:
            scope = set(json.loads(job['song_ids']))
            songs = [s for s in songs if s['id'] in scope]
        except (ValueError, TypeError):
            pass
    total = len(songs)
    result = {'total': total, 'aligned': 0, 'fetched': 0, 'no_lyrics': 0,
              'skipped': 0, 'failed': 0, 'forced': force, 'failures': []}
    if total == 0:
        LyricsJobModel.complete(job_id, result)
        return

    for i, song in enumerate(songs):
        label = _song_label(song)
        base = i / total

        def progress(done, n, base=base, i=i, label=label):
            LyricsJobModel.update_progress(
                job_id, int((base + done / max(n, 1) / total) * 100),
                f"[{i + 1}/{total}] {label} · line {done}/{n}")

        LyricsJobModel.update_progress(job_id, int(base * 100), f"[{i + 1}/{total}] {label}")
        try:
            summary = analyse_song(song, music_path, force=force, progress=progress)
            if summary.get('fetched'):
                result['fetched'] += 1
            if summary.get('skipped') == 'no synced lyrics':
                result['no_lyrics'] += 1
            elif summary.get('skipped'):
                result['skipped'] += 1
            else:
                result['aligned'] += 1
        except Exception as e:  # noqa: BLE001
            result['failed'] += 1
            if len(result['failures']) < MAX_REPORTED_FAILURES:
                result['failures'].append({'song': label, 'error': str(e)[:200]})
            print(f"[lyrics-worker] backfill song {song['id']} failed: {e}")
        # Let single-song jobs (someone opened a song's lyrics) jump in.
        while True:
            urgent = Database.execute_query(
                "SELECT id FROM lyrics_jobs WHERE status = 'queued' AND scope = 'song' LIMIT 1",
                fetch_one=True,
            )
            if not urgent:
                break
            nxt = LyricsJobModel.claim_next()
            if not nxt:
                break
            _process_job(nxt, music_path)

    LyricsJobModel.complete(job_id, result)


def _process_job(job, music_path):
    if job['scope'] == 'backfill':
        _process_backfill_job(job, music_path)
    else:
        _process_song_job(job, music_path)


def _worker_loop():
    from models.settings import SettingsModel

    print("[lyrics-worker] started")
    last_recover = 0.0
    while True:
        try:
            if time.time() - last_recover > 60:
                last_recover = time.time()
                LyricsJobModel.recover_stale()
            music_path = SettingsModel.get_music_path()
            job = LyricsJobModel.claim_next() if music_path else None
            if job is None:
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue
            print(f"[lyrics-worker] processing job {job['id']} ({job['scope']})")
            try:
                _process_job(job, music_path)
            except Exception as e:  # noqa: BLE001
                print(f"[lyrics-worker] job {job['id']} crashed: {e}")
                LyricsJobModel.fail(job['id'], str(e))
        except Exception as e:  # noqa: BLE001
            print(f"[lyrics-worker] loop error: {e}")
            time.sleep(POLL_INTERVAL)


def start_worker():
    """Start the background worker thread (idempotent)."""
    global _worker_thread
    with _worker_lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _worker_thread = threading.Thread(target=_worker_loop, name='lyrics-worker', daemon=True)
        _worker_thread.start()
