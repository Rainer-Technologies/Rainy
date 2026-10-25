"""Friends chat: messages, shared songs and invitations, presence, the stream."""
import json
import time

import pytest

from models import presence as presence_model
from models.chat import ChatModel
from models.database import Database
from models.library_access import LibraryAccessModel
from models.presence import PresenceModel
from models.user import UserModel
from routes import chat as chat_routes
from utils import ratelimit

PEOPLE = [('chat_a', 'chata@test.local'), ('chat_b', 'chatb@test.local'),
          ('chat_c', 'chatc@test.local')]


@pytest.fixture
def world():
    """Three accounts (a and b will be friends, c is a stranger), a song only
    `a` owns, and a playlist `a` owns."""
    ids = []
    for username, email in PEOPLE:
        if not UserModel.get_user_by_email(email):
            UserModel.create_user(username, email, 'secret1')
        ids.append(UserModel.get_user_by_email(email)['id'])
    a, b, c = ids
    song_id = Database.execute_query(
        "INSERT INTO songs (file_path, title, artist, album) VALUES (%s, %s, %s, %s)",
        ('/test/chat-song.mp3', 'Chat Song', 'Chat Artist', 'Chat Album'))
    Database.execute_query(
        "INSERT IGNORE INTO library_access (user_id, song_id, origin) VALUES (%s, %s, 'import')",
        (a, song_id))
    playlist_id = Database.execute_query(
        "INSERT INTO playlists (name, owner_user_id) VALUES (%s, %s)", ('Chat Mix', a))
    ratelimit.reset(f'chat:send:{a}')
    yield {'a': a, 'b': b, 'c': c, 'song': song_id, 'playlist': playlist_id}
    Database.execute_query("DELETE FROM playlists WHERE id = %s", (playlist_id,))
    Database.execute_query("DELETE FROM songs WHERE id = %s", (song_id,))
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
    """Clients for a and b, already friends."""
    ca, cb = client_as(world['a']), client_as(world['b'])
    ca.post('/api/friends/requests', json={'email': 'chatb@test.local'})
    rid = cb.get('/api/friends/requests').get_json()['incoming'][0]['id']
    cb.post(f'/api/friends/requests/{rid}/accept')
    return ca, cb


def _say(client, to, body='hi', **extra):
    return client.post(f'/api/chat/{to}/messages', json={'kind': 'text', 'body': body, **extra})


def _beat(user_id, **fields):
    from models.connect import ConnectModel
    ConnectModel.heartbeat(user_id, f'dev-{user_id}', {
        'song_id': None, 'song_title': 'T', 'song_artist': 'A', 'is_playing': True,
        'position': 1, 'duration': 100, **fields})


def _events(chunk):
    out = []
    for block in chunk.strip().split('\n\n'):
        fields = dict(line.split(': ', 1) for line in block.split('\n') if ': ' in line)
        if 'event' in fields:
            out.append((fields['event'], json.loads(fields['data']), fields.get('id')))
    return out


# ── Messages ──

def test_friends_exchange_messages_and_unread_counts(world, pair):
    ca, cb = pair
    assert _say(ca, world['b'], 'hello').status_code == 201
    assert _say(ca, world['b'], 'there').status_code == 201

    talk = cb.get('/api/chat/conversations').get_json()['conversations'][0]
    assert talk['friend']['id'] == world['a']
    assert talk['unread'] == 2
    assert talk['last_message']['body'] == 'there'

    thread = cb.get(f"/api/chat/{world['a']}/messages").get_json()['messages']
    assert [m['body'] for m in thread] == ['hello', 'there']

    assert cb.post(f"/api/chat/{world['a']}/read").get_json()['last_read_id'] == thread[-1]['id']
    talk = cb.get('/api/chat/conversations').get_json()['conversations'][0]
    assert talk['unread'] == 0
    # The author still has nothing unread of their own.
    assert ca.get('/api/chat/conversations').get_json()['conversations'][0]['unread'] == 0


def test_a_read_mark_never_moves_back_or_past_the_newest(world, pair):
    ca, cb = pair
    first = _say(ca, world['b'], 'one').get_json()['message']['id']
    _say(ca, world['b'], 'two')
    newest = ChatModel.mark_read(world['b'], world['a'], up_to=10 ** 9)
    assert newest > first
    assert ChatModel.mark_read(world['b'], world['a'], up_to=first) == newest


def test_thread_pages_back_with_before(world, pair):
    ca, _ = pair
    ids = [_say(ca, world['b'], f'm{i}').get_json()['message']['id'] for i in range(5)]
    page = ca.get(f"/api/chat/{world['b']}/messages?limit=2&before={ids[3]}").get_json()['messages']
    assert [m['id'] for m in page] == ids[1:3]


def test_strangers_cannot_talk_or_read(world, pair, client_as):
    ca, _ = pair
    cc = client_as(world['c'])
    _say(ca, world['b'], 'secret')
    assert _say(cc, world['a']).status_code == 403
    assert cc.get(f"/api/chat/{world['a']}/messages").status_code == 403
    assert cc.post(f"/api/chat/{world['a']}/read").status_code == 403
    assert _say(ca, world['a']).status_code == 400  # yourself


def test_unfriending_closes_the_conversation(world, pair):
    ca, cb = pair
    _say(ca, world['b'])
    assert cb.delete(f"/api/friends/{world['a']}").status_code == 200
    assert _say(cb, world['a']).status_code == 403
    assert cb.get(f"/api/chat/{world['a']}/messages").status_code == 403


def test_text_is_validated_and_rate_limited(world, pair):
    ca, _ = pair
    assert _say(ca, world['b'], '   ').status_code == 400
    assert _say(ca, world['b'], 'x' * 2001).status_code == 400
    assert ca.post(f"/api/chat/{world['b']}/messages", json={'kind': 'nope'}).status_code == 400
    for _ in range(chat_routes.SEND_LIMIT[0]):
        _say(ca, world['b'])
    assert _say(ca, world['b']).status_code == 429


# ── Songs ──

def _send_song(client, to, song_id, **extra):
    return client.post(f'/api/chat/{to}/messages',
                       json={'kind': 'song', 'song_id': song_id, **extra})


def test_a_shared_song_is_playable_and_keepable_by_the_receiver(world, pair, client_as):
    ca, cb = pair
    assert not LibraryAccessModel.can_play(world['b'], world['song'])

    sent = _send_song(ca, world['b'], world['song'], body='listen to this')
    assert sent.status_code == 201
    assert sent.get_json()['message']['song']['in_library'] is True  # the sender's own view

    received = cb.get(f"/api/chat/{world['a']}/messages").get_json()['messages'][0]
    assert received['body'] == 'listen to this'
    assert received['song']['title'] == 'Chat Song'
    assert received['song']['in_library'] is False
    assert LibraryAccessModel.can_play(world['b'], world['song'])
    assert not LibraryAccessModel.has_access(world['b'], world['song'])

    # A third account gets nothing from it.
    assert not LibraryAccessModel.can_play(world['c'], world['song'])

    # Keeping it is the usual save-to-library.
    assert cb.post(f"/api/music/library/songs/{world['song']}").status_code == 200
    received = cb.get(f"/api/chat/{world['a']}/messages").get_json()['messages'][0]
    assert received['song']['in_library'] is True


def test_a_shared_song_stops_being_playable_when_the_friendship_ends(world, pair):
    ca, cb = pair
    _send_song(ca, world['b'], world['song'])
    assert LibraryAccessModel.can_play(world['b'], world['song'])
    cb.delete(f"/api/friends/{world['a']}")
    assert not LibraryAccessModel.can_play(world['b'], world['song'])


def test_you_can_only_send_songs_from_your_library(world, pair):
    _, cb = pair
    assert _send_song(cb, world['a'], world['song']).status_code == 404
    assert _send_song(cb, world['a'], 'x').status_code == 400


# ── Playlist invitations ──

def _invite(client, to, playlist_id, **extra):
    return client.post(f'/api/chat/{to}/messages',
                       json={'kind': 'playlist_invite', 'playlist_id': playlist_id, **extra})


def test_an_invitation_message_follows_the_share(world, pair):
    ca, cb = pair
    sent = _invite(ca, world['b'], world['playlist'], role='viewer')
    assert sent.status_code == 201
    invite = sent.get_json()['message']['invite']
    assert invite['state'] == 'pending' and invite['role'] == 'viewer'
    assert invite['playlist_name'] == 'Chat Mix'

    # The receiver accepts it with the playlist API, as from the friends page.
    assert cb.post(f"/api/playlists/invites/{invite['share_id']}/accept").status_code == 200
    seen = cb.get(f"/api/chat/{world['a']}/messages").get_json()['messages'][0]
    assert seen['invite']['state'] == 'accepted'

    # Already a member: a second invitation is refused.
    assert _invite(ca, world['b'], world['playlist']).status_code == 409


def test_a_declined_invitation_reads_as_closed(world, pair):
    ca, cb = pair
    share = _invite(ca, world['b'], world['playlist']).get_json()['message']['invite']['share_id']
    cb.post(f'/api/playlists/invites/{share}/decline')
    seen = cb.get(f"/api/chat/{world['a']}/messages").get_json()['messages'][0]
    assert seen['invite']['state'] == 'closed'


def test_only_the_owner_invites_to_a_playlist(world, pair):
    _, cb = pair
    assert _invite(cb, world['a'], world['playlist']).status_code == 403
    assert _invite(cb, world['a'], 'x').status_code == 400


# ── Presence ──

def test_presence_needs_a_live_client_and_respects_privacy(world, pair, monkeypatch):
    ca, cb = pair
    assert ca.get('/api/chat/presence').get_json()['presence'][0]['online'] is False

    PresenceModel.touch(world['b'])
    _beat(world['b'], song_id=world['song'])
    entry = ca.get('/api/chat/presence').get_json()['presence'][0]
    assert entry['online'] is True
    assert entry['listening']['title'] == 'T'
    assert 'queue' not in json.dumps(entry)

    # Hide what is playing…
    cb.put('/api/chat/settings', json={'share_listening': False})
    entry = ca.get('/api/chat/presence').get_json()['presence'][0]
    assert entry['online'] is True and entry['listening'] is None
    # …or everything.
    cb.put('/api/chat/settings', json={'share_online': False})
    entry = ca.get('/api/chat/presence').get_json()['presence'][0]
    assert entry['online'] is False

    # Time passes: without a stream or a beat the account fades out.
    cb.put('/api/chat/settings', json={'share_online': True, 'share_listening': True})
    later = time.time() + presence_model.ONLINE_SECONDS + 60
    monkeypatch.setattr(presence_model, '_now', lambda: later)
    assert ca.get('/api/chat/presence').get_json()['presence'][0]['online'] is False


def test_settings_reject_non_booleans(client_as, world):
    c = client_as(world['a'])
    assert c.put('/api/chat/settings', json={'share_online': 'no'}).status_code == 400
    assert c.get('/api/chat/settings').get_json() == {
        'share_online': True, 'share_listening': True}


def test_typing_shows_only_to_the_person_written_to(world, pair, client_as):
    ca, cb = pair
    PresenceModel.touch(world['a'])
    ca.post(f"/api/chat/{world['b']}/typing")
    assert cb.get('/api/chat/presence').get_json()['presence'][0]['typing'] is True
    assert PresenceModel.snapshot(world['c'], [world['a']])[world['a']]['typing'] is False


# ── Stream ──

@pytest.fixture
def fast_stream(monkeypatch):
    monkeypatch.setattr(chat_routes, 'STREAM_POLL_SECONDS', 0.01)
    monkeypatch.setattr(chat_routes, 'STREAM_PRESENCE_SECONDS', 0.01)


def _open(user_id, after=0):
    waiter = chat_routes.stream_hub.open(user_id)
    return chat_routes.chat_stream(user_id, after, waiter), waiter


def _next_event(stream, name, tries=50):
    for _ in range(tries):
        for event in _events(next(stream)):
            if event[0] == name:
                return event
    raise AssertionError(f'no {name} event')


def test_the_stream_delivers_messages_to_both_sides_and_marks_presence(
        world, pair, fast_stream):
    ca, cb = pair
    stream, _ = _open(world['b'], after=ChatModel.latest_id(world['b']))
    try:
        assert _events(next(stream)) == [('open', {}, None)]
        full = _next_event(stream, 'presence')[1]
        assert full['full'] is True and full['users'][0]['user_id'] == world['a']

        sent = _say(ca, world['b'], 'live').get_json()['message']
        event = _next_event(stream, 'message')
        assert event[1]['body'] == 'live' and event[2] == str(sent['id'])

        # The receiver's own device sees what they send too.
        mine = _say(cb, world['a'], 'back').get_json()['message']
        assert _next_event(stream, 'message')[1]['id'] == mine['id']

        # Online appears to the friend because the stream touched presence.
        assert ca.get('/api/chat/presence').get_json()['presence'][0]['online'] is True

        ca.post(f"/api/chat/{world['b']}/read")
        read = _next_event(stream, 'read')[1]
        assert read['reader_id'] == world['a']
    finally:
        stream.close()


def test_the_stream_resumes_after_a_message_id(world, pair, fast_stream):
    ca, _ = pair
    first = _say(ca, world['b'], 'one').get_json()['message']['id']
    second = _say(ca, world['b'], 'two').get_json()['message']['id']
    stream, _ = _open(world['b'], after=first)
    try:
        next(stream)
        assert _next_event(stream, 'message')[1]['id'] == second
    finally:
        stream.close()


def test_a_user_holds_a_limited_number_of_streams(world, client_as):
    waiters = [chat_routes.stream_hub.open(world['a'])
               for _ in range(chat_routes.STREAM_MAX_PER_USER)]
    try:
        assert chat_routes.stream_hub.open(world['a']) is None
        assert client_as(world['a']).get('/api/chat/stream').status_code == 429
    finally:
        for waiter in waiters:
            chat_routes.stream_hub.close(world['a'], waiter)
    again = chat_routes.stream_hub.open(world['a'])
    assert again is not None
    chat_routes.stream_hub.close(world['a'], again)
