"""Keeps yt-dlp working: auto-updates, JS challenge solving, hot reload.

YouTube changes its player every few weeks; an out-of-date yt-dlp then
fails with "HTTP Error 403", "Requested format is not available", "Sign in
to confirm…" and the like. Since late 2025 yt-dlp also needs a JavaScript
runtime (deno/node/bun) plus the `yt-dlp-ejs` solver to unlock most formats.

This module:
  - exposes ``YoutubeDL(opts)``, a drop-in for ``yt_dlp.YoutubeDL`` that
    injects the detected JS runtime and always uses the freshest installed
    yt-dlp (it hot-reloads the package after an update, in every process);
  - runs a background checker that upgrades ``yt-dlp[default]`` from PyPI
    at startup and every CHECK_INTERVAL;
  - ``update_on_failure(err)`` upgrades straight away when a download fails
    with an error that typically means "yt-dlp is outdated" (rate-limited),
    so callers can retry once with the new version.
"""
import importlib
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

CHECK_INTERVAL = 12 * 3600       # routine update check
STARTUP_DELAY = 30               # let the server come up first
FAILURE_UPDATE_COOLDOWN = 3600   # at most one failure-triggered update per hour
PIP_TIMEOUT = 300
PYPI_URL = 'https://pypi.org/pypi/yt-dlp/json'
PACKAGE_SPEC = 'yt-dlp[default]'

# Errors that usually mean YouTube changed something and yt-dlp is behind.
_OUTDATED_PATTERNS = re.compile(
    r'HTTP Error 403|Requested format is not available|Sign in to confirm|'
    r'nsig|n challenge|signature|player response|Unable to extract|'
    r'Precondition check failed|This video is unavailable|PO Token|'
    r'Only images are available|JS challenge',
    re.IGNORECASE,
)

_state_lock = threading.Lock()
_update_lock = threading.Lock()
_status = {
    'latest': None,
    'last_check': None,
    'last_update': None,        # {'at', 'from', 'to', 'ok', 'reason', 'error'}
    'checking': False,
    'updating': False,
}
_last_failure_update = 0.0
_worker = None
_runtime_cache = None
_LOCK_FILE = os.path.join(tempfile.gettempdir(), 'rainy-ytdlp-update.lock')


# ------------------------------------------------------------------ versions

def installed_version():
    """Version on disk (may be newer than the loaded module after an update)."""
    try:
        return importlib.metadata.version('yt-dlp')
    except importlib.metadata.PackageNotFoundError:
        return None


def loaded_version():
    mod = sys.modules.get('yt_dlp.version')
    return getattr(mod, '__version__', None) if mod else None


def _norm(v):
    """'2026.08.19' and '2026.8.19' compare equal; returns a tuple."""
    try:
        return tuple(int(x) for x in re.findall(r'\d+', v or ''))
    except ValueError:
        return ()


def latest_version(timeout=10):
    import requests
    r = requests.get(PYPI_URL, timeout=timeout)
    r.raise_for_status()
    return r.json()['info']['version']


def _has_ejs():
    try:
        importlib.metadata.version('yt-dlp-ejs')
        return True
    except importlib.metadata.PackageNotFoundError:
        return False


# ---------------------------------------------------------- JS runtime / opts

def js_runtime():
    """First available JS runtime yt-dlp can use for YouTube's challenges."""
    global _runtime_cache
    if _runtime_cache is None:
        found = None
        for name in ('deno', 'node', 'bun'):
            path = shutil.which(name)
            if path:
                found = (name, path)
                break
        _runtime_cache = found or ()
    return _runtime_cache or None


def base_opts():
    """Options every YoutubeDL instance should get."""
    rt = js_runtime()
    if not rt:
        return {}
    name, path = rt
    return {'js_runtimes': {name: {'path': path}}}


def _fresh_module():
    """Import yt_dlp, reloading it if pip replaced it since it was loaded."""
    disk = installed_version()
    loaded = loaded_version()
    if loaded and disk and _norm(disk) != _norm(loaded):
        for name in list(sys.modules):
            if name == 'yt_dlp' or name.startswith('yt_dlp.') or name == 'yt_dlp_ejs' or name.startswith('yt_dlp_ejs.'):
                del sys.modules[name]
        importlib.invalidate_caches()
        print(f"[yt-dlp] reloaded {loaded} -> {disk}")
    import yt_dlp
    return yt_dlp


def YoutubeDL(opts=None):  # noqa: N802 — mirrors yt_dlp.YoutubeDL
    """Drop-in for ``yt_dlp.YoutubeDL`` with runtime + freshness handled."""
    yt_dlp = _fresh_module()
    merged = {**base_opts(), **(opts or {})}
    return yt_dlp.YoutubeDL(merged)


# -------------------------------------------------------------------- update

def _acquire_file_lock():
    """Cross-process guard so two gunicorn workers never run pip at once."""
    try:
        if os.path.exists(_LOCK_FILE) and time.time() - os.path.getmtime(_LOCK_FILE) > PIP_TIMEOUT * 2:
            os.remove(_LOCK_FILE)  # stale
        fd = os.open(_LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        return False
    except OSError:
        return True  # can't lock (read-only tmp?) — proceed, pip handles its own locking


def _release_file_lock():
    try:
        os.remove(_LOCK_FILE)
    except OSError:
        pass


def check(force_update=False, reason='scheduled'):
    """Compare with PyPI and upgrade if behind (or if the EJS solver is missing).

    Returns the status dict. Never raises.
    """
    with _state_lock:
        _status['checking'] = True
    try:
        try:
            latest = latest_version()
        except Exception as e:  # noqa: BLE001
            latest = None
            print(f"[yt-dlp] update check failed: {e}")
        now = time.time()
        with _state_lock:
            _status['latest'] = latest or _status['latest']
            _status['last_check'] = now
        current = installed_version()
        behind = bool(latest and _norm(latest) > _norm(current))
        if force_update or behind or not _has_ejs():
            update(reason=reason if (behind or force_update) else 'install JS challenge solver')
    finally:
        with _state_lock:
            _status['checking'] = False
    return status()


def update(reason='manual'):
    """pip-upgrade yt-dlp[default] in this interpreter's environment."""
    if not _update_lock.acquire(blocking=False):
        return status()
    got_file_lock = _acquire_file_lock()
    try:
        if not got_file_lock:
            # Another process is updating; wait for it and just pick it up.
            for _ in range(PIP_TIMEOUT):
                if not os.path.exists(_LOCK_FILE):
                    break
                time.sleep(1)
            return status()
        with _state_lock:
            _status['updating'] = True
        before = installed_version()
        print(f"[yt-dlp] updating ({reason}) from {before}…")
        entry = {'at': time.time(), 'from': before, 'to': before, 'ok': False, 'reason': reason, 'error': None}
        try:
            proc = subprocess.run(
                [sys.executable, '-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check',
                 '--quiet', PACKAGE_SPEC],
                capture_output=True, text=True, timeout=PIP_TIMEOUT,
            )
            importlib.invalidate_caches()
            after = installed_version()
            entry['to'] = after
            entry['ok'] = proc.returncode == 0
            if proc.returncode != 0:
                entry['error'] = (proc.stderr or proc.stdout or '').strip()[-800:]
                print(f"[yt-dlp] update failed: {entry['error']}")
            else:
                print(f"[yt-dlp] now at {after}")
        except Exception as e:  # noqa: BLE001
            entry['error'] = str(e)
            print(f"[yt-dlp] update failed: {e}")
        with _state_lock:
            _status['last_update'] = entry
        return status()
    finally:
        with _state_lock:
            _status['updating'] = False
        if got_file_lock:
            _release_file_lock()
        _update_lock.release()


def looks_outdated(error):
    return bool(error and _OUTDATED_PATTERNS.search(str(error)))


def update_on_failure(error):
    """Upgrade right away if ``error`` smells like an outdated yt-dlp.

    Returns True when a newer yt-dlp is now installed, i.e. the caller should
    retry once. Rate-limited so a genuinely broken video can't hammer PyPI.
    """
    global _last_failure_update
    if not looks_outdated(error):
        return False
    now = time.time()
    if now - _last_failure_update < FAILURE_UPDATE_COOLDOWN:
        return False
    _last_failure_update = now
    before = installed_version()
    check(reason=f'download failed: {str(error)[:120]}')
    after = installed_version()
    return _norm(after) > _norm(before)


def status():
    with _state_lock:
        s = json.loads(json.dumps(_status))
    rt = js_runtime()
    s.update({
        'installed': installed_version(),
        'loaded': loaded_version(),
        'ejs': _has_ejs(),
        'js_runtime': rt[0] if rt else None,
        'up_to_date': bool(s['latest']) and _norm(installed_version()) >= _norm(s['latest']),
        'auto_update': os.environ.get('RAINY_YTDLP_AUTO_UPDATE', '1') != '0',
    })
    return s


# -------------------------------------------------------------------- worker

def _loop():
    time.sleep(STARTUP_DELAY)
    while True:
        try:
            check(reason='scheduled')
        except Exception as e:  # noqa: BLE001
            print(f"[yt-dlp] checker error: {e}")
        time.sleep(CHECK_INTERVAL)


def start_worker():
    """Start the background update checker (idempotent).

    Disable with RAINY_YTDLP_AUTO_UPDATE=0 (e.g. for pinned deployments).
    """
    global _worker
    if os.environ.get('RAINY_YTDLP_AUTO_UPDATE', '1') == '0':
        return
    if _worker is not None and _worker.is_alive():
        return
    _worker = threading.Thread(target=_loop, name='ytdlp-updater', daemon=True)
    _worker.start()
