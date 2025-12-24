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

class Config:
    MYSQL_HOST = _host
    MYSQL_PORT = int(os.getenv('MYSQL_PORT', _port))
    MYSQL_USER = os.getenv('MYSQL_USER', 'root')
    MYSQL_PASSWORD = os.getenv('MYSQL_PASSWORD', '')
    MYSQL_DATABASE = os.getenv('MYSQL_DATABASE', 'rainy')
    
    FLASK_SECRET_KEY = os.getenv('FLASK_SECRET_KEY', 'dev-secret-key-change-in-production')
    
    SUPPORTED_FORMATS = {'.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'}
