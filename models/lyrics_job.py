"""Data-access layer for lyrics analysis jobs + stored word timings.

Same queue design as lightshow_jobs: a background worker drains one job at a
time, streaming progress into the DB so the frontend can poll, and claims use
a per-claim token so several server processes can each run a worker safely.

A "lyrics analysis" fetches lyrics from LRCLIB when a song was never looked
up, then aligns the synced lines to the audio (utils/lyrics_align.py).
"""
import json
import uuid

from models.database import Database
from utils.lyrics_align import ALIGN_VERSION

_HAS_SYNCED = "(l.found = 1 AND l.synced IS NOT NULL AND l.synced <> '')"


class LyricsJobModel:
    """CRUD + queue helpers for `lyrics_jobs` and `song_lyrics_words`."""

    # ------------------------------------------------------------- queue

    @staticmethod
    def enqueue_song(song_id, force=False):
        """Queue analysis for one song (idempotent while queued/running)."""
        existing = Database.execute_query(
            """
            SELECT id FROM lyrics_jobs
            WHERE song_id = %s AND scope = 'song' AND status IN ('queued', 'running')
            LIMIT 1
            """,
            (song_id,), fetch_one=True,
        )
        if existing:
            return existing['id']
        return Database.execute_query(
            "INSERT INTO lyrics_jobs (song_id, scope, status, force_full) VALUES (%s, 'song', 'queued', %s)",
            (song_id, 1 if force else 0),
        )

    @staticmethod
    def enqueue_backfill(force=False, song_ids=None):
        """Queue a library-wide pass (idempotent while one is queued/running).

        ``song_ids`` optionally scopes the job to a user's visible library.
        """
        existing = Database.execute_query(
            "SELECT id FROM lyrics_jobs WHERE scope = 'backfill' AND status IN ('queued', 'running') LIMIT 1",
            fetch_one=True,
        )
        if existing:
            return existing['id']
        return Database.execute_query(
            "INSERT INTO lyrics_jobs (scope, status, force_full, song_ids) VALUES ('backfill', 'queued', %s, %s)",
            (1 if force else 0, json.dumps(song_ids) if song_ids is not None else None),
        )

    @staticmethod
    def get(job_id):
        return Database.execute_query("SELECT * FROM lyrics_jobs WHERE id = %s", (job_id,), fetch_one=True)

    @staticmethod
    def claim_next():
        """Atomically claim the oldest queued job; single-song jobs go first so
        a song someone is looking at isn't stuck behind a long backfill."""
        token = str(uuid.uuid4())
        Database.execute_query(
            """
            UPDATE lyrics_jobs
            SET status = 'running', started_at = NOW(), heartbeat_at = NOW(), claim_token = %s
            WHERE status = 'queued' AND id = (
                SELECT id FROM (
                    SELECT id FROM lyrics_jobs WHERE status = 'queued'
                    ORDER BY (scope = 'song') DESC, created_at ASC, id ASC
                    LIMIT 1
                ) AS next_job
            )
            """,
            (token,),
        )
        return Database.execute_query(
            "SELECT * FROM lyrics_jobs WHERE claim_token = %s LIMIT 1", (token,), fetch_one=True,
        )

    @staticmethod
    def update_progress(job_id, progress, message):
        return Database.execute_query(
            "UPDATE lyrics_jobs SET progress = %s, message = %s, heartbeat_at = NOW() WHERE id = %s",
            (progress, (message or '')[:500], job_id),
        )

    @staticmethod
    def complete(job_id, result):
        return Database.execute_query(
            "UPDATE lyrics_jobs SET status = 'completed', progress = 100, result = %s, completed_at = NOW() WHERE id = %s",
            (json.dumps(result), job_id),
        )

    @staticmethod
    def fail(job_id, error_message):
        return Database.execute_query(
            "UPDATE lyrics_jobs SET status = 'failed', error_message = %s, completed_at = NOW() WHERE id = %s",
            (str(error_message)[:2000], job_id),
        )

    @staticmethod
    def recover_stale(max_silence_minutes=10):
        """Re-queue jobs whose worker died (no heartbeat for a while)."""
        return Database.execute_query(
            """
            UPDATE lyrics_jobs
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
            SELECT * FROM lyrics_jobs
            WHERE status IN ('completed', 'failed')
            ORDER BY completed_at DESC, id DESC LIMIT %s
            """,
            (limit,), fetch_all=True,
        )

    @staticmethod
    def active_jobs():
        return Database.execute_query(
            """
            SELECT * FROM lyrics_jobs
            WHERE status IN ('queued', 'running')
            ORDER BY (status = 'running') DESC, (scope = 'song') DESC, created_at ASC, id ASC
            """,
            fetch_all=True,
        )

    @staticmethod
    def song_job_state(song_id):
        """Latest job for one song — lets the UI show queued/running/failed."""
        return Database.execute_query(
            "SELECT * FROM lyrics_jobs WHERE song_id = %s AND scope = 'song' ORDER BY id DESC LIMIT 1",
            (song_id,), fetch_one=True,
        )

    # ------------------------------------------------------------ lyrics

    @staticmethod
    def get_lyrics(song_id):
        """The song_lyrics row (found/synced/plain/updated_at) or None if never looked up."""
        return Database.execute_query(
            "SELECT found, synced, plain, updated_at FROM song_lyrics WHERE song_id = %s", (song_id,), fetch_one=True,
        )

    @staticmethod
    def save_lyrics(song_id, synced, plain):
        """Store a lookup result (found=0 when LRCLIB had nothing) and drop any
        word timings that belonged to the previous lyrics."""
        found = 1 if (synced or plain) else 0
        synced_json = json.dumps(synced) if synced else None
        plain_text = plain or None
        Database.execute_query(
            """INSERT INTO song_lyrics (song_id, found, synced, plain) VALUES (%s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE found = %s, synced = %s, plain = %s""",
            (song_id, found, synced_json, plain_text, found, synced_json, plain_text),
        )
        Database.execute_query("DELETE FROM song_lyrics_words WHERE song_id = %s", (song_id,))
        return found

    # ------------------------------------------------------------- words

    @staticmethod
    def get_words(song_id):
        """Return (version, words, language) for a song's stored timings, or None."""
        row = Database.execute_query(
            "SELECT version, data, language FROM song_lyrics_words WHERE song_id = %s", (song_id,), fetch_one=True,
        )
        if not row:
            return None
        try:
            return int(row['version'] or 1), json.loads(row['data']), row.get('language')
        except (ValueError, TypeError):
            return None

    @staticmethod
    def save_words(song_id, words, language=None):
        payload = json.dumps(words, separators=(',', ':'))
        Database.execute_query(
            """
            INSERT INTO song_lyrics_words (song_id, data, version, language) VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE data = %s, version = %s, language = %s
            """,
            (song_id, payload, ALIGN_VERSION, language, payload, ALIGN_VERSION, language),
        )

    @staticmethod
    def delete_words(song_id):
        Database.execute_query("DELETE FROM song_lyrics_words WHERE song_id = %s", (song_id,))

    @staticmethod
    def songs_needing_analysis(force=False):
        """Songs never looked up on LRCLIB, plus songs with synced lyrics whose
        word timings are missing (or outdated, or — with force — all of them)."""
        if force:
            where = f"l.song_id IS NULL OR {_HAS_SYNCED}"
            params = ()
        else:
            where = (f"l.song_id IS NULL OR ({_HAS_SYNCED} AND (w.song_id IS NULL OR w.version < %s))")
            params = (ALIGN_VERSION,)
        return Database.execute_query(
            f"""
            SELECT s.* FROM songs s
            LEFT JOIN song_lyrics l ON l.song_id = s.id
            LEFT JOIN song_lyrics_words w ON w.song_id = s.id
            WHERE {where}
            ORDER BY s.id ASC
            """,
            params, fetch_all=True,
        ) or []

    @staticmethod
    def coverage(song_ids=None):
        """{'ready', 'total', 'unfetched'}: songs with synced lyrics that have
        current word timings / that have synced lyrics / never looked up."""
        rows = Database.execute_query(
            f"""
            SELECT s.id, (l.song_id IS NULL) AS unfetched, {_HAS_SYNCED} AS synced,
                   (w.version >= %s) AS ok
            FROM songs s
            LEFT JOIN song_lyrics l ON l.song_id = s.id
            LEFT JOIN song_lyrics_words w ON w.song_id = s.id
            """,
            (ALIGN_VERSION,), fetch_all=True,
        ) or []
        if song_ids is not None:
            allowed = set(song_ids)
            rows = [r for r in rows if r['id'] in allowed]
        return {
            'ready': sum(1 for r in rows if r['synced'] and r['ok']),
            'total': sum(1 for r in rows if r['synced']),
            'unfetched': sum(1 for r in rows if r['unfetched']),
        }
