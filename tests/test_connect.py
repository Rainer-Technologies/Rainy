"""Rainy Connect API tests: presence, queue upload, commands and their expiry."""
import json
import threading

import pytest

import routes.connect as connect_routes
from models import connect as connect_model
from models.connect import (
    COMMAND_TTL_SECONDS, FORGET_SECONDS, MAX_QUEUE, STALE_SECONDS, ConnectModel,
)
from models.database import Database
from models.user import UserModel

DEVICE = 'test-device-a'
OTHER = 'test-device-b'


@pytest.fixture(autouse=True)
def clean_tables(app):
    def wipe():
        for table in ('connect_commands', 'connect_session_queues', 'connect_sessions'):
            Database.execute_query(f"DELETE FROM {table} WHERE device_id LIKE 'test-device-%'")
    wipe()
    yield
    wipe()


@pytest.fixture
def clock(monkeypatch):
    """A clock the test can move; starts at the real time."""
    state = {'now': connect_model.time.time()}
    monkeypatch.setattr(connect_model, '_now', lambda: state['now'])

    def advance(seconds):
        state['now'] += seconds
    return advance


@pytest.fixture
def other_user():
    email = 'connect-other@test.local'
    if not UserModel.get_user_by_email(email):
        UserModel.create_user('connect_other', email, 'secret1')
    user_id = UserModel.get_user_by_email(email)['id']
    yield user_id
    UserModel.delete_user(user_id)


def _songs(count):
    return [{'id': i, 'title': f'Song {i}', 'artist': 'A', 'album': 'B', 'cover_path': None}
            for i in range(count)]


def _beat(client, device=DEVICE, **fields):
    payload = {'device_id': device, 'device_name': 'Test', 'device_type': 'web',
               'song_id': 1, 'song_title': 'Song 1', 'is_playing': True}
    payload.update(fields)
    r = client.post('/api/connect/heartbeat', json=payload)
    assert r.status_code == 200
    return r.get_json()


def _device(client, device=DEVICE, **query):
    r = client.get(f'/api/connect/device/{device}', query_string=query)
    assert r.status_code == 200
    return r.get_json()['device']


def _send(client, command, args=None, device=DEVICE):
    return client.post(f'/api/connect/device/{device}/command',
                       json={'command': command, 'args': args or {}})


def _poll(client, device=DEVICE):
    r = client.get('/api/connect/commands', query_string={'device_id': device})
    assert r.status_code == 200
    return r.get_json()['commands']


# ── Presence ──

def test_heartbeat_registers_device(client):
    _beat(client, position=12.5, duration=200, volume=0)
    devices = client.get('/api/connect/devices').get_json()['devices']
    device = next(d for d in devices if d['device_id'] == DEVICE)
    assert device['song_title'] == 'Song 1'
    assert device['position'] == 12.5
    assert device['volume'] == 0  # a muted device is not reported at 100
    assert device['online'] is True


def test_heartbeat_requires_device_id(client):
    assert client.post('/api/connect/heartbeat', json={}).status_code == 400
    r = client.post('/api/connect/heartbeat', json={'device_id': 'x' * 65})
    assert r.status_code == 400


def test_heartbeat_tolerates_garbage_fields(client):
    _beat(client, position='soon', duration=None, volume=900, queue_index=-4,
          device_name='n' * 500, song_id='abc')
    device = _device(client)
    assert device['position'] == 0
    assert device['volume'] == 100
    assert len(device['device_name']) == 128
    assert device['song_id'] is None


def test_exclude_hides_own_device(client):
    _beat(client)
    devices = client.get('/api/connect/devices',
                         query_string={'exclude': DEVICE}).get_json()['devices']
    assert all(d['device_id'] != DEVICE for d in devices)


def _listed(client, **query):
    devices = client.get('/api/connect/devices', query_string=query).get_json()['devices']
    return {d['device_id']: d for d in devices}


def test_quiet_devices_go_offline_then_are_forgotten(client, clock):
    _beat(client)
    _beat(client, device=OTHER)
    clock(STALE_SECONDS + 1)
    _beat(client, device=OTHER)

    # Offline: out of the plain listing (what older clients ask for)…
    assert DEVICE not in _listed(client)
    # …but still known to a client that asks for inactive devices.
    listed = _listed(client, offline='1')
    assert listed[DEVICE]['online'] is False
    assert listed[DEVICE]['idle_for'] == pytest.approx(STALE_SECONDS + 1, abs=0.01)
    assert list(listed) == [OTHER, DEVICE]  # online ones first
    assert _device(client)['online'] is False

    clock(FORGET_SECONDS)
    assert DEVICE not in _listed(client, offline='1')
    assert client.get(f'/api/connect/device/{DEVICE}').status_code == 404


def test_an_open_stream_counts_as_presence(client, clock):
    """A background tab heartbeats once a minute at best; its stream is what
    says it is still there."""
    _beat(client)
    clock(STALE_SECONDS + 1)
    ConnectModel.touch_stream(1, DEVICE)
    device = _device(client)
    assert device['online'] is True
    # The playback snapshot is still as old as the last heartbeat.
    assert device['state_age'] == pytest.approx(STALE_SECONDS + 1, abs=0.01)
    assert _send(client, 'play').status_code == 200


def test_repeat_mode_is_one_vocabulary(client):
    _beat(client, repeat_mode='off')  # what the mobile app says
    assert _device(client)['repeat_mode'] == 'none'
    _beat(client, repeat_mode='one')
    assert _device(client)['repeat_mode'] == 'one'


def test_state_age_follows_server_clock(client, clock):
    _beat(client)
    clock(3)
    assert _device(client)['state_age'] == pytest.approx(3, abs=0.01)


def test_requires_auth(anon_client):
    assert anon_client.get('/api/connect/devices').status_code == 401
    assert anon_client.post('/api/connect/heartbeat', json={'device_id': DEVICE}).status_code == 401


# ── Queue ──

def test_queue_is_stored_and_kept_when_omitted(client):
    _beat(client, queue=_songs(3), queue_index=1)
    _beat(client, queue_index=2)  # no `queue` key: unchanged
    device = _device(client)
    assert [s['id'] for s in device['queue']] == [0, 1, 2]
    assert device['queue_index'] == 2


def test_need_queue_until_the_server_has_it(client, clock):
    assert _beat(client, queue_sig='v1')['need_queue'] is True
    assert _beat(client, queue_sig='v1', queue=_songs(2))['need_queue'] is False
    assert _beat(client, queue_sig='v1')['need_queue'] is False
    assert _beat(client, queue_sig='v2')['need_queue'] is True  # queue changed locally

    # Forgotten: the queue row went with the device, so it is asked for again.
    _beat(client, queue_sig='v2', queue=_songs(2))
    clock(FORGET_SECONDS + 1)
    client.get('/api/connect/devices')
    assert _beat(client, queue_sig='v2')['need_queue'] is True


def test_long_queue_is_windowed_around_the_current_track(client):
    _beat(client, queue=_songs(2000), queue_index=1234)
    device = _device(client)
    assert len(device['queue']) == MAX_QUEUE
    assert device['queue_total'] == 2000
    # The windowed index still points at the track that is playing.
    assert device['queue'][device['queue_index']]['id'] == 1234
    assert device['queue_offset'] + device['queue_index'] == 1234


def test_client_window_keeps_its_offset(client):
    _beat(client, queue=_songs(10), queue_offset=300, queue_total=900, queue_index=304)
    device = _device(client)
    assert device['queue_offset'] == 300
    assert device['queue_index'] == 4
    assert device['queue_total'] == 900


def test_known_queue_hash_skips_the_queue(client):
    _beat(client, queue=_songs(3))
    device = _device(client)
    assert device['queue_hash']
    again = _device(client, queue_hash=device['queue_hash'])
    assert again['queue_unchanged'] is True and 'queue' not in again
    _beat(client, queue=_songs(4))
    assert len(_device(client, queue_hash=device['queue_hash'])['queue']) == 4


def test_listing_without_queues(client):
    _beat(client, queue=_songs(3))
    devices = client.get('/api/connect/devices',
                         query_string={'queues': '0'}).get_json()['devices']
    device = next(d for d in devices if d['device_id'] == DEVICE)
    assert 'queue' not in device and device['queue_hash']


# ── Commands ──

def test_command_roundtrip_and_ack(client):
    _beat(client)
    r = _send(client, 'seek', {'position': 30})
    assert r.status_code == 200
    command_id = r.get_json()['command_id']

    commands = _poll(client)
    assert commands == [{'id': command_id, 'command': 'seek', 'args': {'position': 30}}]
    assert _poll(client) == []  # delivered once

    assert _device(client)['last_cmd_id'] < command_id
    _beat(client, last_cmd_id=command_id)
    assert _device(client)['last_cmd_id'] == command_id
    _beat(client, last_cmd_id=0)  # a late, older beat does not take the ack back
    assert _device(client)['last_cmd_id'] == command_id


def test_commands_arrive_in_order(client):
    _beat(client)
    for name in ('pause', 'next', 'play'):
        _send(client, name)
    assert [c['command'] for c in _poll(client)] == ['pause', 'next', 'play']


def test_unknown_command_and_device(client):
    _beat(client)
    assert _send(client, 'self_destruct').status_code == 400
    assert _send(client, 'play', device='test-device-missing').status_code == 404


def test_expired_commands_are_dropped(client, clock):
    _beat(client)
    _send(client, 'next')
    clock(COMMAND_TTL_SECONDS + 1)
    _beat(client)
    _send(client, 'pause')
    assert [c['command'] for c in _poll(client)] == ['pause']
    left = Database.execute_query(
        "SELECT COUNT(*) AS n FROM connect_commands WHERE device_id = %s", (DEVICE,),
        fetch_one=True)
    assert left['n'] == 0


def test_no_commands_for_an_offline_device(client, clock):
    _beat(client)
    clock(STALE_SECONDS + 1)
    assert _send(client, 'play').status_code == 409
    assert _poll(client) == []


def test_commands_die_with_the_device(client, clock):
    _beat(client)
    _send(client, 'play')
    client.delete(f'/api/connect/device/{DEVICE}')
    _beat(client)
    assert _poll(client) == []

    # ...and when the device is forgotten instead of deregistering.
    _send(client, 'play')
    clock(FORGET_SECONDS + 1)
    client.get('/api/connect/devices')
    left = Database.execute_query(
        "SELECT COUNT(*) AS n FROM connect_commands WHERE device_id = %s", (DEVICE,),
        fetch_one=True)
    assert left['n'] == 0


def test_claimed_commands_are_not_delivered_twice(client):
    _beat(client)
    _send(client, 'next')
    # A poll that claimed the row but has not deleted it yet.
    Database.execute_query(
        "UPDATE connect_commands SET claim = %s WHERE device_id = %s", ('other-poll', DEVICE))
    assert _poll(client) == []


def test_repeat_command_is_normalized(client):
    _beat(client)
    _send(client, 'repeat', {'mode': 'off'})
    assert _poll(client)[0]['args'] == {'mode': 'none'}


def test_oversized_play_queue_is_windowed(client):
    _beat(client)
    r = _send(client, 'play_queue', {'queue': _songs(3000), 'index': 2500})
    assert r.status_code == 200
    args = _poll(client)[0]['args']
    assert len(args['queue']) == MAX_QUEUE
    assert args['queue'][args['index']]['id'] == 2500


# ── Ownership ──

def test_devices_are_private_to_their_user(app, client, other_user):
    from conftest import sign_in
    stranger = app.test_client()
    sign_in(stranger, other_user)

    _beat(client)
    assert stranger.get(f'/api/connect/device/{DEVICE}').status_code == 404
    assert _send(stranger, 'play').status_code == 404
    assert stranger.get('/api/connect/devices').get_json()['devices'] == []


def test_device_follows_the_account_that_uses_it(app, client, other_user):
    """Same browser, another account signs in: the device is theirs now."""
    from conftest import sign_in
    second = app.test_client()
    sign_in(second, other_user)

    _beat(client, queue=_songs(2))
    _beat(second, queue=_songs(1), song_title='Theirs')
    assert _device(second)['song_title'] == 'Theirs'
    assert client.get(f'/api/connect/device/{DEVICE}').status_code == 404
    assert ConnectModel.device_status(other_user, DEVICE) == 'online'


# ── Command stream ──

def _events(chunk):
    """Parse one yielded SSE chunk into (event, data, id) tuples."""
    out = []
    for block in chunk.strip().split('\n\n'):
        fields = dict(line.split(': ', 1) for line in block.split('\n') if ': ' in line)
        if 'event' in fields:
            out.append((fields['event'], json.loads(fields['data']), fields.get('id')))
    return out


@pytest.fixture
def fast_stream(monkeypatch):
    monkeypatch.setattr(connect_routes, 'STREAM_POLL_SECONDS', 0.01)


def _open_stream(after=0):
    waiter = connect_routes.stream_hub.open(1, DEVICE)
    return connect_routes.command_stream(1, DEVICE, after, waiter), waiter


def test_stream_delivers_commands_without_consuming_them(client, fast_stream):
    _beat(client)
    first = _send(client, 'pause').get_json()['command_id']
    stream, _ = _open_stream()
    try:
        assert _events(next(stream)) == [('open', {}, None)]
        assert _events(next(stream)) == [
            ('command', {'id': first, 'command': 'pause', 'args': {}}, str(first))]

        second = _send(client, 'seek', {'position': 9}).get_json()['command_id']
        assert _events(next(stream))[0][1]['id'] == second

        # Still there for a stream that reconnects without having applied
        # them — resuming after `first` only gets the second one.
        resumed, _ = _open_stream(after=first)
        try:
            next(resumed)
            assert [e[1]['id'] for e in _events(next(resumed))] == [second]
        finally:
            resumed.close()

        # The heartbeat that reports them applied is what removes them.
        _beat(client, last_cmd_id=second, cmd_ack=second)
        assert ConnectModel.peek_commands(1, DEVICE) == []
        assert _poll(client) == []
    finally:
        stream.close()


def test_stream_skips_expired_commands(client, clock):
    _beat(client)
    _send(client, 'next')
    clock(COMMAND_TTL_SECONDS + 1)
    assert ConnectModel.peek_commands(1, DEVICE) == []


def test_stream_marks_the_device_present(client, clock, fast_stream):
    _beat(client)
    clock(STALE_SECONDS + 1)
    assert _device(client)['online'] is False
    stream, _ = _open_stream()
    try:
        next(stream)  # "open" — sent once the stream has recorded itself
        assert _device(client)['online'] is True
    finally:
        stream.close()


def test_a_pushed_command_wakes_the_stream(client, monkeypatch):
    """With polling effectively off, only the hub can deliver the command."""
    monkeypatch.setattr(connect_routes, 'STREAM_POLL_SECONDS', 30)
    monkeypatch.setattr(connect_routes, 'STREAM_PING_SECONDS', 3600)
    _beat(client)
    stream, _ = _open_stream()
    got = []
    try:
        next(stream)

        def read():
            got.extend(_events(next(stream)))
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        reader.join(0.3)
        assert reader.is_alive() and got == []  # parked, nothing to send

        _send(client, 'play')
        reader.join(5)
        assert [e[1]['command'] for e in got] == ['play']
    finally:
        stream.close()


def test_stream_ends_and_frees_its_slot(client, monkeypatch, fast_stream):
    monkeypatch.setattr(connect_routes, 'STREAM_MAX_SECONDS', 0.05)
    monkeypatch.setattr(connect_routes, 'STREAM_PING_SECONDS', 3600)
    _beat(client)
    hub = connect_routes.stream_hub
    stream, waiter = _open_stream()
    assert DEVICE in hub._waiters
    assert list(stream)[0].endswith('data: {}\n\n')  # just "open", then it ends
    assert DEVICE not in hub._waiters
    hub.close(1, DEVICE, waiter)  # a second close is harmless
    assert hub._per_user.get(1, 0) == 0


def test_stream_route(client, anon_client, monkeypatch):
    assert anon_client.get('/api/connect/stream?device_id=x').status_code == 401
    assert client.get('/api/connect/stream').status_code == 400

    _beat(client)
    r = client.get(f'/api/connect/stream?device_id={DEVICE}', buffered=False)
    try:
        assert r.status_code == 200
        assert r.mimetype == 'text/event-stream'
        assert r.headers['X-Accel-Buffering'] == 'no'
        assert b'event: open' in next(r.response)
    finally:
        r.close()
    assert DEVICE not in connect_routes.stream_hub._waiters

    monkeypatch.setattr(connect_routes, 'STREAM_MAX_PER_USER', 0)
    assert client.get(f'/api/connect/stream?device_id={DEVICE}').status_code == 429
