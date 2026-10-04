"""Data-access layer for light show analysis jobs + stored scores.

Mirrors the enrichment_jobs model: background workers drain the queue one
job at a time, streaming progress into the DB so the frontend can poll.
Claims use a per-claim token, so it stays safe with several server
processes each running a worker thread.
"""
import json
import uuid

from models.database import Database
from utils.lightshow_analyzer import ANALYZER_VERSION


class LightshowJobModel:
    """CRUD + queue helpers for `lightshow_jobs` and `song_lightshows`."""

    # ------------------------------------------------------------- queue

    @staticmethod
    def enqueue_song(song_id, force=False):
        """Queue analysis for one song (idempotent while queued/running)."""
        existing = Database.execute_query(
            """
            SELECT id FROM lightshow_jobs
            WHERE song_id = %s AND scope = 'song' AND status IN ('queued', 'running')
            LIMIT 1
            """,
            (song_id,), fetch_one=True,
        )
        if existing:
            return existing['id']
        return Database.execute_query(
            "INSERT INTO lightshow_jobs (song_id, scope, status, force_full) VALUES (%s, 'song', 'queued', %s)",
            (song_id, 1 if force else 0),
        )

    @staticmethod
    def enqueue_backfill(force=False, song_ids=None):
        """Queue a library-wide pass (idempotent while one is queued/running).

        ``song_ids`` optionally scopes the job to a user's visible library.
        """
        existing = Database.execute_query(
            "SELECT id FROM lightshow_jobs WHERE scope = 'backfill' AND status IN ('queued', 'running') LIMIT 1",
            fetch_one=True,
        )
        if existing:
            return existing['id']
        return Database.execute_query(
            "INSERT INTO lightshow_jobs (scope, status, force_full, song_ids) VALUES ('backfill', 'queued', %s, %s)",
            (1 if force else 0, json.dumps(song_ids) if song_ids is not None else None),
        )

    @staticmethod
    def get(job_id):
        return Database.execute_query("SELECT * FROM lightshow_jobs WHERE id = %s", (job_id,), fetch_one=True)

    @staticmethod
    def claim_next():
        """Atomically claim the oldest queued job. Single-song jobs go first
        so a freshly imported song isn't stuck behind a long backfill."""
        token = str(uuid.uuid4())
        Database.execute_query(
            """
            UPDATE lightshow_jobs
            SET status = 'running', started_at = NOW(), heartbeat_at = NOW(), claim_token = %s
            WHERE status = 'queued' AND id = (
                SELECT id FROM (
                    SELECT id FROM lightshow_jobs WHERE status = 'queued'
                    ORDER BY (scope = 'song') DESC, created_at ASC, id ASC
                    LIMIT 1
                ) AS next_job
            )
            """,
            (token,),
        )
        return Database.execute_query(
            "SELECT * FROM lightshow_jobs WHERE claim_token = %s LIMIT 1", (token,), fetch_one=True,
        )

    @staticmethod
    def update_progress(job_id, progress, message):
        return Database.execute_query(
            "UPDATE lightshow_jobs SET progress = %s, message = %s, heartbeat_at = NOW() WHERE id = %s",
            (progress, (message or '')[:500], job_id),
        )

    @staticmethod
    def complete(job_id, result):
        return Database.execute_query(
            """
            UPDATE lightshow_jobs
            SET status = 'completed', progress = 100, result = %s, completed_at = NOW()
            WHERE id = %s
            """,
            (json.dumps(result), job_id),
        )

    @staticmethod
    def fail(job_id, error_message):
        return Database.execute_query(
            "UPDATE lightshow_jobs SET status = 'failed', error_message = %s, completed_at = NOW() WHERE id = %s",
            (str(error_message)[:2000], job_id),
        )

    @staticmethod
    def recover_stale(max_silence_minutes=10):
        """Re-queue jobs whose worker died (no heartbeat for a while).

        Heartbeat-based rather than 'every running job', so it is safe to
        call from any process at any time — a job another live worker is
        processing keeps beating and is left alone.
        """
        return Database.execute_query(
            """
            UPDATE lightshow_jobs
            SET status = 'queued', claim_token = NULL, started_at = NULL
            WHERE status = 'running'
              AND COALESCE(heartbeat_at, started_at, created_at) < NOW() - INTERVAL %s MINUTE
            """,
            (int(max_silence_minutes),),
        )

    @staticmethod
    def list_recent(limit=15):
        return Database.execute_query(
            """
            SELECT * FROM lightshow_jobs
            WHERE status IN ('completed', 'failed')
            ORDER BY completed_at DESC, id DESC LIMIT %s
            """,
            (limit,), fetch_all=True,
        )

    @staticmethod
    def active_jobs():
        return Database.execute_query(
            """
            SELECT * FROM lightshow_jobs
            WHERE status IN ('queued', 'running')
            ORDER BY (status = 'running') DESC, (scope = 'song') DESC, created_at ASC, id ASC
            """,
            fetch_all=True,
        )

    @staticmethod
    def song_job_state(song_id):
        """Latest job for one song — lets the UI show queued/running/failed."""
        return Database.execute_query(
            """
            SELECT * FROM lightshow_jobs WHERE song_id = %s AND scope = 'song'
            ORDER BY id DESC LIMIT 1
            """,
            (song_id,), fetch_one=True,
        )

    # ------------------------------------------------------------ scores

    @staticmethod
    def get_score(song_id):
        """Return (version, data_dict) for a song's stored show, or None."""
        row = Database.execute_query(
            "SELECT version, data FROM song_lightshows WHERE song_id = %s", (song_id,), fetch_one=True,
        )
        if not row:
            return None
        try:
            return int(row['version'] or 1), json.loads(row['data'])
        except (ValueError, TypeError):
            return None

    @staticmethod
    def save_score(song_id, data):
        payload = json.dumps(data, separators=(',', ':'))
        version = int(data.get('v') or ANALYZER_VERSION)
        Database.execute_query(
            """
            INSERT INTO song_lightshows (song_id, data, version) VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE data = %s, version = %s
            """,
            (song_id, payload, version, payload, version),
        )

    @staticmethod
    def delete_score(song_id):
        Database.execute_query("DELETE FROM song_lightshows WHERE song_id = %s", (song_id,))

    @staticmethod
    def songs_needing_analysis(force=False):
        if force:
            return Database.execute_query("SELECT * FROM songs ORDER BY id ASC", fetch_all=True) or []
        return Database.execute_query(
            """
            SELECT s.* FROM songs s
            LEFT JOIN song_lightshows l ON l.song_id = s.id
            WHERE l.song_id IS NULL OR l.version < %s
            ORDER BY s.id ASC
            """,
            (ANALYZER_VERSION,), fetch_all=True,
        ) or []

    @staticmethod
    def coverage(song_ids=None):
        """(analysed_with_current_version, total) — optionally scoped."""
        rows = Database.execute_query(
            """
            SELECT s.id, (l.version >= %s) AS ok FROM songs s
            LEFT JOIN song_lightshows l ON l.song_id = s.id
            """,
            (ANALYZER_VERSION,), fetch_all=True,
        ) or []
        if song_ids is not None:
            allowed = set(song_ids)
            rows = [r for r in rows if r['id'] in allowed]
        return sum(1 for r in rows if r['ok']), len(rows)
