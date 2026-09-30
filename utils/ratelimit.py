"""Small in-process sliding-window rate limiter.

State is per worker process (gunicorn runs several), so the effective limit is
up to ``workers x limit``. Good enough to blunt brute force on a single host;
Phase 4 moves this to a shared store (Redis).
"""
import threading
import time
from collections import defaultdict, deque

_hits = defaultdict(deque)
_lock = threading.Lock()
_last_sweep = 0.0


def _sweep(now):
    global _last_sweep
    if now - _last_sweep < 300:
        return
    _last_sweep = now
    for key in [k for k, q in _hits.items() if not q or now - q[-1] > 3600]:
        del _hits[key]


def check(key, limit, window_seconds):
    """Record one attempt. Returns (allowed, retry_after_seconds)."""
    now = time.monotonic()
    with _lock:
        _sweep(now)
        q = _hits[key]
        while q and now - q[0] > window_seconds:
            q.popleft()
        if len(q) >= limit:
            return False, max(1, int(window_seconds - (now - q[0])))
        q.append(now)
        return True, 0


def peek_blocked(key, limit, window_seconds):
    """True if key is already at its limit (does not record an attempt)."""
    now = time.monotonic()
    with _lock:
        q = _hits.get(key)
        if not q:
            return False
        while q and now - q[0] > window_seconds:
            q.popleft()
        return len(q) >= limit


def reset(key):
    with _lock:
        _hits.pop(key, None)
