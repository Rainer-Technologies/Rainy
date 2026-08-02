"""Background worker that drains the enrichment_jobs queue.

A single daemon thread processes enrichment jobs one at a time:
  - scope='song'     -> enrich one song (audio analysis + external metadata)
  - scope='backfill' -> enrich every song in the library that lacks features

Only one worker runs per process; start_worker() is idempotent and
reloader-safe (call it from app startup, guarded like the import worker).
"""
import os
import threading
import time

from models.database import Database
from models.enrichment_job import EnrichmentJobModel
from models.song_metadata import SongFeaturesModel, SongMetadataModel
from utils import audio_analyzer, lastfm

_worker_thread = None
_worker_lock = threading.Lock()
_wakeup = threading.Event()
POLL_INTERVAL = 2.0


def notify():
    """Wake the worker immediately (e.g. right after enqueuing a job)."""
    _wakeup.set()


def _full_path(music_path, rel_path):
    return os.path.normpath(os.path.join(music_path, rel_path))


def _song_label(song):
    """Short '"Title" — Artist' label used in progress messages."""
    title = (song.get('title') or 'Unknown title').strip()
    artist = (song.get('artist') or '').split(',')[0].strip()
    if len(title) > 40:
        title = title[:39].rstrip() + '…'
    label = f'"{title}"'
    if artist and artist != 'Unknown Artist':
        label += f' — {artist}'
    return label


def _enrich_one_song(song, music_path, on_progress, force=False):
    """Run audio analysis + external metadata for one song row.

    With ``force=False`` the (expensive) local audio analysis only runs when
    the song has no features yet; external metadata is always refreshed. With
    ``force=True`` everything is recomputed from scratch.
    """
    song_id = song['id']

    # 1. Local audio analysis (librosa) — skip if we already have it,
    #    unless this is a forced re-analysis.
    on_progress(5, 'Analysing audio (tempo, key, timbre)…')
    existing = SongFeaturesModel.get(song_id)
    if force or not existing:
        full = _full_path(music_path, song['file_path'])
        if os.path.isfile(full):
            features = audio_analyzer.analyze_file(full)
            if features:
                SongFeaturesModel.upsert(song_id, features)

    # 2. External metadata (Last.fm + MusicBrainz).
    summary = lastfm.enrich_song(
        song_id, song.get('artist'), song.get('title'),
        on_progress=on_progress,
    )

    # 3. Mark the song as enriched so future "analyse unanalysed" jobs skip it.
    SongMetadataModel.mark_enriched(song_id)
    return summary


def _process_song_job(job, music_path):
    job_id = job['id']
    song = Database.execute_query(
        "SELECT * FROM songs WHERE id = %s", (job['song_id'],), fetch_one=True,
    )
    if not song:
        EnrichmentJobModel.fail(job_id, 'Song not found')
        return

    def on_progress(pct, msg):
        try:
            text = f"{_song_label(song)} · {msg}"
            EnrichmentJobModel.update_progress(job_id, int(pct), text[:500])
        except Exception as e:  # noqa: BLE001
            print(f"[enrich-worker] progress update failed: {e}")

    try:
        summary = _enrich_one_song(song, music_path, on_progress, force=bool(job.get('force_full')))
        EnrichmentJobModel.complete(job_id, {'enriched': 1, **summary})
    except Exception as e:  # noqa: BLE001
        print(f"[enrich-worker] song job {job_id} crashed: {e}")
        EnrichmentJobModel.fail(job_id, str(e))


def _process_backfill_job(job, music_path):
    """Enrich songs library-wide, streaming overall progress.

    A normal backfill only touches songs that haven't been enriched yet
    (``enriched_at IS NULL``); a forced one re-analyses the entire library.
    """
    job_id = job['id']
    force = bool(job.get('force_full'))
    if force:
        songs = Database.execute_query(
            "SELECT * FROM songs ORDER BY id ASC", fetch_all=True,
        ) or []
    else:
        songs = Database.execute_query(
            "SELECT * FROM songs WHERE enriched_at IS NULL ORDER BY id ASC",
            fetch_all=True,
        ) or []
    total = len(songs)
    done = 0
    enriched = 0
    failed = 0

    if total == 0:
        EnrichmentJobModel.complete(job_id, {
            'total': 0, 'enriched': 0, 'failed': 0, 'forced': force,
        })
        return

    EnrichmentJobModel.update_progress(
        job_id, 0,
        f"Analysing {total} song{'s' if total != 1 else ''}"
        f"{' (full re-analysis)' if force else ''}…",
    )

    try:
        for i, song in enumerate(songs):
            def on_progress(_pct, msg):
                # Map per-song progress into the overall 0-100 range.
                overall = int(((i + _pct / 100.0) / max(total, 1)) * 100)
                try:
                    EnrichmentJobModel.update_progress(
                        job_id, min(overall, 99),
                        f"[{i + 1}/{total}] {_song_label(song)} · {msg}",
                    )
                except Exception:  # noqa: BLE001
                    pass

            try:
                _enrich_one_song(song, music_path, on_progress, force=force)
                enriched += 1
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"[enrich-worker] backfill song {song['id']} failed: {e}")
            done += 1

        EnrichmentJobModel.complete(job_id, {
            'total': total, 'enriched': enriched, 'failed': failed,
            'forced': force,
        })
    except Exception as e:  # noqa: BLE001
        print(f"[enrich-worker] backfill job {job_id} crashed: {e}")
        EnrichmentJobModel.fail(job_id, str(e))


def _process_job(job, music_path):
    if job['scope'] == 'backfill':
        _process_backfill_job(job, music_path)
    else:
        _process_song_job(job, music_path)


def _worker_loop():
    from models.settings import SettingsModel

    print("[enrich-worker] started")
    while True:
        try:
            music_path = SettingsModel.get_music_path()
            if not music_path:
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue

            job = EnrichmentJobModel.claim_next()
            if job is None:
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue

            print(f"[enrich-worker] processing job {job['id']} ({job['scope']})")
            _process_job(job, music_path)
        except Exception as e:  # noqa: BLE001
            print(f"[enrich-worker] loop error: {e}")
            time.sleep(POLL_INTERVAL)


def start_worker():
    """Start the background worker thread (idempotent)."""
    global _worker_thread
    with _worker_lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _worker_thread = threading.Thread(
            target=_worker_loop, name='enrichment-worker', daemon=True,
        )
        _worker_thread.start()
