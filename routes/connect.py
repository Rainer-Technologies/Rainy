"""Rainy Connect API — cross-device session discovery and remote control."""

import json
import threading
import time
from collections import defaultdict
from functools import wraps

from flask import Blueprint, Response, jsonify, request

from models.connect import COMMANDS, ConnectModel
from routes.auth import get_current_user_id

connect_bp = Blueprint('connect', __name__, url_prefix='/api/connect')

# ── Command stream ──
# A stream is one long-lived request, i.e. one server thread, per device.

# How often a stream looks for commands when nobody in this process woke it
# (a command pushed through another worker process).
STREAM_POLL_SECONDS = 1.0
# How often an open stream is recorded as presence, and a comment is written
# so proxies keep the connection and a dead client is noticed.
STREAM_TOUCH_SECONDS = 10.0
STREAM_PING_SECONDS = 15.0
# A stream ends by itself after this long; the client reconnects and is
# authenticated again (a signed-out session does not keep listening).
STREAM_MAX_SECONDS = 300.0
# Streams one user may hold open. Beyond it the oldest thread is not worth
# protecting: the newcomer is refused and falls back to polling.
STREAM_MAX_PER_USER = 12


class _StreamHub:
    """Wakes the streams of a device when a command is pushed for it in this
    process, so it is delivered at once instead of on the next poll."""

    def __init__(self):
        self._lock = threading.Lock()
        self._waiters = defaultdict(set)   # device_id -> {threading.Event}
        self._per_user = defaultdict(int)  # user_id -> open streams

    def open(self, user_id, device_id):
        """Register a stream; None when the user already holds too many."""
        with self._lock:
            if self._per_user[user_id] >= STREAM_MAX_PER_USER:
                return None
            self._per_user[user_id] += 1
            waiter = threading.Event()
            self._waiters[device_id].add(waiter)
            return waiter

    def close(self, user_id, device_id, waiter):
        """Forget a stream. Safe to call twice (generator end + response
        close both do)."""
        with self._lock:
            if waiter not in self._waiters.get(device_id, ()):
                return
            self._per_user[user_id] -= 1
            if self._per_user[user_id] <= 0:
                del self._per_user[user_id]
            self._waiters[device_id].discard(waiter)
            if not self._waiters[device_id]:
                del self._waiters[device_id]

    def notify(self, device_id):
        with self._lock:
            waiters = list(self._waiters.get(device_id, ()))
        for waiter in waiters:
            waiter.set()


stream_hub = _StreamHub()


def _sse(event, data, event_id=None):
    lines = [f"id: {event_id}"] if event_id is not None else []
    lines += [f"event: {event}", f"data: {json.dumps(data, separators=(',', ':'))}"]
    return "\n".join(lines) + "\n\n"


def command_stream(user_id, device_id, after_id, waiter):
    """Server-sent events for one device: its remote-control commands as they
    arrive. Runs after the request context is gone, so every query uses its
    own short-lived connection instead of holding one for minutes."""
    try:
        ConnectModel.touch_stream(user_id, device_id)
        touched = pinged = time.monotonic()
        deadline = touched + STREAM_MAX_SECONDS
        # First bytes right away: tells the client the stream is up, and how
        # long to wait before reconnecting when it drops.
        yield "retry: 2000\n" + _sse("open", {})
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now - touched >= STREAM_TOUCH_SECONDS:
                ConnectModel.touch_stream(user_id, device_id)
                touched = now
            for cmd in ConnectModel.peek_commands(user_id, device_id, after_id):
                after_id = cmd['id']
                yield _sse("command", cmd, event_id=cmd['id'])
                pinged = now
            if now - pinged >= STREAM_PING_SECONDS:
                yield ": ping\n\n"
                pinged = now
            waiter.wait(STREAM_POLL_SECONDS)
            waiter.clear()
    finally:
        stream_hub.close(user_id, device_id, waiter)


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user_id, *args, **kwargs)
    return decorated


def _device_id(value):
    """A usable device id (it is the row's primary key), or None."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if 0 < len(value) <= 64 else None


@connect_bp.route('/heartbeat', methods=['POST'])
@login_required
def heartbeat(user_id):
    """Register/refresh this device and report its current playback state.

    Answers `need_queue` when the server does not hold the queue the client
    says it last uploaded (`queue_sig`); the client then sends `queue` on its
    next beat."""
    data = request.get_json(silent=True) or {}
    device_id = _device_id(data.get('device_id'))
    if not device_id:
        return jsonify({'error': 'device_id is required'}), 400
    result = ConnectModel.heartbeat(user_id, device_id, data)
    # Always 200, even for a dropped beat: the next beat is seconds away and
    # the previous state still stands. A 5xx here made clients retry
    # immediately, which is what turned a slow row lock into a storm.
    return jsonify({'success': True, 'need_queue': result['need_queue']})


@connect_bp.route('/devices', methods=['GET'])
@login_required
def list_devices(user_id):
    """List active devices for this user. Pass ?exclude=<device_id> to hide
    the calling device from its own list, ?queues=0 to leave the queues
    out (fetch the one you need with /device/<id>), and ?offline=1 to also
    get devices that went quiet recently (`online` false)."""
    exclude = request.args.get('exclude')
    devices = ConnectModel.list_devices(
        user_id, exclude_device_id=exclude,
        include_queue=request.args.get('queues') != '0',
        include_offline=request.args.get('offline') == '1')
    return jsonify({'devices': devices})


@connect_bp.route('/device/<device_id>', methods=['GET'])
@login_required
def get_device(user_id, device_id):
    """One device's state. Pass ?queue_hash=<hash> (the `queue_hash` of the
    queue you already hold) to get `queue_unchanged` instead of the queue."""
    device = ConnectModel.get_device(
        user_id, device_id, known_queue_hash=request.args.get('queue_hash'))
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
    Body: {"command": "play"|"pause"|"play_pause"|"next"|"previous"|"seek"|
           "volume"|"shuffle"|"repeat"|"play_song"|"play_queue"|"transfer",
           "args": {...}}
    The target device polls /commands to pick these up. Answers the command's
    id; the device's state carries it as `last_cmd_id` once applied."""
    data = request.get_json(silent=True) or {}
    command = data.get('command')
    if not command:
        return jsonify({'error': 'command is required'}), 400
    if command not in COMMANDS:
        return jsonify({'error': 'Unknown command'}), 400
    # The target must belong to this user and be listening: a command for a
    # device that went away would otherwise fire whenever it came back.
    status = ConnectModel.device_status(user_id, device_id)
    if status is None:
        return jsonify({'error': 'Device not found'}), 404
    if status != 'online':
        return jsonify({'error': 'Device is offline'}), 409
    command_id = ConnectModel.push_command(user_id, device_id, command, data.get('args'))
    stream_hub.notify(device_id)
    return jsonify({'success': True, 'command_id': command_id})


@connect_bp.route('/stream', methods=['GET'])
@login_required
def stream(user_id):
    """Server-sent events with the calling device's commands
    (`event: command`, data = {id, command, args}). ?device_id=<id> required.

    Unlike /commands this does not consume them: the device acknowledges
    with `cmd_ack` in its heartbeat, and skips ids it already applied. On
    reconnect, Last-Event-ID (or ?after=) says where to resume. While the
    stream is open the device counts as online even without heartbeats."""
    device_id = _device_id(request.args.get('device_id'))
    if not device_id:
        return jsonify({'error': 'device_id is required'}), 400
    try:
        after_id = max(0, int(request.headers.get('Last-Event-ID')
                              or request.args.get('after') or 0))
    except ValueError:
        after_id = 0
    waiter = stream_hub.open(user_id, device_id)
    if waiter is None:
        return jsonify({'error': 'Too many streams'}), 429
    response = Response(
        command_stream(user_id, device_id, after_id, waiter),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            # nginx would otherwise hold events back to fill its buffer.
            'X-Accel-Buffering': 'no',
        },
    )
    # A generator that was never started runs no `finally`: release the slot
    # here too, for a client that left before the first byte.
    response.call_on_close(lambda: stream_hub.close(user_id, device_id, waiter))
    return response


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
