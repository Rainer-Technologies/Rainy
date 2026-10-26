"""Listen together: invitations, joining and leaving, the host's playback, and
what the stream tells each side."""
import json

import pytest

from models import listen as listen_model
from models.chat import ChatModel
from models.database import Database
from models.library_access import LibraryAccessModel
from models.user import UserModel
from routes import chat as chat_routes
from routes import listen as listen_routes
from utils import ratelimit

PEOPLE = [('listen_a', 'listena@test.local'), ('listen_b', 'listenb@test.local'),
          ('listen_c', 'listenc@test.local')]


@pytest.fixture
def clock(monkeypatch):
    now = {'t': 1000.0}
    monkeypatch.setattr(listen_model, '_now', lambda: now['t'])
    return now


@pytest.fixture
def world():
    """Host a, friend b (friends with a), stranger c. Songs 1 and 2 are a's;
    song 3 is nobody's to play."""
    ids = []
    for username, email in PEOPLE:
        if not UserModel.get_user_by_email(email):
            UserModel.create_user(username, email, 'secret1')
        ids.append(UserModel.get_user_by_email(email)['id'])
    a, b, c = ids
    songs = [Database.execute_query(
        "INSERT INTO songs (file_path, title, artist, album) VALUES (%s, %s, %s, %s)",
        (f'/test/listen-{n}.mp3', f'Listen {n}', 'Listen Artist', 'Listen Album'))
        for n in (1, 2, 3)]
    for song in songs[:2]:
        Database.execute_query(
            "INSERT IGNORE INTO library_access (user_id, song_id, origin) VALUES (%s, %s, 'import')",
            (a, song))
    ratelimit.reset(f'listen:invite:{a}')
    yield {'a': a, 'b': b, 'c': c, 'one': songs[0], 'two': songs[1], 'nobody': songs[2]}
    for song in songs:
        Database.execute_query("DELETE FROM songs WHERE id = %s", (song,))
    for uid in ids:
        UserModel.delete_user(uid)


@pytest.fixture
def client_as(app):
    def _make(user_id):
        from conftest import sign_in
        c = app.test_client()
        sign_in(c, user_id)
        return c
    return _make


@pytest.fixture
def pair(world, client_as):
    """Clients for host a and friend b, already friends."""
    ca, cb = client_as(world['a']), client_as(world['b'])
    ca.post('/api/friends/requests', json={'email': 'listenb@test.local'})
    rid = cb.get('/api/friends/requests').get_json()['incoming'][0]['id']
    cb.post(f'/api/friends/requests/{rid}/accept')
    return ca, cb


def _invite(client, friend_id, device='dev-host'):
    return client.post('/api/listen/invite', json={'friend_id': friend_id, 'device_id': device})


def _play(client, song_id, position=0, playing=True, device='dev-host'):
    """One Connect beat from the host's device, the way the player sends it."""
    return client.post('/api/connect/heartbeat', json={
        'device_id': device, 'device_name': 'Test', 'device_type': 'web',
        'song_id': song_id, 'song_title': 'x', 'song_artist': 'y',
        'position': position, 'duration': 200, 'is_playing': playing})


def _session(client, session_id):
    return client.get(f'/api/listen/{session_id}').get_json()['session']


# ── Invitations ──

def test_a_host_invites_a_friend_and_the_chat_shows_a_card(world, pair):
    ca, cb = pair
    res = _invite(ca, world['b'])
    assert res.status_code == 201
    session = res.get_json()['session']
    assert session['role'] == 'host' and session['state'] == 'host'
    assert session['members'] == [{'id': world['b'], 'username': 'listen_b', 'state': 'invited'}]
    assert session['song'] is None and session['playing'] is False

    thread = cb.get(f"/api/chat/{world['a']}/messages").get_json()['messages']
    card = thread[-1]
    assert card['kind'] == 'listen_invite'
    assert card['listen'] == {'session_id': session['id'], 'status': 'live', 'state': 'invited',
                              'host': {'id': world['a'], 'username': 'listen_a'}}


def test_a_friend_who_is_invited_sees_no_song_until_they_join(world, pair):
    ca, cb = pair
    _play(ca, world['one'], position=5)
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    view = _session(cb, session_id)
    assert view['state'] == 'invited' and view['song'] is None and view['playing'] is False
    assert LibraryAccessModel.can_play(world['b'], world['one']) is False


def test_joining_plays_the_host_song_and_only_that_song(world, pair):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    _play(ca, world['one'], position=42)
    joined = cb.post(f'/api/listen/{session_id}/join')
    assert joined.status_code == 200
    view = joined.get_json()['session']
    assert view['state'] == 'joined'
    assert view['song']['id'] == world['one'] and view['playing'] is True
    assert view['position'] >= 42
    assert LibraryAccessModel.can_play(world['b'], world['one']) is True
    # Another song of the host's stays out of reach: only what they play now.
    assert LibraryAccessModel.can_play(world['b'], world['two']) is False


def test_a_listener_keeps_the_song_they_hear_only_while_they_listen(world, pair):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    _play(ca, world['one'], position=5)
    cb.post(f'/api/listen/{session_id}/join')
    song = _session(cb, session_id)['song']
    assert song['in_library'] is False

    saved = cb.post(f"/api/music/library/songs/{world['one']}")
    assert saved.status_code == 200
    assert _session(cb, session_id)['song']['in_library'] is True
    assert LibraryAccessModel.has_access(world['b'], world['one']) is True

    # Once they leave, the song is only playable if it is in their library.
    _play(ca, world['two'], position=0)
    cb.post(f'/api/listen/{session_id}/leave')
    assert cb.post(f"/api/music/library/songs/{world['two']}").status_code == 404
    assert LibraryAccessModel.has_access(world['b'], world['two']) is False


def test_leaving_closes_the_invitation_until_the_host_invites_again(world, pair):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    assert cb.post(f'/api/listen/{session_id}/join').status_code == 200
    assert cb.post(f'/api/listen/{session_id}/leave').status_code == 200

    gone = _session(cb, session_id)
    assert gone['state'] == 'left' and gone['members'] == []
    assert cb.post(f'/api/listen/{session_id}/join').status_code == 409
    assert LibraryAccessModel.can_play(world['b'], world['one']) is False

    _invite(ca, world['b'])
    assert _session(cb, session_id)['state'] == 'invited'
    assert cb.post(f'/api/listen/{session_id}/join').status_code == 200


def test_only_the_newest_invitation_card_is_open(world, pair):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    _invite(ca, world['b'])

    def cards():
        thread = cb.get(f"/api/chat/{world['a']}/messages").get_json()['messages']
        return [m['listen']['state'] for m in thread if m['kind'] == 'listen_invite']

    assert cards() == ['left', 'invited']
    assert cb.post(f'/api/listen/{session_id}/join').status_code == 200
    assert cards() == ['left', 'joined']


def test_declining_an_invitation_closes_it(world, pair):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    assert cb.post(f'/api/listen/{session_id}/leave').status_code == 200
    assert cb.post(f'/api/listen/{session_id}/join').status_code == 409
    assert cb.post(f'/api/listen/{session_id}/leave').status_code == 404


def test_a_friend_cannot_listen_twice_and_the_session_has_room_for_limited_listeners(
        world, pair, client_as, monkeypatch):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    cb.post(f'/api/listen/{session_id}/join')
    assert _invite(ca, world['b']).status_code == 409

    monkeypatch.setattr(listen_routes, 'MAX_MEMBERS', 1)
    cc = client_as(world['c'])
    ca.post('/api/friends/requests', json={'email': 'listenc@test.local'})
    rid = cc.get('/api/friends/requests').get_json()['incoming'][0]['id']
    cc.post(f'/api/friends/requests/{rid}/accept')
    assert _invite(ca, world['c']).status_code == 409


def test_strangers_and_non_friends_have_no_part_in_a_session(world, pair, client_as):
    ca, _ = pair
    cc = client_as(world['c'])
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    assert cc.get(f'/api/listen/{session_id}').status_code == 404
    assert cc.post(f'/api/listen/{session_id}/join').status_code == 409
    assert _invite(ca, world['c']).status_code == 403
    assert _invite(ca, world['a']).status_code == 400


def test_only_the_host_ends_a_session_and_ending_closes_every_invitation(world, pair):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    cb.post(f'/api/listen/{session_id}/join')
    assert cb.post(f'/api/listen/{session_id}/end').status_code == 404

    assert ca.post(f'/api/listen/{session_id}/end').status_code == 200
    view = _session(cb, session_id)
    assert view['status'] == 'ended' and view['state'] == 'left' and view['song'] is None
    assert cb.post(f'/api/listen/{session_id}/join').status_code == 409


# ── The host's playback ──

def test_the_session_follows_the_host_device_only(world, pair, clock):
    ca, _ = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    _play(ca, world['one'], position=0)
    before = _session(ca, session_id)
    assert before['song']['id'] == world['one'] and before['playing'] is True

    _play(ca, world['two'], position=0, device='dev-other-tab')
    assert _session(ca, session_id)['song']['id'] == world['one']


def test_song_play_state_and_seeks_are_sequenced_but_ticks_are_not(world, pair, clock):
    ca, _ = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    _play(ca, world['one'], position=10)
    first = _session(ca, session_id)['state_seq']

    clock['t'] += 2
    _play(ca, world['one'], position=12.0)  # a tick: where it should be
    assert _session(ca, session_id)['state_seq'] == first

    clock['t'] += 2
    _play(ca, world['one'], position=60.0)  # a seek
    seeked = _session(ca, session_id)['state_seq']
    assert seeked == first + 1

    clock['t'] += 1
    _play(ca, world['one'], position=60.0, playing=False)  # paused
    assert _session(ca, session_id)['state_seq'] == seeked + 1
    assert _session(ca, session_id)['playing'] is False


def test_the_position_moves_while_the_host_plays(world, pair, clock):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    cb.post(f'/api/listen/{session_id}/join')
    _play(ca, world['one'], position=30)
    clock['t'] += 5
    assert _session(cb, session_id)['position'] == pytest.approx(35, abs=0.01)


def test_the_host_cannot_share_a_song_they_cannot_play(world, pair, clock):
    ca, _ = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    _play(ca, world['nobody'], position=0)
    view = _session(ca, session_id)
    assert view['song'] is None and view['playing'] is False


def test_the_host_is_live_while_its_device_beats(world, pair, clock):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    cb.post(f'/api/listen/{session_id}/join')
    _play(ca, world['one'])
    assert _session(cb, session_id)['host_live'] is True
    clock['t'] += listen_model.HOST_LIVE_SECONDS + 1
    assert _session(cb, session_id)['host_live'] is False


# ── The stream ──

@pytest.fixture
def fast_stream(monkeypatch):
    monkeypatch.setattr(chat_routes, 'STREAM_POLL_SECONDS', 0.01)
    monkeypatch.setattr(chat_routes, 'STREAM_PRESENCE_SECONDS', 0.01)


def _events(chunk):
    out = []
    for block in chunk.strip().split('\n\n'):
        fields = dict(line.split(': ', 1) for line in block.split('\n') if ': ' in line)
        if 'event' in fields:
            out.append((fields['event'], json.loads(fields['data'])))
    return out


def _next_listen(stream):
    for _ in range(200):
        for name, data in _events(next(stream)):
            if name == 'listen':
                return data
    raise AssertionError('no listen event')


def test_the_stream_tells_the_host_and_the_friend_about_each_change(
        world, pair, fast_stream):
    ca, cb = pair
    host = chat_routes.chat_stream(world['a'], ChatModel.latest_id(world['a']),
                                   chat_routes.stream_hub.open(world['a']))
    friend = chat_routes.chat_stream(world['b'], ChatModel.latest_id(world['b']),
                                     chat_routes.stream_hub.open(world['b']))
    try:
        next(host)
        next(friend)
        session_id = _invite(ca, world['b']).get_json()['session']['id']

        assert _next_listen(friend)['state'] == 'invited'
        assert _next_listen(host)['members'][0]['state'] == 'invited'

        cb.post(f'/api/listen/{session_id}/join')
        assert _next_listen(host)['members'][0]['state'] == 'joined'
        assert _next_listen(friend)['state'] == 'joined'
    finally:
        host.close()
        friend.close()


def test_the_stream_sends_the_session_to_a_friend_who_was_invited_before_it_opened(
        world, pair, fast_stream):
    ca, cb = pair
    session_id = _invite(ca, world['b']).get_json()['session']['id']
    friend = chat_routes.chat_stream(world['b'], ChatModel.latest_id(world['b']),
                                     chat_routes.stream_hub.open(world['b']))
    try:
        next(friend)
        assert _next_listen(friend)['id'] == session_id
    finally:
        friend.close()
