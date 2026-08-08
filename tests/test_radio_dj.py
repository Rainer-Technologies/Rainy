"""Tests for the AI radio + DJ features.

Requires the LLM API key in .env (AI_API_KEY) — radio/dj tests are skipped
when the AI isn't configured, but the session/stop plumbing is always tested.
"""
import pytest

from utils import ai_client


@pytest.fixture
def auth_client(client):
    """Client with an authenticated session (user 1)."""
    with client.session_transaction() as sess:
        sess['user_id'] = 1
    return client


def test_radio_start_validates_song(auth_client):
    # Empty body is now valid TASTE mode (seed from play history). If the
    # test user has no history it 404s; either way it must NOT 400 anymore.
    r = auth_client.post('/api/radio/start', json={})
    assert r.status_code in (200, 404)


def test_radio_start_missing_song(auth_client):
    r = auth_client.post('/api/radio/start', json={'song_id': 999999})
    assert r.status_code == 404


def test_radio_next_unknown_session(auth_client):
    r = auth_client.post('/api/radio/next', json={'session_id': 'nope'})
    assert r.status_code == 404


def test_radio_stop_unknown_session(auth_client):
    r = auth_client.post('/api/radio/stop', json={'session_id': 'nope'})
    assert r.status_code == 200
    assert r.get_json().get('success') is True


@pytest.mark.skipif(not ai_client.is_configured(), reason='AI not configured')
def test_radio_start_returns_songs(auth_client):
    """Async flow: start returns fast, poll status, then collect a batch."""
    import time

    r = auth_client.post('/api/radio/start', json={'song_id': 89})
    assert r.status_code == 200
    data = r.get_json()
    assert data.get('session_id')
    assert data.get('seed', {}).get('id') == 89
    assert data.get('status') in ('generating', 'ready')

    sid = data['session_id']
    # Poll status until the first batch is ready (background generation).
    status = 'generating'
    deadline = time.time() + 240
    while time.time() < deadline and status == 'generating':
        st = auth_client.get(f'/api/radio/status?session_id={sid}').get_json()
        status = st.get('status')
        time.sleep(5)
    assert status in ('ready', 'error'), f'unexpected status: {status}'

    r2 = auth_client.post('/api/radio/next', json={'session_id': sid})
    assert r2.status_code == 200
    songs = r2.get_json().get('songs') or []
    assert isinstance(songs, list)
    # Every served song must NOT be flagged as in-library
    for s in songs:
        assert s.get('in_library') is False
        assert s.get('videoId')


@pytest.mark.skipif(not ai_client.is_configured(), reason='AI not configured')
def test_radio_batches_do_not_overlap(auth_client):
    """Two consecutive batches (via the async flow) share zero videoIds."""
    import time

    r = auth_client.post('/api/radio/start', json={'song_id': 89})
    sid = r.get_json()['session_id']

    def _collect():
        status = 'generating'
        deadline = time.time() + 240
        while time.time() < deadline and status == 'generating':
            st = auth_client.get(f'/api/radio/status?session_id={sid}').get_json()
            status = st.get('status')
            time.sleep(5)
        r2 = auth_client.post('/api/radio/next', json={'session_id': sid})
        return {s['videoId'] for s in (r2.get_json().get('songs') or [])}

    b1 = _collect()
    # Serving batch 1 auto-kicks batch 2's generation; collect it.
    b2 = _collect()
    assert len(b1) > 0
    assert len(b1.intersection(b2)) == 0


def test_dj_requires_auth(anon_client):
    r = anon_client.post('/api/dj/line', json={})
    assert r.status_code == 401


def test_dj_cached_empty(auth_client):
    r = auth_client.post('/api/dj/cached', json={'song': {'title': 'X', 'artist': 'Y'}})
    assert r.status_code == 200
    assert r.get_json().get('line') is None


def test_dj_audio_unknown_file(auth_client):
    r = auth_client.get('/api/dj/audio/../../etc/passwd')
    assert r.status_code == 404
