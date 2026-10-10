"""Data-access layer for the song radio (see utils/ytradio.py).

Three small tables:
  - radio_tracks   : download queue, one row per YouTube Music track. Claims
                     use a per-claim token like lightshow_jobs, so it stays
                     safe with several server processes each running workers.
  - radio_access   : which user may play which transient (not yet kept) song.
  - yt_radio_cache : cached YouTube Music radios, keyed by seed video.
"""
import json
import uuid

from models.database import Database

MAX_ATTEMPTS = 3


def _in(values):
    return ', '.join(['%s'] * len(values))


class RadioTrackModel:
    """Queue helpers for `radio_tracks`."""

    @staticmethod
    def request(tracks):
        """Queue downloads for YouTube Music tracks (idempotent).

        tracks: [{'videoId', 'title', 'artist', 'album', 'duration',
        'cover_url'}]. A track that failed before is queued again until it
        runs out of attempts.
        """
        for t in tracks:
            Database.execute_query(
                """
                INSERT IGNORE INTO radio_tracks
                    (video_id, status, title, artist, album, duration, cover_url)
                VALUES (%s, 'queued', %s, %s, %s, %s, %s)
                """,
                (t['videoId'], (t.get('title') or '')[:255], (t.get('artist') or '')[:255],
                 (t.get('album') or '')[:255], int(t.get('duration') or 0),
                 (t.get('cover_url') or '')[:768] or None),
            )
        ids = [t['videoId'] for t in tracks]
        if ids:
            Database.execute_query(
                f"""
                UPDATE radio_tracks SET status = 'queued', claim_token = NULL, updated_at = NOW()
                WHERE status = 'failed' AND attempts < %s AND video_id IN ({_in(ids)})
                """,
                (MAX_ATTEMPTS, *ids),
            )

    @staticmethod
    def get_many(video_ids):
        if not video_ids:
            return {}
        rows = Database.execute_query(
            f"SELECT * FROM radio_tracks WHERE video_id IN ({_in(video_ids)})",
            tuple(video_ids), fetch_all=True,
        ) or []
        return {r['video_id']: r for r in rows}

    @staticmethod
    def claim_next():
        """Atomically claim the oldest queued download."""
        token = str(uuid.uuid4())
        Database.execute_query(
            """
            UPDATE radio_tracks
            SET status = 'running', started_at = NOW(), updated_at = NOW(),
                claim_token = %s, attempts = attempts + 1
            WHERE status = 'queued' AND video_id = (
                SELECT video_id FROM (
                    SELECT video_id FROM radio_tracks WHERE status = 'queued'
                    ORDER BY updated_at ASC LIMIT 1
                ) AS next_track
            )
            """,
            (token,),
        )
        return Database.execute_query(
            "SELECT * FROM radio_tracks WHERE claim_token = %s LIMIT 1", (token,), fetch_one=True,
        )

    @staticmethod
    def mark_ready(video_id, song_id):
        return Database.execute_query(
            "UPDATE radio_tracks SET status = 'ready', song_id = %s, error_message = NULL, "
            "updated_at = NOW() WHERE video_id = %s",
            (song_id, video_id),
        )

    @staticmethod
    def fail(video_id, error_message):
        return Database.execute_query(
            "UPDATE radio_tracks SET status = 'failed', error_message = %s, updated_at = NOW() "
            "WHERE video_id = %s",
            (str(error_message)[:2000], video_id),
        )

    @staticmethod
    def recover_stale(max_silence_minutes=5):
        """Re-queue downloads whose worker died mid-way."""
        return Database.execute_query(
            """
            UPDATE radio_tracks SET status = 'queued', claim_token = NULL
            WHERE status = 'running'
              AND COALESCE(started_at, created_at) < NOW() - INTERVAL %s MINUTE
            """,
            (int(max_silence_minutes),),
        )

    @staticmethod
    def forget_song(song_id):
        """Drop the queue row of a deleted song so it can be fetched again."""
        return Database.execute_query(
            "DELETE FROM radio_tracks WHERE song_id = %s", (song_id,))

    @staticmethod
    def drop_orphans():
        """'ready' rows whose song is gone (deleted elsewhere)."""
        return Database.execute_query(
            "DELETE FROM radio_tracks WHERE status = 'ready' AND "
            "(song_id IS NULL OR song_id NOT IN (SELECT id FROM songs))")


class RadioAccessModel:
    """Temporary play rights on transient songs (`radio_access`)."""

    @staticmethod
    def grant(user_id, song_id):
        """Let the user play the song; refreshes the timestamp if granted."""
        Database.execute_query(
            "INSERT IGNORE INTO radio_access (user_id, song_id) VALUES (%s, %s)",
            (user_id, song_id))
        Database.execute_query(
            "UPDATE radio_access SET last_used_at = NOW() WHERE user_id = %s AND song_id = %s",
            (user_id, song_id))

    @staticmethod
    def transient_songs():
        """Every transient song, least recently used first, with how many
        things still point at it (library rows, playlist entries)."""
        return Database.execute_query(
            """
            SELECT s.id, s.file_path, s.cover_path, s.title, s.artist,
                   (SELECT MAX(ra.last_used_at) FROM radio_access ra
                    WHERE ra.song_id = s.id) AS last_used_at,
                   (SELECT COUNT(*) FROM library_access la WHERE la.song_id = s.id) AS library_refs,
                   (SELECT COUNT(*) FROM playlist_entries pe WHERE pe.track_id = s.id) AS playlist_refs
            FROM songs s
            WHERE s.transient = 1
            ORDER BY last_used_at ASC
            """,
            fetch_all=True,
        ) or []

    @staticmethod
    def expired_song_ids(ttl_hours):
        """Transient songs nobody has had queued for ttl_hours."""
        rows = Database.execute_query(
            """
            SELECT s.id FROM songs s
            WHERE s.transient = 1 AND NOT EXISTS (
                SELECT 1 FROM radio_access ra
                WHERE ra.song_id = s.id AND ra.last_used_at >= NOW() - INTERVAL %s HOUR)
            """,
            (int(ttl_hours),), fetch_all=True,
        ) or []
        return {r['id'] for r in rows}


class RadioCacheModel:
    """Cached YouTube Music radios (`yt_radio_cache`)."""

    @staticmethod
    def get(video_id, max_age_days=7):
        row = Database.execute_query(
            "SELECT tracks FROM yt_radio_cache WHERE video_id = %s "
            "AND fetched_at >= NOW() - INTERVAL %s DAY",
            (video_id, int(max_age_days)), fetch_one=True,
        )
        return RadioCacheModel._load(row)

    @staticmethod
    def put(video_id, tracks):
        return Database.execute_query(
            """
            INSERT INTO yt_radio_cache (video_id, tracks, fetched_at) VALUES (%s, %s, NOW())
            ON DUPLICATE KEY UPDATE tracks = VALUES(tracks), fetched_at = NOW()
            """,
            (video_id, json.dumps(tracks, separators=(',', ':'))),
        )

    @staticmethod
    def get_many(video_ids):
        """{video_id: tracks} for the cached ones, whatever their age."""
        out = {}
        ids = list(video_ids)
        for i in range(0, len(ids), 400):
            chunk = ids[i:i + 400]
            rows = Database.execute_query(
                f"SELECT video_id, tracks FROM yt_radio_cache WHERE video_id IN ({_in(chunk)})",
                tuple(chunk), fetch_all=True,
            ) or []
            for r in rows:
                tracks = RadioCacheModel._load(r)
                if tracks:
                    out[r['video_id']] = tracks
        return out

    @staticmethod
    def _load(row):
        if not row or not row.get('tracks'):
            return None
        try:
            return json.loads(row['tracks'])
        except (ValueError, TypeError):
            return None
