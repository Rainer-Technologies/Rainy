"""Rainy Connect API — cross-device session discovery and remote control."""

from flask import Blueprint, jsonify, request
from functools import wraps

from models.connect import ConnectModel
from routes.auth import get_current_user_id

connect_bp = Blueprint('connect', __name__, url_prefix='/api/connect')


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user_id, *args, **kwargs)
    return decorated


@connect_bp.route('/heartbeat', methods=['POST'])
@login_required
def heartbeat(user_id):
    """Register/refresh this device and report its current playback state."""
    data = request.get_json() or {}
    device_id = data.get('device_id')
    if not device_id:
        return jsonify({'error': 'device_id is required'}), 400
    ConnectModel.heartbeat(user_id, device_id, data)
    # Always 200, even for a dropped beat: the next beat is seconds away and
    # the previous state still stands. A 5xx here made clients retry
    # immediately, which is what turned a slow row lock into a storm.
    return jsonify({'success': True})


@connect_bp.route('/devices', methods=['GET'])
@login_required
def list_devices(user_id):
    """List active devices for this user. Pass ?exclude=<device_id> to hide
    the calling device from its own list."""
    exclude = request.args.get('exclude')
    devices = ConnectModel.list_devices(user_id, exclude_device_id=exclude)
    return jsonify({'devices': devices})


@connect_bp.route('/device/<device_id>', methods=['GET'])
@login_required
def get_device(user_id, device_id):
    device = ConnectModel.get_device(user_id, device_id)
    if not device:
        return jsonify({'error': 'Device not found'}), 404
    return jsonify({'device': device})


@connect_bp.route('/device/<device_id>', methods=['DELETE'])
@login_required
def remove_device(user_id, device_id):
    ConnectModel.remove_device(user_id, device_id)
    return jsonify({'success': True})


@connect_bp.route('/device/<device_id>/command', methods=['POST'])
@login_required
def send_command(user_id, device_id):
    """Send a remote-control command to a target device.
    Body: {"command": "play"|"pause"|"next"|"previous"|"seek"|"volume"|
           "shuffle"|"repeat"|"play_song"|"transfer", "args": {...}}
    The target device polls /commands to pick these up."""
    data = request.get_json() or {}
    command = data.get('command')
    if not command:
        return jsonify({'error': 'command is required'}), 400
    # Verify the target belongs to this user.
    target = ConnectModel.get_device(user_id, device_id)
    if not target:
        return jsonify({'error': 'Device not found'}), 404
    ConnectModel.push_command(user_id, device_id, command, data.get('args') or {})
    return jsonify({'success': True})


@connect_bp.route('/commands', methods=['GET'])
@login_required
def poll_commands(user_id):
    """Fetch and clear pending commands for the calling device.
    ?device_id=<id> required."""
    device_id = request.args.get('device_id')
    if not device_id:
        return jsonify({'error': 'device_id is required'}), 400
    cmds = ConnectModel.pending_commands(user_id, device_id)
    return jsonify({'commands': cmds})
