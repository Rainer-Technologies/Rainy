"""Light show API routes with the DB layer stubbed out (no MySQL needed)."""
import pytest

import app as app_module
from models.lightshow_job import LightshowJobModel
from routes import music
from utils import lightshow_worker
from utils.lightshow_analyzer import ANALYZER_VERSION


@pytest.fixture(autouse=True)
def no_workers(monkeypatch):
    # Keep the before_request hooks from spinning up real background workers.
    for flag in ('_import_worker_started', '_enrichment_worker_started',
                 '_sync_worker_started', '_lightshow_worker_started', '_lyrics_worker_started'):
        monkeypatch.setattr(app_module, flag, True)


@pytest.fixture
def store(monkeypatch):
    state = {'scores': {}, 'jobs': {}, 'enqueued': []}

    monkeypatch.setattr(music.SongModel, 'get_song_by_id',
                        staticmethod(lambda sid: {'id': sid} if sid < 900 else None))
    monkeypatch.setattr(LightshowJobModel, 'get_score', staticmethod(lambda sid: state['scores'].get(sid)))
    monkeypatch.setattr(LightshowJobModel, 'song_job_state', staticmethod(lambda sid: state['jobs'].get(sid)))

    def enqueue(sid, force=False):
        state['enqueued'].append((sid, force))
        state['jobs'][sid] = {'id': len(state['enqueued']), 'song_id': sid, 'scope': 'song',
                              'status': 'queued', 'force_full': int(force)}
        return state['jobs'][sid]['id']

    monkeypatch.setattr(LightshowJobModel, 'enqueue_song', staticmethod(enqueue))
    monkeypatch.setattr(LightshowJobModel, 'get', staticmethod(
        lambda jid: next(j for j in state['jobs'].values() if j['id'] == jid)))
    monkeypatch.setattr(lightshow_worker, 'enqueue_song', lambda sid, force=False: enqueue(sid, force))
    monkeypatch.setattr(lightshow_worker, 'notify', lambda: None)
    return state


def test_get_returns_current_score(client, store):
    store['scores'][5] = (ANALYZER_VERSION, {'v': ANALYZER_VERSION, 'tempo': 128})
    res = client.get('/api/music/song/5/lightshow')
    assert res.status_code == 200
    body = res.get_json()
    assert body['success'] and body['lightshow']['tempo'] == 128
    assert store['enqueued'] == []


def test_get_without_score_queues_analysis(client, store):
    res = client.get('/api/music/song/7/lightshow')
    body = res.get_json()
    assert res.status_code == 200
    assert body['success'] is False and body['pending'] is True
    assert store['enqueued'] == [(7, False)]


def test_get_outdated_v1_score_is_reanalysed(client, store):
    store['scores'][8] = (1, {'v': 1, 'bpm': 120})
    body = client.get('/api/music/song/8/lightshow').get_json()
    assert body['pending'] is True
    assert store['enqueued'] == [(8, False)]


def test_get_does_not_loop_on_failed_analysis(client, store):
    store['jobs'][9] = {'id': 1, 'song_id': 9, 'scope': 'song', 'status': 'failed',
                        'force_full': 0, 'error_message': 'bad file'}
    body = client.get('/api/music/song/9/lightshow').get_json()
    assert body['pending'] is False
    assert body['job']['error'] == 'bad file'
    assert store['enqueued'] == []


def test_get_unknown_song_404(client, store):
    assert client.get('/api/music/song/950/lightshow').status_code == 404


def test_analyze_forces_a_job(client, store):
    res = client.post('/api/music/song/3/lightshow/analyze')
    assert res.status_code == 200
    assert res.get_json()['job']['force'] is True
    assert store['enqueued'] == [(3, True)]


def test_status_summarises_without_envelopes(client, store):
    store['scores'][4] = (ANALYZER_VERSION, {
        'v': ANALYZER_VERSION, 'duration': 200, 'tempo': 100, 'profile': {'genre': 'rock'},
        'sections': [{'t0': 0, 't1': 200, 'label': 'verse'}], 'events': [], 'env': {'rms': 'AAAA'},
    })
    body = client.get('/api/music/song/4/lightshow/status').get_json()
    assert body['show']['current'] is True
    assert body['show']['profile']['genre'] == 'rock'
    assert 'env' not in body['show']


def test_routes_require_auth(anon_client, store):
    assert anon_client.get('/api/music/song/5/lightshow').status_code == 401
    assert anon_client.post('/api/music/lightshow/backfill').status_code == 401
