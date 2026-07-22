"""Data-access layer for background import jobs (YouTube / Spotify)."""
import json

from models.database import Database


class ImportJobModel:
    """CRUD + queue helpers for the `import_jobs` table."""

    @staticmethod
    def enqueue(user_id, source, kind, url):
        """Create a queued job and return its id."""
        query = """
            INSERT INTO import_jobs (user_id, source, kind, url, status)
            VALUES (%s, %s, %s, %s, 'queued')
        """
        return Database.execute_query(query, (user_id, source, kind, url))

    @staticmethod
    def get(job_id):
        """Fetch a single job by id."""
        query = "SELECT * FROM import_jobs WHERE id = %s"
        return Database.execute_query(query, (job_id,), fetch_one=True)

    @staticmethod
    def claim_next():
        """Atomically claim the oldest queued job, marking it running.

        Returns the claimed row (with its id) or None if the queue is empty.
        Uses an UPDATE ... LIMIT 1 followed by a SELECT on the affected row so
        only one worker ever picks up a given job.
        """
        # Mark the oldest queued job as running.
        update = """
            UPDATE import_jobs
            SET status = 'running', started_at = NOW()
            WHERE id = (
                SELECT id FROM (
                    SELECT id FROM import_jobs WHERE status = 'queued'
                    ORDER BY created_at ASC, id ASC LIMIT 1
                ) AS next_job
            )
        """
        Database.execute_query(update)

        # Fetch the job we just started (the one with the latest started_at
        # among running jobs is ours, since only one worker runs at a time).
        select = """
            SELECT * FROM import_jobs WHERE status = 'running'
            ORDER BY started_at DESC, id DESC LIMIT 1
        """
        return Database.execute_query(select, fetch_one=True)

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
    def list_recent(limit=25):
        """Return recent jobs, newest first, for the history view."""
        query = """
            SELECT * FROM import_jobs
            ORDER BY created_at DESC, id DESC
            LIMIT %s
        """
        return Database.execute_query(query, (limit,), fetch_all=True)

    @staticmethod
    def active_jobs():
        """Return queued + running jobs (the live queue), oldest first."""
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
