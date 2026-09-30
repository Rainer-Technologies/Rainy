"""Server-side login sessions.

The Flask cookie stores a random token (``session['sid']``); only its SHA-256
lives in ``user_sessions``. Every /api request re-checks the row, so logout,
password changes and account deletion revoke access immediately instead of
waiting for the signed cookie to age out.
"""
import hashlib
import secrets
import threading
import time

from .database import Database

# Validation results are cached per process for a few seconds so streaming
# (many range requests) doesn't hit MySQL every time. Revocations made in this
# process evict the entry immediately; other workers converge within the TTL.
_CACHE_TTL = 10.0
# last_seen/expiry is only rewritten this often (sliding expiry).
_TOUCH_INTERVAL = 300.0

_cache = {}
_touched = {}
_lock = threading.Lock()


def _hash(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


class SessionModel:
    @staticmethod
    def create(user_id, lifetime_seconds, user_agent=None, ip=None):
        """Create a session row and return the raw token to store in the cookie."""
        token = secrets.token_urlsafe(32)
        Database.execute_query(
            "INSERT INTO user_sessions (user_id, token_hash, user_agent, ip, expires_at) "
            "VALUES (%s, %s, %s, %s, DATE_ADD(NOW(), INTERVAL %s SECOND))",
            (user_id, _hash(token), (user_agent or '')[:255] or None,
             (ip or '')[:45] or None, int(lifetime_seconds)))
        return token

    @staticmethod
    def validate(token, lifetime_seconds):
        """Return the user_id for a live session token, else None."""
        if not token or not isinstance(token, str):
            return None
        h = _hash(token)
        now = time.monotonic()

        with _lock:
            hit = _cache.get(h)
        if hit and now - hit[1] < _CACHE_TTL:
            return hit[0]

        row = Database.execute_query(
            "SELECT user_id FROM user_sessions "
            "WHERE token_hash = %s AND revoked_at IS NULL AND expires_at > NOW()",
            (h,), fetch_one=True)
        if not row:
            with _lock:
                _cache.pop(h, None)
            return None

        with _lock:
            _cache[h] = (row['user_id'], now)
            due = now - _touched.get(h, 0) >= _TOUCH_INTERVAL
            if due:
                _touched[h] = now
        if due:
            Database.execute_query(
                "UPDATE user_sessions SET last_seen = NOW(), "
                "expires_at = DATE_ADD(NOW(), INTERVAL %s SECOND) WHERE token_hash = %s",
                (int(lifetime_seconds), h))
        return row['user_id']

    @staticmethod
    def revoke(token):
        if not token:
            return
        h = _hash(token)
        with _lock:
            _cache.pop(h, None)
            _touched.pop(h, None)
        Database.execute_query(
            "UPDATE user_sessions SET revoked_at = NOW() "
            "WHERE token_hash = %s AND revoked_at IS NULL", (h,))

    @staticmethod
    def revoke_all_for_user(user_id, except_token=None):
        """Revoke every live session of a user (optionally keeping one)."""
        keep = _hash(except_token) if except_token else None
        with _lock:
            _cache.clear()
            _touched.clear()
        if keep:
            Database.execute_query(
                "UPDATE user_sessions SET revoked_at = NOW() "
                "WHERE user_id = %s AND revoked_at IS NULL AND token_hash <> %s",
                (user_id, keep))
        else:
            Database.execute_query(
                "UPDATE user_sessions SET revoked_at = NOW() "
                "WHERE user_id = %s AND revoked_at IS NULL", (user_id,))

    @staticmethod
    def list_for_user(user_id):
        return Database.execute_query(
            "SELECT id, user_agent, ip, created_at, last_seen, expires_at "
            "FROM user_sessions WHERE user_id = %s AND revoked_at IS NULL "
            "AND expires_at > NOW() ORDER BY last_seen DESC",
            (user_id,), fetch_all=True) or []

    @staticmethod
    def purge_expired():
        """Delete sessions that expired or were revoked over a week ago."""
        Database.execute_query(
            "DELETE FROM user_sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY) "
            "OR revoked_at < DATE_SUB(NOW(), INTERVAL 7 DAY)")
