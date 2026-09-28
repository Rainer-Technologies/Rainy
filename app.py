import os
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
from routes.ext_repo import ext_repo_bp
from routes.server import server_bp
from routes.playlist_syncs import playlist_syncs_bp
from routes.discovery import discovery_bp

# Static files are served by the explicit catch-all below so frontend routes
# such as /albums can fall back to index.html instead of Flask's built-in
# static-file rule returning a 404 first.
app = Flask(__name__, static_folder=None)
app.secret_key = Config.FLASK_SECRET_KEY

# Persistent login: without these, the session cookie carries no Max-Age and
# dies with the browser tab/app (mobile browsers purge it even sooner), so
# users had to log in again constantly. 30-day sliding cookie by default,
# refreshed on every request; override with SESSION_LIFETIME_DAYS env.
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(
    days=int(os.getenv('SESSION_LIFETIME_DAYS', '30')))
app.config['SESSION_REFRESH_EACH_REQUEST'] = True

# Enable CORS for development
CORS(app, supports_credentials=True)

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
app.register_blueprint(ext_repo_bp, url_prefix='/ext-repo')
app.register_blueprint(server_bp)
app.register_blueprint(playlist_syncs_bp)
app.register_blueprint(discovery_bp)

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
    print("=" * 40)


_import_worker_started = False
_enrichment_worker_started = False
_sync_worker_started = False


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
    app.run(host='0.0.0.0', port=Config.HTTP_PORT, debug=True)
