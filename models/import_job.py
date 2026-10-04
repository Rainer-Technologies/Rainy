"""Data-access layer for background import jobs (YouTube / Spotify)."""
import json
import uuid

from models.database import Database


class ImportJobModel:
    """CRUD + queue helpers for the `import_jobs` table."""

    @staticmethod
    def enqueue(user_id, source, kind, url, conflict_mode=None):
        """Create a queued job and return its id.

        conflict_mode ('add' | 'override' | 'new') only applies to playlist
        imports; it decides how a name collision with an existing playlist is
        resolved. Song imports ignore it.
        """
        query = """
            INSERT INTO import_jobs (user_id, source, kind, url, conflict_mode, status)
            VALUES (%s, %s, %s, %s, %s, 'queued')
        """
        return Database.execute_query(
            query, (user_id, source, kind, url, conflict_mode)
        )

    @staticmethod
    def get(job_id):
        """Fetch a single job by id."""
        query = "SELECT * FROM import_jobs WHERE id = %s"
        return Database.execute_query(query, (job_id,), fetch_one=True)

    @staticmethod
    def claim_next():
        """Atomically claim the oldest queued job, marking it running.

        Returns the claimed row (with its id) or None if the queue is empty.
        The UPDATE only matches a still-queued row and stamps it with a fresh
        token, so when several server processes poll the queue only one of
        them ever gets a given job.
        """
        token = str(uuid.uuid4())
        update = """
            UPDATE import_jobs
            SET status = 'running', started_at = NOW(), claim_token = %s
            WHERE status = 'queued' AND id = (
                SELECT id FROM (
                    SELECT id FROM import_jobs WHERE status = 'queued'
                    ORDER BY created_at ASC, id ASC LIMIT 1
                ) AS next_job
            )
        """
        Database.execute_query(update, (token,))
        return Database.execute_query(
            "SELECT * FROM import_jobs WHERE claim_token = %s LIMIT 1",
            (token,), fetch_one=True)

    @staticmethod
    def update_progress(job_id, progress, message):
        """Update live progress (0-100) and a status message."""
        query = """
            UPDATE import_jobs SET progress = %s, message = %s WHERE id = %s
        """
        return Database.execute_query(query, (progress, message, job_id))

    @staticmethod
    def complete(job_id, result):
        """Mark a job completed, storing its result payload as JSON."""
        query = """
            UPDATE import_jobs
            SET status = 'completed', progress = 100, result = %s,
                completed_at = NOW()
            WHERE id = %s
        """
        return Database.execute_query(query, (json.dumps(result), job_id))

    @staticmethod
    def fail(job_id, error_message):
        """Mark a job failed with an error message."""
        query = """
            UPDATE import_jobs
            SET status = 'failed', error_message = %s, completed_at = NOW()
            WHERE id = %s
        """
        return Database.execute_query(query, (error_message, job_id))

    @staticmethod
    def cancel(job_id):
        """Cancel a queued (not yet running) job. Returns True if cancelled."""
        query = """
            UPDATE import_jobs SET status = 'cancelled', completed_at = NOW()
            WHERE id = %s AND status = 'queued'
        """
        Database.execute_query(query, (job_id,))
        job = ImportJobModel.get(job_id)
        return bool(job and job.get('status') == 'cancelled')

    @staticmethod
    def recover_stale():
        """On startup, mark any jobs left 'running' (from a crash) as failed."""
        query = """
            UPDATE import_jobs
            SET status = 'failed',
                error_message = 'Interrupted by server restart',
                completed_at = NOW()
            WHERE status = 'running'
        """
        return Database.execute_query(query)

    @staticmethod
    def list_recent(limit=25, user_id=None):
        """Return recent jobs, newest first, for the history view.

        With user_id: only that user's own jobs (per-account isolation for
        the import queue — job URLs can be personal).
        """
        if user_id is not None:
            query = """
                SELECT * FROM import_jobs
                WHERE user_id = %s
                ORDER BY created_at DESC, id DESC
                LIMIT %s
            """
            return Database.execute_query(query, (user_id, limit),
                                          fetch_all=True)
        query = """
            SELECT * FROM import_jobs
            ORDER BY created_at DESC, id DESC
            LIMIT %s
        """
        return Database.execute_query(query, (limit,), fetch_all=True)

    @staticmethod
    def active_jobs(user_id=None):
        """Return queued + running jobs (the live queue), oldest first.

        With user_id: only that user's own jobs.
        """
        if user_id is not None:
            query = """
                SELECT * FROM import_jobs
                WHERE status IN ('queued', 'running') AND user_id = %s
                ORDER BY (status = 'running') DESC, created_at ASC, id ASC
            """
            return Database.execute_query(query, (user_id,), fetch_all=True)
        query = """
            SELECT * FROM import_jobs
            WHERE status IN ('queued', 'running')
            ORDER BY (status = 'running') DESC, created_at ASC, id ASC
        """
        return Database.execute_query(query, fetch_all=True)

    @staticmethod
    def is_any_running():
        """True if a job is currently running."""
        query = "SELECT id FROM import_jobs WHERE status = 'running' LIMIT 1"
        return Database.execute_query(query, fetch_one=True) is not None
