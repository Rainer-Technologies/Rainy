"""Lyrics analysis API routes with the DB layer stubbed out (no MySQL needed)."""
import datetime

import pytest

import app as app_module
from models.lyrics_job import LyricsJobModel
from models.library_access import LibraryAccessModel
from routes import music
from utils import lyrics_worker
from utils.lyrics_align import ALIGN_VERSION


@pytest.fixture(autouse=True)
def no_workers(monkeypatch):
    for flag in ('_import_worker_started', '_enrichment_worker_started', '_sync_worker_started',
                 '_lightshow_worker_started', '_lyrics_worker_started'):
        monkeypatch.setattr(app_module, flag, True)


@pytest.fixture
def store(monkeypatch):
    state = {'words': {}, 'lyrics': {}, 'jobs': {}, 'enqueued': []}

    monkeypatch.setattr(music.SongModel, 'get_song_by_id',
                        staticmethod(lambda sid: {'id': sid} if sid < 900 else None))
    monkeypatch.setattr(LibraryAccessModel, 'has_access',
                        staticmethod(lambda uid, sid: sid < 900))
    monkeypatch.setattr(LyricsJobModel, 'get_words', staticmethod(lambda sid: state['words'].get(sid)))
    monkeypatch.setattr(LyricsJobModel, 'get_lyrics', staticmethod(lambda sid: state['lyrics'].get(sid)))
    monkeypatch.setattr(LyricsJobModel, 'song_job_state', staticmethod(lambda sid: state['jobs'].get(sid)))

    def enqueue(sid, force=False):
        state['enqueued'].append((sid, force))
        state['jobs'][sid] = {'id': len(state['enqueued']), 'song_id': sid, 'scope': 'song',
                              'status': 'queued', 'force_full': int(force)}
        return state['jobs'][sid]['id']

    monkeypatch.setattr(LyricsJobModel, 'enqueue_song', staticmethod(enqueue))
    monkeypatch.setattr(LyricsJobModel, 'get', staticmethod(
        lambda jid: next(j for j in state['jobs'].values() if j['id'] == jid)))
    monkeypatch.setattr(lyrics_worker, 'enqueue_song', lambda sid, force=False: enqueue(sid, force))
    monkeypatch.setattr(lyrics_worker, 'notify', lambda: None)
    return state


def _synced_row(updated_at=None):
    return {'found': 1, 'synced': '[{"time": 1, "text": "hi"}]', 'plain': None,
            'updated_at': updated_at or datetime.datetime(2026, 1, 1)}


def test_returns_current_timings(client, store):
    store['words'][5] = (ALIGN_VERSION, [[[1.0, 1.4]]], 'en')
    body = client.get('/api/music/song/5/lyrics-words').get_json()
    assert body['success'] and body['words'] == [[[1.0, 1.4]]] and body['language'] == 'en'
    assert store['enqueued'] == []


def test_missing_timings_queue_an_analysis(client, store):
    store['lyrics'][7] = _synced_row()
    body = client.get('/api/music/song/7/lyrics-words').get_json()
    assert body['success'] is False and body['pending'] is True
    assert store['enqueued'] == [(7, False)]


def test_outdated_timings_are_treated_as_missing(client, store):
    store['words'][8] = (1, [[[0.0, 5.0]]], None)          # written by the old aligner
    store['lyrics'][8] = _synced_row()
    body = client.get('/api/music/song/8/lyrics-words').get_json()
    assert 'words' not in body and body['pending'] is True
    assert store['enqueued'] == [(8, False)]


def test_songs_without_synced_lyrics_are_not_queued(client, store):
    store['lyrics'][9] = {'found': 1, 'synced': None, 'plain': 'x', 'updated_at': None}
    res = client.get('/api/music/song/9/lyrics-words')
    assert res.status_code == 404
    assert client.get('/api/music/song/10/lyrics-words').status_code == 404   # never looked up
    assert store['enqueued'] == []


def test_does_not_loop_on_a_failed_analysis(client, store):
    store['lyrics'][11] = _synced_row(datetime.datetime(2026, 1, 1))
    store['jobs'][11] = {'id': 1, 'song_id': 11, 'scope': 'song', 'status': 'failed', 'force_full': 0,
                         'error_message': 'no vocals', 'completed_at': datetime.datetime(2026, 2, 1)}
    body = client.get('/api/music/song/11/lyrics-words').get_json()
    assert body['pending'] is False and body['job']['error'] == 'no vocals'
    assert store['enqueued'] == []


def test_retries_a_failed_analysis_once_the_lyrics_changed(client, store):
    store['lyrics'][12] = _synced_row(datetime.datetime(2026, 3, 1))      # replaced after the failure
    store['jobs'][12] = {'id': 1, 'song_id': 12, 'scope': 'song', 'status': 'failed', 'force_full': 0,
                         'completed_at': datetime.datetime(2026, 2, 1)}
    assert client.get('/api/music/song/12/lyrics-words').get_json()['pending'] is True
    assert store['enqueued'] == [(12, False)]


def test_unknown_song_404(client, store):
    assert client.get('/api/music/song/950/lyrics-words').status_code == 404


def test_analyze_forces_a_job(client, store):
    res = client.post('/api/music/song/3/lyrics-words/analyze')
    assert res.status_code == 200 and res.get_json()['job']['force'] is True
    assert store['enqueued'] == [(3, True)]


def test_backfill_and_jobs_listing(client, store, monkeypatch):
    seen = {}
    monkeypatch.setattr(music, '_lightshow_scope_ids', lambda: [1, 2])

    def enqueue_backfill(force=False, song_ids=None):
        seen.update(force=force, ids=song_ids)
        return 1

    monkeypatch.setattr(LyricsJobModel, 'enqueue_backfill', staticmethod(enqueue_backfill))
    monkeypatch.setattr(LyricsJobModel, 'get', staticmethod(
        lambda jid: {'id': jid, 'scope': 'backfill', 'status': 'queued', 'force_full': 1}))
    body = client.post('/api/music/lyrics/backfill', json={'force': True}).get_json()
    assert body['success'] and body['job']['scope'] == 'backfill'
    assert seen == {'force': True, 'ids': [1, 2]}

    monkeypatch.setattr(LyricsJobModel, 'coverage', staticmethod(
        lambda ids=None: {'ready': 3, 'total': 5, 'unfetched': 2}))
    monkeypatch.setattr(LyricsJobModel, 'active_jobs', staticmethod(lambda: []))
    monkeypatch.setattr(LyricsJobModel, 'list_recent', staticmethod(lambda: []))
    body = client.get('/api/music/lyrics/jobs').get_json()
    assert body['coverage'] == {'ready': 3, 'total': 5, 'unfetched': 2}
    assert body['queue'] == [] and body['history'] == []


def test_routes_require_auth(anon_client, store):
    assert anon_client.get('/api/music/song/5/lyrics-words').status_code == 401
    assert anon_client.post('/api/music/lyrics/backfill').status_code == 401
    assert anon_client.get('/api/music/lyrics/jobs').status_code == 401


def _apply_lyrics(monkeypatch, client, record):
    class Resp:
        status_code = 200

        def json(self):
            return record

    monkeypatch.setattr('requests.get', lambda *a, **k: Resp())
    import models.database as db_module
    real = db_module.Database.execute_query

    def execute(query, *args, **kwargs):
        if 'song_lyrics' in query:  # only stub the lyrics writes; auth still needs the real DB
            return None
        return real(query, *args, **kwargs)

    monkeypatch.setattr(db_module.Database, 'execute_query', staticmethod(execute))
    return client.post('/api/music/song/5/lyrics', json={'lrclib_id': 1})


def test_applying_synced_lyrics_queues_a_word_sync(client, store, monkeypatch):
    res = _apply_lyrics(monkeypatch, client, {'syncedLyrics': '[00:01.00] hi', 'plainLyrics': 'hi'})
    assert res.status_code == 200
    assert store['enqueued'] == [(5, False)]


def test_applying_plain_lyrics_does_not_queue_a_word_sync(client, store, monkeypatch):
    res = _apply_lyrics(monkeypatch, client, {'plainLyrics': 'hi'})
    assert res.status_code == 200
    assert store['enqueued'] == []
