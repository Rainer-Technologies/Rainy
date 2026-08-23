"""Background worker that drains the import_jobs queue.

A single daemon thread polls for queued jobs and processes them one at a
time, streaming progress into the database so the frontend can poll for
live status. Only one worker runs per process; `start_worker()` is
idempotent and reloader-safe (call it from app startup).
"""
import threading
import time

from models.import_job import ImportJobModel
from utils.import_jobs import IMPORT_HANDLERS

_worker_thread = None
_worker_lock = threading.Lock()
_wakeup = threading.Event()
POLL_INTERVAL = 2.0  # seconds between idle polls


def notify():
    """Wake the worker immediately (e.g. right after enqueuing a job)."""
    _wakeup.set()


def _process_job(job, music_path):
    """Run a single import job, updating its DB row as it progresses."""
    job_id = job['id']
    handler = IMPORT_HANDLERS.get((job['source'], job['kind']))
    if handler is None:
        ImportJobModel.fail(job_id, f"Unknown job type: {job['source']}/{job['kind']}")
        return

    def on_progress(percent, message):
        try:
            ImportJobModel.update_progress(job_id, int(percent), str(message)[:500])
        except Exception as e:  # noqa: BLE001
            print(f"[import-worker] progress update failed for job {job_id}: {e}")

    try:
        result = handler(
            job['url'], music_path, on_progress=on_progress,
            conflict_mode=job.get('conflict_mode'),
            owner_user_id=job.get('user_id'),
        )
        if result.get('success'):
            ImportJobModel.complete(job_id, result)
        else:
            ImportJobModel.fail(job_id, result.get('error', 'Import failed'))
    except Exception as e:  # noqa: BLE001
        print(f"[import-worker] job {job_id} crashed: {e}")
        ImportJobModel.fail(job_id, str(e))


def _worker_loop():
    """Main loop: claim and process jobs until the process exits."""
    from models.settings import SettingsModel

    print("[import-worker] started")
    while True:
        try:
            music_path = SettingsModel.get_music_path()
            if not music_path:
                # Nothing configured yet; wait and retry.
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue

            job = ImportJobModel.claim_next()
            if job is None:
                # Queue empty — sleep until woken or the poll interval elapses.
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue

            print(f"[import-worker] processing job {job['id']} "
                  f"({job['source']}/{job['kind']})")
            _process_job(job, music_path)
        except Exception as e:  # noqa: BLE001
            # Never let the worker thread die from an unexpected error.
            print(f"[import-worker] loop error: {e}")
            time.sleep(POLL_INTERVAL)


def start_worker():
    """Start the background worker thread (idempotent).

    Callers are responsible for only invoking this in the actual server
    process (see app.init_app for the debug-reloader guard).
    """
    global _worker_thread

    with _worker_lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _worker_thread = threading.Thread(
            target=_worker_loop, name='import-job-worker', daemon=True
        )
        _worker_thread.start()
