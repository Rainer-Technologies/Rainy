from flask import Flask, send_from_directory
from flask_cors import CORS
from config import Config
from models.database import Database
from routes import auth_bp, setup_bp, music_bp, ratings_bp
from routes.playlists import playlists_bp

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
    print("=" * 40)

if __name__ == '__main__':
    init_app()
    print("Starting server on http://localhost:6969")
    print("=" * 40)
    app.run(host='0.0.0.0', port=6969, debug=True)
