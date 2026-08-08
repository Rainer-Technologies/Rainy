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


@server_bp.route('/ai-config', methods=['GET'])
@require_auth
def get_ai_config():
    """Return the AI provider config (key masked)."""
    from utils import ai_client
    cfg = ai_client.get_config()
    return jsonify({
        'base_url': cfg['base_url'],
        'model': cfg['model'],
        'api_key_set': bool(cfg['api_key']),
        'api_key_masked': _mask_key(cfg['api_key']),
    })


@server_bp.route('/ai-config', methods=['POST'])
@require_auth
def save_ai_config():
    """Persist the AI provider config. Empty api_key keeps the existing one."""
    from utils import ai_client
    data = request.get_json() or {}
    base_url = (data.get('base_url') or '').strip()
    model = (data.get('model') or '').strip()
    api_key = (data.get('api_key') or '').strip()

    if not base_url or not model:
        return jsonify({'error': 'Base URL and model are required'}), 400

    cfg = ai_client.get_config()
    if not api_key:
        api_key = cfg['api_key']  # keep existing key when field left blank

    ai_client.save_config(base_url, model, api_key)
    new_cfg = ai_client.get_config()
    return jsonify({
        'success': True,
        'base_url': new_cfg['base_url'],
        'model': new_cfg['model'],
        'api_key_set': bool(new_cfg['api_key']),
    })


@server_bp.route('/ai-config/test', methods=['POST'])
@require_auth
def test_ai_config():
    """Fire a quick request against the configured endpoint."""
    from utils import ai_client
    ok, detail = ai_client.test_connection()
    return jsonify({'success': ok, 'detail': detail})


def _mask_key(key):
    if not key:
        return ''
    if len(key) <= 8:
        return '****'
    return key[:4] + '...' + key[-4:]


