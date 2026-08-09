"""Data-access layer for playlist periodic sync jobs."""

from datetime import datetime, timedelta

from models.database import Database


class PlaylistSyncModel:
    VALID_INTERVALS = [1, 3, 6, 12, 24, 48, 72, 168]  # hours
    VALID_MODES = ['add_only', 'mirror']
    VALID_SOURCES = ['youtube', 'spotify']

    @staticmethod
    def create(playlist_id, source, url, interval_hours=24, sync_mode='mirror', enabled=True):
        """Create a sync config for a local playlist. Returns id."""
        interval_hours = int(interval_hours)
        if interval_hours not in PlaylistSyncModel.VALID_INTERVALS:
            interval_hours = 24
        if sync_mode not in PlaylistSyncModel.VALID_MODES:
            sync_mode = 'mirror'
        now = datetime.now()
        next_sync = now + timedelta(hours=interval_hours)
        query = """
            INSERT INTO playlist_syncs
                (playlist_id, source, url, interval_hours, sync_mode, enabled, next_sync_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """
        return Database.execute_query(query, (
            playlist_id, source, url, interval_hours, sync_mode, 1 if enabled else 0, next_sync
        ))

    @staticmethod
    def get(sync_id):
        query = "SELECT * FROM playlist_syncs WHERE id = %s"
        return Database.execute_query(query, (sync_id,), fetch_one=True)

    @staticmethod
    def get_by_playlist(playlist_id):
        query = "SELECT * FROM playlist_syncs WHERE playlist_id = %s"
        return Database.execute_query(query, (playlist_id,), fetch_one=True)

    @staticmethod
    def list_all():
        query = """
            SELECT ps.*, p.name as playlist_name, p.icon, p.icon_color
            FROM playlist_syncs ps
            JOIN playlists p ON p.id = ps.playlist_id
            ORDER BY ps.next_sync_at ASC
        """
        return Database.execute_query(query, fetch_all=True)

    @staticmethod
    def list_due(limit=10):
        """Return syncs that are due (enabled and next_sync_at <= now)."""
        query = """
            SELECT * FROM playlist_syncs
            WHERE enabled = 1 AND next_sync_at <= NOW()
            ORDER BY next_sync_at ASC
            LIMIT %s
        """
        return Database.execute_query(query, (limit,), fetch_all=True)

    @staticmethod
    def update(sync_id, **fields):
        allowed = {'source','url','interval_hours','sync_mode','enabled'}
        sets = []
        vals = []
        for k,v in fields.items():
            if k not in allowed:
                continue
            if k == 'interval_hours':
                v = int(v)
                if v not in PlaylistSyncModel.VALID_INTERVALS:
                    continue
                # also reschedule next_sync if interval changes
                # caller will handle next_sync recalc, but we update field here
            if k == 'enabled':
                v = 1 if v else 0
            sets.append(f"{k} = %s")
            vals.append(v)
        if not sets:
            return None
        # if interval_hours changed, recompute next_sync_at
        if 'interval_hours' in fields:
            sets.append("next_sync_at = %s")
            vals.append(datetime.now() + timedelta(hours=int(fields['interval_hours'])))
        vals.append(sync_id)
        query = f"UPDATE playlist_syncs SET {', '.join(sets)} WHERE id = %s"
        return Database.execute_query(query, tuple(vals))

    @staticmethod
    def delete(sync_id):
        query = "DELETE FROM playlist_syncs WHERE id = %s"
        return Database.execute_query(query, (sync_id,))

    @staticmethod
    def delete_by_playlist(playlist_id):
        query = "DELETE FROM playlist_syncs WHERE playlist_id = %s"
        return Database.execute_query(query, (playlist_id,))

    @staticmethod
    def mark_running(sync_id):
        query = """
            UPDATE playlist_syncs
            SET last_status = 'running', last_message = 'Syncing...'
            WHERE id = %s
        """
        return Database.execute_query(query, (sync_id,))

    @staticmethod
    def mark_completed(sync_id, message, interval_hours):
        next_sync = datetime.now() + timedelta(hours=int(interval_hours))
        query = """
            UPDATE playlist_syncs
            SET last_synced_at = NOW(), next_sync_at = %s,
                last_status = 'success', last_message = %s
            WHERE id = %s
        """
        return Database.execute_query(query, (next_sync, message[:500] if message else None, sync_id))

    @staticmethod
    def mark_failed(sync_id, error, interval_hours):
        next_sync = datetime.now() + timedelta(hours=int(interval_hours))
        query = """
            UPDATE playlist_syncs
            SET last_status = 'failed', last_message = %s, next_sync_at = %s
            WHERE id = %s
        """
        return Database.execute_query(query, (str(error)[:500], next_sync, sync_id))

    @staticmethod
    def bump_next_sync(sync_id, interval_hours):
        next_sync = datetime.now() + timedelta(hours=int(interval_hours))
        query = "UPDATE playlist_syncs SET next_sync_at = %s WHERE id = %s"
        return Database.execute_query(query, (next_sync, sync_id))

    # ---- History ----

    @staticmethod
    def add_history(sync_id, playlist_id, added=0, removed=0, kept=0, failed=0, total_remote=0, status='success', message=None, details=None):
        import json as _json
        details_json = _json.dumps(details) if details is not None else None
        query = """
            INSERT INTO playlist_sync_history
                (sync_id, playlist_id, added_count, removed_count, kept_count, failed_count, total_remote, status, message, details_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        return Database.execute_query(query, (
            sync_id, playlist_id, added, removed, kept, failed, total_remote, status, message[:1000] if message else None, details_json
        ))

    @staticmethod
    def get_history(sync_id, limit=20):
        query = """
            SELECT * FROM playlist_sync_history
            WHERE sync_id = %s
            ORDER BY ran_at DESC, id DESC
            LIMIT %s
        """
        return Database.execute_query(query, (sync_id, limit), fetch_all=True)

    @staticmethod
    def get_all_history(limit=50):
        query = """
            SELECT h.*, p.name as playlist_name
            FROM playlist_sync_history h
            JOIN playlist_syncs ps ON ps.id = h.sync_id
            JOIN playlists p ON p.id = h.playlist_id
            ORDER BY h.ran_at DESC, h.id DESC
            LIMIT %s
        """
        return Database.execute_query(query, (limit,), fetch_all=True)
