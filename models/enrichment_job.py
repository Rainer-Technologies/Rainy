"""Data-access layer for background enrichment jobs.

Mirrors the import_jobs model: a single background worker drains the queue
one job at a time, streaming progress into the DB so the frontend can poll.
"""
import json

from models.database import Database


class EnrichmentJobModel:
    """CRUD + queue helpers for the `enrichment_jobs` table."""

    @staticmethod
    def enqueue_song(song_id, force=False):
        """Queue enrichment for a single song. Returns the job id.

        If a queued job already exists for this song, reuse it (idempotent).
        """
        existing = Database.execute_query(
            """
            SELECT id FROM enrichment_jobs
            WHERE song_id = %s AND scope = 'song' AND status IN ('queued', 'running')
            LIMIT 1
            """,
            (song_id,), fetch_one=True,
        )
        if existing:
            return existing['id']
        return Database.execute_query(
            """
            INSERT INTO enrichment_jobs (song_id, scope, status, force_full)
            VALUES (%s, 'song', 'queued', %s)
            """,
            (song_id, 1 if force else 0),
        )

    @staticmethod
    def enqueue_backfill(force=False, song_ids=None):
        """Queue a library-wide backfill job. Returns the job id.

        When ``force`` is False the worker only analyses songs that haven't
        been enriched yet; when True it re-analyses the whole library.
        ``song_ids`` optionally scopes the job to a specific song list (per-
        user 'my library' backfills); the list is stashed in the job's
        ``result`` column as JSON and honoured by the worker.

        Idempotent: returns the existing queued/running backfill if any.
        """
        existing = Database.execute_query(
            """
            SELECT id FROM enrichment_jobs
            WHERE scope = 'backfill' AND status IN ('queued', 'running')
            LIMIT 1
            """,
            fetch_one=True,
        )
        if existing:
            return existing['id']
        import json as _json
        payload = _json.dumps(song_ids) if song_ids else None
        return Database.execute_query(
            """
            INSERT INTO enrichment_jobs (scope, status, force_full, result)
            VALUES ('backfill', 'queued', %s, %s)
            """,
            (1 if force else 0, payload),
        )

    @staticmethod
    def get(job_id):
        query = "SELECT * FROM enrichment_jobs WHERE id = %s"
        return Database.execute_query(query, (job_id,), fetch_one=True)

    @staticmethod
    def claim_next():
        """Atomically claim the oldest queued job, marking it running."""
        update = """
            UPDATE enrichment_jobs
            SET status = 'running', started_at = NOW()
            WHERE id = (
                SELECT id FROM (
                    SELECT id FROM enrichment_jobs WHERE status = 'queued'
                    ORDER BY created_at ASC, id ASC LIMIT 1
                ) AS next_job
            )
        """
        Database.execute_query(update)
        select = """
            SELECT * FROM enrichment_jobs WHERE status = 'running'
            ORDER BY started_at DESC, id DESC LIMIT 1
        """
        return Database.execute_query(select, fetch_one=True)

    @staticmethod
    def update_progress(job_id, progress, message):
        query = "UPDATE enrichment_jobs SET progress = %s, message = %s WHERE id = %s"
        return Database.execute_query(query, (progress, message, job_id))

    @staticmethod
    def complete(job_id, result):
        query = """
            UPDATE enrichment_jobs
            SET status = 'completed', progress = 100, result = %s, completed_at = NOW()
            WHERE id = %s
        """
        return Database.execute_query(query, (json.dumps(result), job_id))

    @staticmethod
    def fail(job_id, error_message):
        query = """
            UPDATE enrichment_jobs
            SET status = 'failed', error_message = %s, completed_at = NOW()
            WHERE id = %s
        """
        return Database.execute_query(query, (error_message, job_id))

    @staticmethod
    def recover_stale():
        """On startup, mark jobs left 'running' (from a crash) as failed."""
        query = """
            UPDATE enrichment_jobs
            SET status = 'failed',
                error_message = 'Interrupted by server restart',
                completed_at = NOW()
            WHERE status = 'running'
        """
        return Database.execute_query(query)

    @staticmethod
    def latest():
        """Return the most recent job (for status polling)."""
        query = "SELECT * FROM enrichment_jobs ORDER BY created_at DESC, id DESC LIMIT 1"
        return Database.execute_query(query, fetch_one=True)

    @staticmethod
    def list_recent(limit=25):
        """Return recent jobs, newest first, for the history view."""
        query = """
            SELECT * FROM enrichment_jobs
            ORDER BY created_at DESC, id DESC
            LIMIT %s
        """
        return Database.execute_query(query, (limit,), fetch_all=True)

    @staticmethod
    def active_jobs():
        """Return queued + running jobs (the live queue), running first."""
        query = """
            SELECT * FROM enrichment_jobs
            WHERE status IN ('queued', 'running')
            ORDER BY (status = 'running') DESC, created_at ASC, id ASC
        """
        return Database.execute_query(query, fetch_all=True)

    @staticmethod
    def is_any_running():
        query = "SELECT id FROM enrichment_jobs WHERE status = 'running' LIMIT 1"
        return Database.execute_query(query, fetch_one=True) is not None
