"""Background worker that periodically syncs linked playlists."""

import threading
import time
from datetime import datetime

from models.playlist_sync import PlaylistSyncModel
from models.database import Database

_worker_thread = None
_worker_lock = threading.Lock()
_wakeup = threading.Event()
POLL_INTERVAL = 60  # seconds between checks for due syncs


def notify():
    _wakeup.set()


def _run_single_sync(sync_row, music_path):
    sync_id = sync_row['id']
    playlist_id = sync_row['playlist_id']
    source = sync_row['source']
    url = sync_row['url']
    sync_mode = sync_row.get('sync_mode') or 'mirror'
    interval_hours = sync_row.get('interval_hours') or 24

    print(f"[sync-worker] syncing playlist {playlist_id} ({source}) id={sync_id}")
    PlaylistSyncModel.mark_running(sync_id)
    try:
        from utils.playlist_sync import sync_playlist
        # Downloaded songs go to the playlist owner's library; without a
        # grant they would be hidden even from the playlist they synced into.
        owner = Database.execute_query(
            "SELECT owner_user_id FROM playlists WHERE id = %s", (playlist_id,),
            fetch_one=True)
        result = sync_playlist(playlist_id, source, url, music_path, sync_mode=sync_mode,
                               user_id=owner and owner.get('owner_user_id'))
        if result.get('success'):
            msg = f"Added {result.get('added',0)}, removed {result.get('removed',0)}, kept {result.get('kept',0)}, failed {result.get('failed',0)}"
            PlaylistSyncModel.mark_completed(sync_id, msg, interval_hours)
            # history
            try:
                PlaylistSyncModel.add_history(
                    sync_id, playlist_id,
                    added=result.get('added',0), removed=result.get('removed',0),
                    kept=result.get('kept',0), failed=result.get('failed',0),
                    total_remote=result.get('total_remote',0),
                    status='success', message=msg,
                    details={'added': result.get('added_details') or [], 'removed': result.get('removed_details') or []}
                )
            except Exception as he:
                print(f"[sync-worker] history write failed: {he}")
            print(f"[sync-worker] sync {sync_id} success: {msg}")
        else:
            err = result.get('error', 'Sync failed')
            PlaylistSyncModel.mark_failed(sync_id, err, interval_hours)
            try:
                PlaylistSyncModel.add_history(sync_id, playlist_id, status='failed', message=str(err))
            except Exception:
                pass
            print(f"[sync-worker] sync {sync_id} failed: {err}")
    except Exception as e:  # noqa
        print(f"[sync-worker] sync {sync_id} crashed: {e}")
        try:
            PlaylistSyncModel.mark_failed(sync_id, str(e), interval_hours)
            PlaylistSyncModel.add_history(sync_id, playlist_id, status='failed', message=str(e))
        except Exception:
            pass


def _worker_loop():
    from models.settings import SettingsModel
    print("[sync-worker] started")
    while True:
        try:
            music_path = SettingsModel.get_music_path()
            if not music_path:
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue
            due = PlaylistSyncModel.list_due(limit=5) or []
            if not due:
                _wakeup.wait(POLL_INTERVAL)
                _wakeup.clear()
                continue
            for sync_row in due:
                # re-check enabled / playlist still exists
                pl = Database.execute_query("SELECT id FROM playlists WHERE id=%s", (sync_row['playlist_id'],), fetch_one=True)
                if not pl:
                    # orphaned sync — delete it
                    PlaylistSyncModel.delete(sync_row['id'])
                    continue
                _run_single_sync(sync_row, music_path)
                # small pause between consecutive syncs
                time.sleep(2)
            # after processing batch, wait a bit
            _wakeup.wait(POLL_INTERVAL)
            _wakeup.clear()
        except Exception as e:  # noqa
            print(f"[sync-worker] loop error: {e}")
            time.sleep(POLL_INTERVAL)


def start_worker():
    global _worker_thread
    with _worker_lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _worker_thread = threading.Thread(target=_worker_loop, name='playlist-sync-worker', daemon=True)
        _worker_thread.start()
