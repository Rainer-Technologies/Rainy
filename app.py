from flask import Flask, send_from_directory
from flask_cors import CORS
from config import Config
from models.database import Database
from routes import auth_bp, setup_bp, music_bp, ratings_bp, users_bp
from routes.playlists import playlists_bp
from routes.playback import playback_bp
from routes.albums import albums_bp
from routes.smartmix import smartmix_bp
from routes.achievements import achievements_bp
from routes.connect import connect_bp
from routes.plugins import plugins_bp
from routes.server import server_bp
from routes.radio import radio_bp
from routes.dj import dj_bp

app = Flask(__name__, static_folder='static', static_url_path='')
app.secret_key = Config.FLASK_SECRET_KEY

# Enable CORS for development
CORS(app, supports_credentials=True)

# Register blueprints
app.register_blueprint(auth_bp)
app.register_blueprint(setup_bp)
app.register_blueprint(music_bp)
app.register_blueprint(ratings_bp, url_prefix='/api/ratings')
app.register_blueprint(playlists_bp, url_prefix='/api/playlists')
app.register_blueprint(users_bp, url_prefix='/api/users')
app.register_blueprint(playback_bp, url_prefix='/api/playback')
app.register_blueprint(albums_bp, url_prefix='/api/albums')
app.register_blueprint(smartmix_bp, url_prefix='/api/smartmix')
app.register_blueprint(achievements_bp, url_prefix='/api/achievements')
app.register_blueprint(connect_bp, url_prefix='/api/connect')
app.register_blueprint(plugins_bp, url_prefix='/api/plugins')
app.register_blueprint(server_bp)
app.register_blueprint(radio_bp)
app.register_blueprint(dj_bp)

@app.route('/')
def serve_index():
    """Serve the main application."""
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    """Serve static files."""
    return send_from_directory('static', path)

@app.teardown_appcontext
def shutdown_session(exception=None):
    Database.close_db(exception)


def warm_ai_stack():
    """Pre-warm the AI stack in the background at startup.

    The Kokoro TTS daemon takes ~60-80s to load its model on the first line
    request; warming it now means the user's FIRST DJ toggle works instead of
    failing with "DJ unavailable" while the daemon is still loading. Runs in
    a daemon thread so startup is unaffected. Only warms when the AI is
    actually configured.
    """
    try:
        from utils import ai_client, dj
        if ai_client.is_configured():
            dj._warm_daemon_async()
            print("[startup] AI stack warm-up scheduled (TTS daemon loading…)")
    except Exception as e:  # noqa: BLE001
        print(f"[startup] AI warm-up skipped: {e}")

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

if __name__ == '__main__':
    init_app()
    warm_ai_stack()

    print(f"Starting server on http://localhost:{Config.HTTP_PORT}")
    print("=" * 40)
    app.run(host='0.0.0.0', port=Config.HTTP_PORT, debug=True)
