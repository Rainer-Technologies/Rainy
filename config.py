import os
from dotenv import load_dotenv

load_dotenv()

def parse_host_port(host_string, default_port=3306):
    """Parse host:port format and return (host, port) tuple."""
    if ':' in host_string:
        parts = host_string.split(':')
        return parts[0], int(parts[1])
    return host_string, default_port

_host, _port = parse_host_port(os.getenv('MYSQL_HOST', 'localhost'))

_ROOT = os.path.dirname(os.path.abspath(__file__))


def resolve_db_backend():
    """'mysql' or 'sqlite'. RAINY_DB wins; otherwise any MYSQL_* setting means
    an existing MySQL install (never silently swap it for an empty SQLite
    file), and no database configuration at all falls back to SQLite."""
    backend = os.getenv('RAINY_DB', '').strip().lower()
    if backend in ('mysql', 'sqlite'):
        return backend
    if backend:
        raise ValueError(f"RAINY_DB must be 'mysql' or 'sqlite', got {backend!r}")
    mysql_vars = ('MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE')
    return 'mysql' if any(os.getenv(v) for v in mysql_vars) else 'sqlite'


class Config:
    # Database backend: a MySQL server, or a single SQLite file for installs
    # without a dedicated database server.
    DB_BACKEND = resolve_db_backend()
    SQLITE_PATH = os.path.abspath(os.path.join(
        _ROOT, os.getenv('SQLITE_PATH', os.path.join('data', 'rainy.db'))))

    MYSQL_HOST = _host
    MYSQL_PORT = int(os.getenv('MYSQL_PORT', _port))
    MYSQL_USER = os.getenv('MYSQL_USER', 'root')
    MYSQL_PASSWORD = os.getenv('MYSQL_PASSWORD', '')
    MYSQL_DATABASE = os.getenv('MYSQL_DATABASE', 'rainy')
    
    FLASK_SECRET_KEY = os.getenv('FLASK_SECRET_KEY', '')
    # Set RAINY_DEV=1 to allow an auto-generated, per-process secret for local
    # development (sessions then reset on every restart).
    DEV_MODE = os.getenv('RAINY_DEV', '').lower() in ('1', 'true', 'yes')

    # Server listener port.
    HTTP_PORT = int(os.getenv('RAINY_HTTP_PORT', 6969))

    # Free Last.fm API key for track tags / similar artists / bios.
    # Get one at https://www.last.fm/api/account/create (30 seconds, free).
    # If unset, Last.fm enrichment is skipped (MusicBrainz still works).
    LASTFM_API_KEY = os.getenv('LASTFM_API_KEY', '')

    SUPPORTED_FORMATS = {'.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma', '.mkv'}
