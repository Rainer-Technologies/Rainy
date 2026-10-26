"""Song radio: transient songs, the /api/radio endpoints, keeping and cleanup.

YouTube Music and the download worker are stubbed; the database and the
music folder are the real (scratch) ones.
"""
import json
import os
import random
import subprocess
import sys

import pytest

import app as app_module
from conftest import sign_in
from config import Config
from models.database import Database
from models.library_access import LibraryAccessModel
from models.playlist import PlaylistModel
from models.radio import RadioAccessModel, RadioTrackModel
from models.settings import SettingsModel
from models.song import SongModel
from models.user import UserModel
from utils import radio_worker, ytradio
from utils.scanner import MusicScanner

ATV = 'MUSIC_VIDEO_TYPE_ATV'


@pytest.fixture(autouse=True)
def no_workers(monkeypatch):
    for flag in ('_import_worker_started', '_enrichment_worker_started', '_sync_worker_started',
                 '_lightshow_worker_started', '_lyrics_worker_started', '_ytdlp_worker_started',
                 '_radio_worker_started'):
        monkeypatch.setattr(app_module, flag, True)
    monkeypatch.setattr(radio_worker, 'notify', lambda: None)


def _track(vid, title, artist, duration=200, kind=ATV):
    return {'videoId': vid, 'title': title, 'artist': artist, 'album': 'Album',
            'duration': duration, 'cover_url': None, 'type': kind}


@pytest.fixture
def radio(app):
    """A user with two library songs, plus helpers that clean up after."""
    music_path = SettingsModel.get_music_path()
    songs, users, files, playlists = [], [], [], []

    def user(name, role='user'):
        email = f'{name}@test.local'
        if not UserModel.get_user_by_email(email):
            UserModel.create_user(name, email, 'secret123', role=role)
        users.append(UserModel.get_user_by_email(email)['id'])
        return users[-1]

    def song(path, title, artist, owner=None, **cols):
        Database.execute_query(
            "INSERT INTO songs (file_path, title, artist, duration) VALUES (%s, %s, %s, 200)",
            (path, title, artist))
        sid = Database.execute_query(
            "SELECT id FROM songs WHERE file_path = %s", (path,), fetch_one=True)['id']
        for col, value in cols.items():
            Database.execute_query(f"UPDATE songs SET {col} = %s WHERE id = %s", (value, sid))
        if owner:
            LibraryAccessModel.grant(owner, sid, origin='import')
        songs.append(sid)
        return sid

    def transient(video_id, title='Radio Song', artist='Radio Artist', for_user=None):
        """A downloaded radio track: file in the radio folder + transient row."""
        rel = f'{Config.RADIO_DIR}/{video_id}.m4a'
        full = os.path.join(music_path, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'wb') as f:
            f.write(b'\x00' * 2048)
        files.append(full)
        sid = song(rel, title, artist, transient=1, youtube_id=video_id)
        RadioTrackModel.request([_track(video_id, title, artist)])
        RadioTrackModel.mark_ready(video_id, sid)
        if for_user:
            RadioAccessModel.grant(for_user, sid)
        return sid

    def client(user_id):
        c = app.test_client()
        sign_in(c, user_id)
        return c

    def playlist(owner, name='Radio Test'):
        playlists.append(PlaylistModel.create_playlist(name, 'music-note', '#3d7dc4', owner))
        return playlists[-1]

    alice = user('radio_alice')
    seed = song('/radio/seed.mp3', 'Seed Song', 'Seed Artist', owner=alice,
                youtube_id='seedvideo01')
    owned = song('/radio/owned.mp3', 'Owned Song', 'Owned Artist', owner=alice)

    yield {'alice': alice, 'seed': seed, 'owned': owned, 'user': user, 'song': song,
           'track_song': songs.append,
           'transient': transient, 'client': client, 'playlist': playlist,
           'music_path': music_path}

    for pid in playlists:
        Database.execute_query("DELETE FROM playlists WHERE id = %s", (pid,))
    for sid in songs:
        row = Database.execute_query(
            "SELECT file_path FROM songs WHERE id = %s", (sid,), fetch_one=True)
        if row:
            files.append(os.path.join(music_path, row['file_path'].lstrip('/')))
        for table in ('enrichment_jobs', 'lightshow_jobs', 'lyrics_jobs'):
            Database.execute_query(f"DELETE FROM {table} WHERE song_id = %s", (sid,))
        Database.execute_query("DELETE FROM songs WHERE id = %s", (sid,))
    Database.execute_query("DELETE FROM radio_tracks")
    Database.execute_query("DELETE FROM yt_radio_cache")
    for uid in users:
        UserModel.delete_user(uid)
    for full in files:
        if os.path.isfile(full) and full.startswith(music_path):
            os.remove(full)


@pytest.fixture
def fake_youtube(monkeypatch, radio):
    """A fixed YouTube Music radio for the seed."""
    pool = [
        _track('newvideo001', 'Brand New One', 'New Artist A'),
        _track('ownedvideo1', 'Owned Song', 'Owned Artist'),     # the listener owns this one
        _track('livevideo01', 'Something (Live)', 'New Artist B'),
        _track('newvideo002', 'Brand New Two', 'New Artist C'),
        _track('newvideo003', 'Brand New Three', 'New Artist D'),
    ]
    monkeypatch.setattr(ytradio, 'fetch_radio', lambda video_id, deep=False, refresh=False: pool)
    monkeypatch.setattr(ytradio, '_local_similar', lambda user_id, seed_id, visible: [radio['owned']])
    monkeypatch.setattr(ytradio, '_cooc_cache', {})
    return pool


# ── Transient songs stay out of every library ───────────────────────────

def test_transient_song_is_playable_but_not_in_the_library(radio):
    alice = radio['alice']
    sid = radio['transient']('tmpvideo001', for_user=alice)

    assert not LibraryAccessModel.has_access(alice, sid)
    assert LibraryAccessModel.can_play(alice, sid)
    assert sid not in LibraryAccessModel.visible_song_ids(alice)
    assert sid not in {s['id'] for s in SongModel.get_all_songs(alice)}

    stranger = radio['user']('radio_stranger')
    assert not LibraryAccessModel.can_play(stranger, sid)


def test_full_library_users_do_not_see_transient_songs(radio):
    boss = radio['user']('radio_boss')
    Database.execute_query("UPDATE users SET full_library = 1 WHERE id = %s", (boss,))
    sid = radio['transient']('tmpvideo002')

    assert LibraryAccessModel.has_access(boss, radio['seed'])      # sees everyone's songs…
    assert not LibraryAccessModel.has_access(boss, sid)            # …but not radio downloads
    assert sid not in LibraryAccessModel.visible_song_ids(boss)
    assert sid not in {s['id'] for s in SongModel.get_all_songs(boss)}


def test_stream_follows_radio_access(radio):
    alice = radio['alice']
    sid = radio['transient']('tmpvideo003', for_user=alice)
    stranger = radio['user']('radio_stranger2')

    assert radio['client'](alice).get(f'/api/music/stream/{sid}').status_code in (200, 206)
    assert radio['client'](stranger).get(f'/api/music/stream/{sid}').status_code == 404


# ── /api/radio ──────────────────────────────────────────────────────────

def test_start_requires_login(anon_client):
    assert anon_client.post('/api/radio/start', json={'song_id': 1}).status_code == 401


def test_start_rejects_a_seed_the_user_cannot_play(radio, fake_youtube):
    stranger = radio['user']('radio_stranger3')
    res = radio['client'](stranger).post('/api/radio/start', json={'song_id': radio['seed']})
    assert res.status_code == 200 and res.get_json()['queue'] == []


def test_radio_follows_youtube_music_and_plays_owned_songs_from_the_library(radio, fake_youtube):
    res = radio['client'](radio['alice']).post('/api/radio/start', json={'song_id': radio['seed']})
    queue = res.get_json()['queue']
    # Radio order kept; the live take of something the listener doesn't own is dropped.
    assert [t.get('videoId') or t['id'] for t in queue] == [
        'newvideo001', radio['owned'], 'newvideo002', 'newvideo003']
    owned = queue[1]
    assert owned['in_library'] is True and 'videoId' not in owned
    assert all(t['radio'] and 'id' not in t for t in queue if t.get('videoId'))


def test_restarting_radio_refreshes_youtube_and_varies_results(radio, monkeypatch):
    pool = [_track(f'v{i:010d}', f'Song {i}', f'Artist {i}') for i in range(40)]
    calls = []
    def youtube(video_id, limit):
        calls.append((video_id, limit))
        return pool
    monkeypatch.setattr(ytradio, '_yt_radio', youtube)
    monkeypatch.setattr(ytradio, 'cooccurrence', lambda *args: ({}, {}))
    client = radio['client'](radio['alice'])
    monkeypatch.setattr(ytradio.random, 'uniform', random.Random(1).uniform)
    first = client.post('/api/radio/start', json={'song_id': radio['seed']})
    monkeypatch.setattr(ytradio.random, 'uniform', random.Random(2).uniform)
    second = client.post('/api/radio/start', json={'song_id': radio['seed']})
    assert first.status_code == second.status_code == 200
    first_ids = {t['videoId'] for t in first.get_json()['queue']}
    second_ids = {t['videoId'] for t in second.get_json()['queue']}
    assert len(first_ids) == len(second_ids) == 12
    assert first_ids != second_ids
    assert calls == [('seedvideo01', ytradio.SHALLOW_LIMIT)] * 2


def test_start_does_not_clobber_deep_cache_written_by_another_process(radio, monkeypatch):
    from models.radio import RadioCacheModel
    if not Database.is_sqlite():
        pytest.skip('Cross-process cache test requires an isolated SQLite database')
    deep = {'deep': True, 'tracks': [_track('deepvideo01', 'Deep', 'Artist')]}
    fresh = [_track('newvideo001', 'New', 'Artist')]

    def youtube(video_id, limit):
        subprocess.run(
            [sys.executable, '-c',
             'import json,sys; from models.radio import RadioCacheModel; '
             'RadioCacheModel.put(sys.argv[1], json.loads(sys.argv[2]))',
             video_id, json.dumps(deep)], check=True)
        return fresh

    monkeypatch.setattr(ytradio, '_yt_radio', youtube)
    monkeypatch.setattr(ytradio, 'cooccurrence', lambda *args: ({}, {}))
    res = radio['client'](radio['alice']).post('/api/radio/start', json={'song_id': radio['seed']})
    assert [t['videoId'] for t in res.get_json()['queue']] == ['newvideo001']
    assert RadioCacheModel.get('seedvideo01') == deep


@pytest.mark.parametrize('cache_deep', [False, True])
@pytest.mark.parametrize('outcome', ['filtered', 'empty', 'offline'])
def test_start_uses_eligible_cached_radio_when_fresh_page_cannot_supply_candidates(
        radio, monkeypatch, cache_deep, outcome):
    from models.radio import RadioCacheModel
    from models.song_rating import SongRatingModel

    alice = radio['alice']
    SongRatingModel.set_rating(alice, radio['owned'], 'dislike')
    downloaded = radio['transient']('queuedvid01', 'Downloaded', 'Downloaded Artist')
    cached = {'deep': cache_deep, 'tracks': [
        _track('dislike0001', 'Owned Song', 'Owned Artist'),
        _track('excluded001', 'Excluded', 'Excluded Artist'),
        _track('queuedvid01', 'Downloaded', 'Downloaded Artist'),
        _track('skipped0001', 'Skipped Artist Song', 'Skipped Artist'),
        _track('ranked00001', 'Ranked Song', 'Ranked Artist'),
    ]}
    RadioCacheModel.put('seedvideo01', cached)
    visible_before = set(LibraryAccessModel.visible_song_ids(alice))

    def youtube(video_id, limit):
        if outcome == 'offline':
            raise RuntimeError('offline')
        if outcome == 'empty':
            return []
        return [_track('badvideo001', 'Too short', 'Artist', duration=20)]

    monkeypatch.setattr(ytradio, '_yt_radio', youtube)
    monkeypatch.setattr(ytradio, 'cooccurrence', lambda *args: ({'ranked00001': 5}, {}))
    monkeypatch.setattr(ytradio, '_local_similar', lambda *args: pytest.fail('Cached radio is eligible'))
    response = radio['client'](alice).post('/api/radio/start', json={
        'song_id': radio['seed'], 'exclude_video_ids': ['excluded001'],
        'exclude_song_ids': [downloaded], 'skipped_artists': ['Skipped Artist'],
    })
    assert response.status_code == 200
    assert [t['videoId'] for t in response.get_json()['queue']] == ['ranked00001', 'skipped0001']
    assert RadioCacheModel.get('seedvideo01') == cached
    assert set(LibraryAccessModel.visible_song_ids(alice)) == visible_before


def test_start_falls_back_to_local_when_both_fresh_and_cached_are_ineligible(radio, monkeypatch):
    from models.radio import RadioCacheModel
    cached = {'deep': True, 'tracks': [_track('cachedbad01', 'Bad (Live)', 'Artist')]}
    RadioCacheModel.put('seedvideo01', cached)
    monkeypatch.setattr(ytradio, '_yt_radio', lambda *args: [_track('freshbad001', 'Short', 'Artist', 20)])
    monkeypatch.setattr(ytradio, 'cooccurrence', lambda *args: ({}, {}))
    monkeypatch.setattr(ytradio, '_local_similar', lambda *args: [radio['owned']])
    response = radio['client'](radio['alice']).post('/api/radio/start', json={'song_id': radio['seed']})
    assert [t['id'] for t in response.get_json()['queue']] == [radio['owned']]
    assert RadioCacheModel.get('seedvideo01') == cached


def test_unicode_seed_with_cached_miss_uses_youtube_music_after_upgrade(radio, monkeypatch):
    seed_id = radio['seed']
    Database.execute_query(
        "UPDATE songs SET title = %s, artist = %s, duration = 114, youtube_id = NULL, "
        "youtube_matched_at = NOW(), youtube_match_version = 0 WHERE id = %s",
        ('きみが死ぬまで恋をしたい', 'Yukari Hashimoto', seed_id))
    result = {'videoId': 'fhwrwHwzZmg',
              'title': 'きみが死ぬまで恋をしたい - Kimiga Shinumade Koiwoshitai',
              'artists': ['Yukari Hashimoto'], 'duration': 115}
    monkeypatch.setattr(ytradio, '_yt_search', lambda query, kind: [result])
    fetched = []

    def fetch(video_id, deep=False, refresh=False):
        fetched.append(video_id)
        return [_track('ColX1C6hJ2Y', 'キスの魔力', 'Yukari Hashimoto')]

    monkeypatch.setattr(ytradio, 'fetch_radio', fetch)
    monkeypatch.setattr(ytradio, 'cooccurrence', lambda *args: ({}, {}))
    monkeypatch.setattr(ytradio, '_local_similar',
                        lambda *args: pytest.fail('Must not fall back to local songs'))
    res = radio['client'](radio['alice']).post('/api/radio/start', json={'song_id': seed_id})
    assert res.status_code == 200
    assert [t['videoId'] for t in res.get_json()['queue']] == ['ColX1C6hJ2Y']
    assert fetched == ['fhwrwHwzZmg']
    stored = Database.execute_query(
        "SELECT youtube_id, youtube_match_version FROM songs WHERE id = %s",
        (seed_id,), fetch_one=True)
    assert stored == {'youtube_id': 'fhwrwHwzZmg', 'youtube_match_version': ytradio.MATCH_VERSION}


def test_worker_retries_legacy_misses_only_once(radio, monkeypatch):
    # Both fixture songs carry an old miss. Once retried with this matcher,
    # they must stop being selected even if YouTube still finds no match.
    for sid in (radio['seed'], radio['owned']):
        Database.execute_query(
            "UPDATE songs SET youtube_id = NULL, youtube_matched_at = NOW(), "
            "youtube_match_version = 0 WHERE id = %s", (sid,))
    searched = []
    monkeypatch.setattr(ytradio, 'match_song', lambda song: searched.append(song['id']))
    assert radio_worker._learn_one() is True
    assert radio_worker._learn_one() is True
    assert radio_worker._learn_one() is False
    assert sorted(searched) == sorted([radio['seed'], radio['owned']])


def test_more_excludes_what_is_already_queued(radio, fake_youtube):
    res = radio['client'](radio['alice']).post('/api/radio/more', json={
        'song_id': radio['seed'],
        'exclude_video_ids': ['newvideo001', 'not a video id'],
        'exclude_song_ids': [radio['owned']]})
    assert [t['videoId'] for t in res.get_json()['queue']] == ['newvideo002', 'newvideo003']


def test_disliked_songs_never_come_back(radio, fake_youtube):
    from models.song_rating import SongRatingModel
    SongRatingModel.set_rating(radio['alice'], radio['owned'], 'dislike')
    res = radio['client'](radio['alice']).post('/api/radio/start', json={'song_id': radio['seed']})
    assert [t.get('videoId') for t in res.get_json()['queue']] == [
        'newvideo001', 'newvideo002', 'newvideo003']


def test_radio_falls_back_to_similar_library_songs_when_youtube_music_fails(
        radio, fake_youtube, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError('YouTube Music is down')
    monkeypatch.setattr(ytradio, 'fetch_radio', boom)
    res = radio['client'](radio['alice']).post('/api/radio/start', json={'song_id': radio['seed']})
    assert [t['id'] for t in res.get_json()['queue']] == [radio['owned']]


def test_an_already_downloaded_track_comes_back_as_a_song(radio, fake_youtube):
    alice = radio['alice']
    sid = radio['transient']('newvideo002', 'Brand New Two', 'New Artist C')
    res = radio['client'](alice).post('/api/radio/start', json={'song_id': radio['seed']})
    queue = res.get_json()['queue']
    ready = next(t for t in queue if t.get('id') == sid)
    assert ready['in_library'] is False and 'videoId' not in ready
    assert LibraryAccessModel.can_play(alice, sid)


def test_a_downloaded_track_already_queued_is_not_offered_again(radio, fake_youtube):
    # The client knows a downloaded track by its song id only.
    alice = radio['alice']
    sid = radio['transient']('newvideo002', 'Brand New Two', 'New Artist C')
    res = radio['client'](alice).post('/api/radio/more', json={
        'song_id': radio['seed'], 'exclude_song_ids': [sid, radio['owned']],
        'exclude_video_ids': ['newvideo001']})
    assert [t.get('videoId') or t['id'] for t in res.get_json()['queue']] == ['newvideo003']


def test_prefetch_queues_then_hands_over_the_song(radio):
    alice = radio['alice']
    c = radio['client'](alice)
    track = _track('prefetch001', 'Pending Song', 'Pending Artist')

    states = c.post('/api/radio/prefetch', json={'tracks': [track, {'videoId': '../etc'}]}
                    ).get_json()['tracks']
    assert states == {'prefetch001': {'status': 'queued'}}
    assert RadioTrackModel.get_many(['prefetch001'])['prefetch001']['status'] == 'queued'

    sid = radio['transient']('prefetch001', 'Pending Song', 'Pending Artist')
    state = c.post('/api/radio/prefetch', json={'tracks': [track]}).get_json()['tracks']['prefetch001']
    assert state['status'] == 'ready'
    assert state['song']['id'] == sid and state['song']['in_library'] is False
    assert LibraryAccessModel.can_play(alice, sid)


def test_prefetch_refetches_a_track_whose_song_was_cleaned_up(radio):
    alice = radio['alice']
    sid = radio['transient']('gonevideo01', for_user=alice)
    Database.execute_query("DELETE FROM songs WHERE id = %s", (sid,))
    states = radio['client'](alice).post(
        '/api/radio/prefetch', json={'tracks': [_track('gonevideo01', 'x', 'y')]}).get_json()['tracks']
    assert states['gonevideo01']['status'] == 'queued'


def test_failed_downloads_stop_being_retried(radio):
    track = _track('failvideo01', 'Broken', 'Nobody')
    for _ in range(5):
        RadioTrackModel.request([track])
        claimed = RadioTrackModel.claim_next()
        if not claimed:
            break
        RadioTrackModel.fail(claimed['video_id'], 'HTTP Error 403')
    row = RadioTrackModel.get_many(['failvideo01'])['failvideo01']
    assert row['status'] == 'failed' and row['attempts'] == 3


# ── Keeping a radio song ────────────────────────────────────────────────

def test_adding_to_a_playlist_keeps_the_song(radio):
    alice = radio['alice']
    sid = radio['transient']('keepvideo01', 'Keep Me', 'Kept Artist', for_user=alice)
    pid = radio['playlist'](alice)

    res = radio['client'](alice).post(f'/api/playlists/{pid}/songs', json={'song_id': sid})
    assert res.status_code == 200

    row = Database.execute_query(
        "SELECT file_path, transient FROM songs WHERE id = %s", (sid,), fetch_one=True)
    assert row['transient'] == 0
    assert row['file_path'] == 'Keep Me - Kept Artist.m4a'
    assert os.path.isfile(os.path.join(radio['music_path'], row['file_path']))
    assert not os.path.exists(os.path.join(radio['music_path'], Config.RADIO_DIR, 'keepvideo01.m4a'))
    assert LibraryAccessModel.has_access(alice, sid)
    assert sid in {s['id'] for s in SongModel.get_all_songs(alice)}


def test_save_to_library_keeps_the_song(radio):
    alice = radio['alice']
    sid = radio['transient']('keepvideo02', 'Save Me', 'Saved Artist', for_user=alice)
    res = radio['client'](alice).post(f'/api/music/library/songs/{sid}')
    assert res.status_code == 200
    assert LibraryAccessModel.has_access(alice, sid)
    assert Database.execute_query(
        "SELECT transient FROM songs WHERE id = %s", (sid,), fetch_one=True)['transient'] == 0


def test_a_stranger_cannot_keep_someone_elses_radio_song(radio):
    sid = radio['transient']('keepvideo03', for_user=radio['alice'])
    stranger = radio['user']('radio_stranger4')
    pid = radio['playlist'](stranger)
    res = radio['client'](stranger).post(f'/api/playlists/{pid}/songs', json={'song_id': sid})
    assert res.status_code == 403
    assert not ytradio.promote(sid, stranger)


def test_kept_names_do_not_overwrite_existing_files(radio):
    alice = radio['alice']
    taken = os.path.join(radio['music_path'], 'Twin - Artist.m4a')
    with open(taken, 'wb') as f:
        f.write(b'existing')
    try:
        sid = radio['transient']('keepvideo04', 'Twin', 'Artist', for_user=alice)
        assert ytradio.promote(sid, alice)
        row = Database.execute_query(
            "SELECT file_path FROM songs WHERE id = %s", (sid,), fetch_one=True)
        assert row['file_path'] == 'Twin - Artist (2).m4a'
        with open(taken, 'rb') as f:
            assert f.read() == b'existing'
    finally:
        os.remove(taken)


def test_keeping_a_song_queues_light_show_and_retries_missing_lyrics(radio):
    from models.lyrics_job import LyricsJobModel
    alice = radio['alice']
    sid = radio['transient']('keepvideo05', 'No Lyrics Yet', 'Artist', for_user=alice)
    LyricsJobModel.save_lyrics(sid, None, None)      # an earlier lookup found nothing

    assert ytradio.promote(sid, alice)

    assert LyricsJobModel.get_lyrics(sid) is None     # so the job searches again
    for table in ('lightshow_jobs', 'lyrics_jobs'):
        assert Database.execute_query(
            f"SELECT 1 FROM {table} WHERE song_id = %s", (sid,), fetch_one=True), table


def test_keeping_a_song_leaves_found_lyrics_alone(radio):
    from models.lyrics_job import LyricsJobModel
    alice = radio['alice']
    sid = radio['transient']('keepvideo06', 'Has Lyrics', 'Artist', for_user=alice)
    LyricsJobModel.save_lyrics(sid, None, 'la la la')

    assert ytradio.promote(sid, alice)
    assert LyricsJobModel.get_lyrics(sid)['plain'] == 'la la la'


def test_a_downloaded_track_is_analysed_under_its_youtube_music_name(radio, monkeypatch):
    """Lyrics and enrichment are looked up by title/artist, so they are
    queued only once the song carries the names YouTube Music lists."""
    from models.enrichment_job import EnrichmentJobModel
    from utils import dedupe, enrichment_worker, lyrics_worker
    path = os.path.join(radio['music_path'], Config.RADIO_DIR, 'regvideo001.m4a')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'\x00' * 2048)

    seen = []

    def names(kind):
        def record(song_id, force=False):
            row = Database.execute_query(
                "SELECT title, artist FROM songs WHERE id = %s", (song_id,), fetch_one=True)
            seen.append((kind, row['title'], row['artist']))
        return record

    monkeypatch.setattr(MusicScanner, '_extract_metadata', lambda self, p, name: {
        'title': 'Tagged Title', 'artist': 'Writer A, Writer B', 'duration': 200})
    monkeypatch.setattr(ytradio, 'track_info', lambda vid: {
        'title': 'Real Title', 'artist': 'Real Artist', 'album': 'Real Album'})
    monkeypatch.setattr(dedupe, 'finalize_new_song', lambda *a, **k: None)
    monkeypatch.setattr(EnrichmentJobModel, 'enqueue_song', staticmethod(names('enrichment')))
    monkeypatch.setattr(enrichment_worker, 'notify', lambda: None)
    monkeypatch.setattr(lyrics_worker, 'enqueue_song', names('lyrics'))

    sid = radio_worker._register({'video_id': 'regvideo001'}, path, radio['music_path'])
    radio['track_song'](sid)

    assert seen == [('enrichment', 'Real Title', 'Real Artist'),
                    ('lyrics', 'Real Title', 'Real Artist')]


# ── Cleanup ─────────────────────────────────────────────────────────────

def test_cleanup_deletes_what_nobody_kept(radio):
    alice = radio['alice']
    fresh = radio['transient']('cleanvideo1', for_user=alice)
    stale = radio['transient']('cleanvideo2', for_user=alice)
    Database.execute_query(
        "UPDATE radio_access SET last_used_at = NOW() - INTERVAL 48 HOUR WHERE song_id = %s",
        (stale,))
    stale_file = os.path.join(radio['music_path'], Config.RADIO_DIR, 'cleanvideo2.m4a')

    deleted, promoted = ytradio.cleanup(radio['music_path'])

    assert (deleted, promoted) == (1, 0)
    assert SongModel.get_song_by_id(stale) is None and not os.path.exists(stale_file)
    assert SongModel.get_song_by_id(fresh) is not None
    assert RadioTrackModel.get_many(['cleanvideo2']) == {}


def test_cleanup_keeps_a_song_someone_put_in_a_playlist(radio):
    alice = radio['alice']
    sid = radio['transient']('cleanvideo3', 'In A Playlist', 'Someone', for_user=alice)
    PlaylistModel.add_song_to_playlist(radio['playlist'](alice), sid)

    deleted, promoted = ytradio.cleanup(radio['music_path'], ttl_hours=0)

    assert (deleted, promoted) == (0, 1)
    row = Database.execute_query(
        "SELECT file_path, transient FROM songs WHERE id = %s", (sid,), fetch_one=True)
    assert row['transient'] == 0 and not ytradio.is_transient_path(row['file_path'])


def test_cleanup_caps_how_many_downloads_pile_up(radio):
    alice = radio['alice']
    ids = [radio['transient'](f'capvideo{i:03d}', for_user=alice) for i in range(4)]
    for age, sid in zip((4, 3, 2, 1), ids):
        Database.execute_query(
            "UPDATE radio_access SET last_used_at = NOW() - INTERVAL %s HOUR WHERE song_id = %s",
            (age, sid))
    deleted, _ = ytradio.cleanup(radio['music_path'], max_files=2)
    assert deleted == 2
    assert [SongModel.get_song_by_id(s) is not None for s in ids] == [False, False, True, True]


# ── Scans leave the radio folder alone ──────────────────────────────────

def test_scans_ignore_the_radio_folder(radio):
    sid = radio['transient']('scanvideo01', for_user=radio['alice'])
    scanner = MusicScanner(radio['music_path'])

    found = {s['path'] for s in scanner.scan()}
    assert not any(p.startswith(Config.RADIO_DIR) for p in found)

    scanner.scan_to_database(full_scan=True)
    row = Database.execute_query(
        "SELECT transient FROM songs WHERE id = %s", (sid,), fetch_one=True)
    assert row is not None and row['transient'] == 1
    assert not LibraryAccessModel.has_access(radio['alice'], sid)
