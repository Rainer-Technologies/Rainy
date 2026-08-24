"""Server-level settings API — Chromecast setup info.

Chromecast Web Sender SDK requires a secure origin (localhost or HTTPS or
browsers configured to treat the HTTP origin as secure via flags).
"""

from flask import Blueprint, jsonify, request

from config import Config
from routes.auth import require_auth, require_sysadmin

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


@server_bp.route('/lan-ip', methods=['GET'])
@require_auth
def lan_ip():
    """Return the server's private LAN IPv4 addresses.

    The phone may reach Rainy over Tailscale/VPN (100.x / *.ts.net) — an
    address a Chromecast on the local network cannot fetch audio/cover from.
    Cast devices build their media URLs from THIS value instead, so audio and
    covers work even when the phone itself connects over VPN.
    """
    import socket
    addrs = set()
    try:
        # The address we'd route an arbitrary internet packet through.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(('8.8.8.8', 80))
            addrs.add(s.getsockname()[0])
        finally:
            s.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        addrs.add(socket.gethostbyname(socket.gethostname()))
    except Exception:  # noqa: BLE001
        pass

    def _is_private(ip):
        parts = ip.split('.')
        if len(parts) != 4:
            return False
        a = int(parts[0])
        b = int(parts[1]) if len(parts) > 1 else 0
        if a == 10:
            return True  # 10.0.0.0/8
        if a == 172 and 16 <= b <= 31:
            return True  # 172.16.0.0/12
        if a == 192 and b == 168:
            return True  # 192.168.0.0/16
        return False

    lans = sorted(a for a in addrs if _is_private(a))
    return jsonify({
        'lan_ips': lans,
        'preferred': lans[0] if lans else None,
        'http_port': Config.HTTP_PORT,
    })


@server_bp.route('/ai-config', methods=['GET'])
@require_sysadmin
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
@require_sysadmin
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
@require_sysadmin
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


