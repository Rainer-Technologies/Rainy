"""Server-level settings API — Chromecast setup info.

Chromecast Web Sender SDK requires a secure origin (localhost or HTTPS or
browsers configured to treat the HTTP origin as secure via flags).
"""

from flask import Blueprint, jsonify, request

from config import Config
from routes.auth import require_auth

server_bp = Blueprint('server', __name__, url_prefix='/api/server')


def _request_host():
    return (request.host.split(':')[0] if request else 'localhost') or 'localhost'


@server_bp.route('/chromecast-info', methods=['GET'])
@require_auth
def chromecast_info():
    """Return Chromecast setup information and origin URLs for browser flags."""
    host = _request_host()
    origin = f'http://{host}:{Config.HTTP_PORT}'
    return jsonify({
        'host': host,
        'http_port': Config.HTTP_PORT,
        'origin_url': origin,
        'chrome_flag_url': 'chrome://flags/#unsafely-treat-insecure-origin-as-secure',
        'edge_flag_url': 'edge://flags/#unsafely-treat-insecure-origin-as-secure',
    })


