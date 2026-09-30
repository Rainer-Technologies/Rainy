import os
import secrets
from datetime import timedelta

from flask import Flask, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import NotFound
from config import Config
from models.database import Database
from routes import auth_bp, setup_bp, music_bp, ratings_bp, users_bp
from routes.friends import friends_bp
from routes.playlists import playlists_bp
from routes.playback import playback_bp
from routes.albums import albums_bp
from routes.smartmix import smartmix_bp
from routes.connect import connect_bp
from routes.server import server_bp
from routes.playlist_syncs import playlist_syncs_bp

# Static files are served by the explicit catch-all below so frontend routes
# such as /albums can fall back to index.html instead of Flask's built-in
# static-file rule returning a 404 first.
app = Flask(__name__, static_folder=None)

_WEAK_SECRETS = {
    '', 'dev-secret-key-change-in-production',
    'change-this-to-a-long-random-value',
}


def _resolve_secret_key():
    """Refuse to sign sessions with a missing/placeholder/short secret."""
    key = (Config.FLASK_SECRET_KEY or '').strip()
    if key in _WEAK_SECRETS or len(key) < 32:
        if Config.DEV_MODE:
            print("WARNING: FLASK_SECRET_KEY missing/weak; using a random "
                  "per-process key (RAINY_DEV=1). Sessions reset on restart.")
            return secrets.token_hex(32)
        raise RuntimeError(
            "FLASK_SECRET_KEY is missing, a known placeholder, or shorter than "
            "32 characters. Generate one with: python -c \"import secrets; "
            "print(secrets.token_hex(32))\" (or set RAINY_DEV=1 for local dev).")
    return key


app.secret_key = _resolve_secret_key()
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
# Set RAINY_COOKIE_SECURE=1 when serving over HTTPS (the cookie then never
# travels over plain HTTP). Off by default so LAN http:// installs still work.
app.config['SESSION_COOKIE_SECURE'] = os.getenv('RAINY_COOKIE_SECURE', '').lower() in ('1', 'true', 'yes')

# Behind a reverse proxy (nginx/Caddy/Traefik) set RAINY_TRUST_PROXY=1 so
# request.remote_addr / scheme come from X-Forwarded-* (needed for correct
# per-IP rate limiting). Never enable when the app is directly exposed.
if os.getenv('RAINY_TRUST_PROXY', '').lower() in ('1', 'true', 'yes'):
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Persistent login: without these, the session cookie carries no Max-Age and
# dies with the browser tab/app (mobile browsers purge it even sooner), so
# users had to log in again constantly. 30-day sliding cookie by default,
# refreshed on every request; override with SESSION_LIFETIME_DAYS env.
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(
    days=int(os.getenv('SESSION_LIFETIME_DAYS', '30')))
app.config['SESSION_REFRESH_EACH_REQUEST'] = True

# Cross-origin access is off by default (the UI is served by this app, so it
# is same-origin). List trusted extra origins in RAINY_CORS_ORIGINS
# (comma-separated); only those get credentialed CORS.
_CORS_ORIGINS = [o.strip().rstrip('/') for o in os.getenv('RAINY_CORS_ORIGINS', '').split(',') if o.strip()]
if _CORS_ORIGINS:
    CORS(app, origins=_CORS_ORIGINS, supports_credentials=True)

# Register blueprints
app.register_blueprint(auth_bp)
app.register_blueprint(setup_bp)
app.register_blueprint(music_bp)
app.register_blueprint(ratings_bp, url_prefix='/api/ratings')
app.register_blueprint(playlists_bp, url_prefix='/api/playlists')
app.register_blueprint(users_bp, url_prefix='/api/users')
app.register_blueprint(friends_bp)
app.register_blueprint(playback_bp, url_prefix='/api/playback')
app.register_blueprint(albums_bp, url_prefix='/api/albums')
app.register_blueprint(smartmix_bp, url_prefix='/api/smartmix')
app.register_blueprint(connect_bp, url_prefix='/api/connect')
app.register_blueprint(server_bp)
app.register_blueprint(playlist_syncs_bp)

@app.route('/')
def serve_index():
    """Serve the main application."""
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    """Serve static files and the SPA shell for frontend routes."""
    try:
        return send_from_directory('static', path)
    except NotFound:
        # API paths should keep their normal 404 behavior. Frontend routes,
        # however, need index.html so refreshing a deep link still boots the SPA.
        frontend_route = path.split('/', 1)[0]
        if frontend_route in {
            'library', 'albums', 'artists', 'recent', 'recently-played',
            'smart-mix', 'smartmix', 'discover',
            'playlist', 'playlists', 'settings', 'friends'
        }:
            return send_from_directory('static', 'index.html')
        raise

_MUTATING_METHODS = {'POST', 'PUT', 'PATCH', 'DELETE'}


@app.before_request
def _check_origin_and_session():
    """CSRF guard + server-side session validation for API requests."""
    from flask import jsonify, request
    if not request.path.startswith('/api/'):
        return None

    # CSRF: a browser always sends Origin on cross-site state-changing
    # requests. Reject ones whose Origin isn't this host or a trusted origin.
    if request.method in _MUTATING_METHODS:
        origin = request.headers.get('Origin')
        if origin:
            from urllib.parse import urlparse
            same_host = urlparse(origin).netloc == request.host
            if not same_host and origin.rstrip('/') not in _CORS_ORIGINS:
                return jsonify({'error': 'Cross-origin request blocked'}), 403

    # Drop cookie sessions that were revoked / expired / deleted server-side,
    # so every route (including ones reading session['user_id'] directly)
    # sees them as signed out.
    from flask import session
    if 'user_id' in session:
        from routes.auth import validate_session
        validate_session()
    return None


@app.errorhandler(Exception)
def _handle_unexpected_error(e):
    """Never leak exception text (SQL, paths) to API clients."""
    from flask import jsonify, request
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        if request.path.startswith('/api/'):
            return jsonify({'error': e.description}), e.code
        return e
    app.logger.exception('Unhandled error on %s %s', request.method, request.path)
    return jsonify({'error': 'Internal server error'}), 500


@app.teardown_appcontext
def shutdown_session(exception=None):
    Database.close_db(exception)


def init_app():
    """Initialize the application."""
    try:
        print("🎵 Rainy Music Server")
    except UnicodeEncodeError:
        print("Rainy Music Server")
    print("=" * 40)
    print("Initializing database...")
    Database.init_db()
    print("Database initialized successfully!")

    from models.session import SessionModel
    SessionModel.purge_expired()

    # Recover any import jobs left 'running' by a previous crash. The worker
    # thread itself is started lazily on the first request (see below) so it
    # always runs in the process that actually serves requests — the debug
    # reloader's watchdog parent never serves requests, so it never spawns a
    # duplicate worker.
    from models.import_job import ImportJobModel
    ImportJobModel.recover_stale()
    print("Background import worker ready.")

    # Recover enrichment jobs left 'running' by a previous crash, same
    # lazy-start pattern as the import worker below.
    from models.enrichment_job import EnrichmentJobModel
    EnrichmentJobModel.recover_stale()
    print("Background enrichment worker ready.")

    from models.lightshow_job import LightshowJobModel
    LightshowJobModel.recover_stale()
    print("Background light show worker ready.")

    from models.lyrics_job import LyricsJobModel
    LyricsJobModel.recover_stale()
    print("Background lyrics worker ready.")
    print("=" * 40)


_import_worker_started = False
_enrichment_worker_started = False
_sync_worker_started = False
_lightshow_worker_started = False
_lyrics_worker_started = False
_ytdlp_worker_started = False


@app.before_request
def _ensure_import_worker():
    """Start the background import worker once, in the request-serving process."""
    global _import_worker_started
    if not _import_worker_started:
        _import_worker_started = True
        from utils import job_worker
        job_worker.start_worker()


@app.before_request
def _ensure_enrichment_worker():
    """Start the background enrichment worker once, in the request-serving process."""
    global _enrichment_worker_started
    if not _enrichment_worker_started:
        _enrichment_worker_started = True
        from utils import enrichment_worker
        enrichment_worker.start_worker()


@app.before_request
def _ensure_lightshow_worker():
    """Start the light show analysis worker once, in the request-serving process."""
    global _lightshow_worker_started
    if not _lightshow_worker_started:
        _lightshow_worker_started = True
        from utils import lightshow_worker
        lightshow_worker.start_worker()


@app.before_request
def _ensure_lyrics_worker():
    """Start the lyrics analysis worker once, in the request-serving process."""
    global _lyrics_worker_started
    if not _lyrics_worker_started:
        _lyrics_worker_started = True
        from utils import lyrics_worker
        lyrics_worker.start_worker()


@app.before_request
def _ensure_ytdlp_updater():
    """Keep yt-dlp current (YouTube breaks outdated versions every few weeks)."""
    global _ytdlp_worker_started
    if not _ytdlp_worker_started:
        _ytdlp_worker_started = True
        from utils import ytdlp_manager
        ytdlp_manager.start_worker()


@app.before_request
def _ensure_sync_worker():
    """Start the playlist sync worker (periodic mirror of remote playlists)."""
    global _sync_worker_started
    if not _sync_worker_started:
        _sync_worker_started = True
        from utils import playlist_sync_worker
        playlist_sync_worker.start_worker()

if __name__ == '__main__':
    init_app()

    print(f"Starting server on http://localhost:{Config.HTTP_PORT}")
    print("=" * 40)
    # The Werkzeug debugger allows arbitrary code execution; only enable it
    # explicitly for local development.
    app.run(host='0.0.0.0', port=Config.HTTP_PORT, debug=Config.DEV_MODE)
