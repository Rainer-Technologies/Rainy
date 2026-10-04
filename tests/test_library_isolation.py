"""Multi-user library isolation: roles, publishing, full scans, per-song access."""
import os

import pytest

import app as app_module
from conftest import sign_in
from models.database import Database
from models.library_access import LibraryAccessModel
from models.song import ScanHistoryModel, SongModel
from models.user import UserModel


@pytest.fixture(autouse=True)
def no_workers(monkeypatch):
    for flag in ('_import_worker_started', '_enrichment_worker_started', '_sync_worker_started',
                 '_lightshow_worker_started', '_lyrics_worker_started', '_ytdlp_worker_started'):
        monkeypatch.setattr(app_module, flag, True)


def _song(path, title='Iso Song', artist='Iso Artist'):
    Database.execute_query(
        "INSERT INTO songs (file_path, title, artist) VALUES (%s, %s, %s)",
        (path, title, artist))
    return Database.execute_query(
        "SELECT id FROM songs WHERE file_path = %s", (path,), fetch_one=True)['id']


def _user(username, role='user'):
    email = f'{username}@test.local'
    if not UserModel.get_user_by_email(email):
        UserModel.create_user(username, email, 'secret123', role=role)
    return UserModel.get_user_by_email(email)['id']


def _visible(user_id, song_id):
    return LibraryAccessModel.has_access(user_id, song_id)


@pytest.fixture
def iso(app):
    """A sysadmin, a regular user, an admin-library song and a private import."""
    songs = []
    users = []

    def song(*args, **kwargs):
        songs.append(_song(*args, **kwargs))
        return songs[-1]

    def user(*args, **kwargs):
        users.append(_user(*args, **kwargs))
        return users[-1]

    def client(user_id):
        c = app.test_client()
        sign_in(c, user_id)
        return c

    admin = user('iso_admin', role='sysadmin')
    alice = user('iso_alice')
    scanned = song('/iso/scanned.mp3', title='Scanned Song')
    LibraryAccessModel.on_scan_added([scanned])
    private = song('/iso/private.mp3', title='Private Song', artist='Private Artist')
    LibraryAccessModel.grant(alice, private, origin='import')

    yield {'admin': admin, 'alice': alice, 'scanned': scanned, 'private': private,
           'song': song, 'user': user, 'client': client}

    for sid in songs:
        Database.execute_query("DELETE FROM songs WHERE id = %s", (sid,))
    for uid in users:
        UserModel.delete_user(uid)


# ── Roles and publishing ────────────────────────────────────────────────

def test_scanned_songs_are_admin_only(iso):
    assert _visible(iso['admin'], iso['scanned'])
    assert not _visible(iso['alice'], iso['scanned'])


def test_published_song_reaches_accounts_created_later(iso):
    LibraryAccessModel.publish_to_all(iso['scanned'])
    assert _visible(iso['alice'], iso['scanned'])
    bob = iso['user']('iso_bob')
    assert _visible(bob, iso['scanned'])


def test_published_imports_reach_accounts_created_later(iso):
    LibraryAccessModel.publish_all_imported_by(iso['alice'])
    assert _visible(iso['admin'], iso['private'])
    bob = iso['user']('iso_bob')
    assert _visible(bob, iso['private'])


def test_removing_a_published_song_sticks(iso):
    LibraryAccessModel.publish_to_all(iso['scanned'])
    c = iso['client'](iso['alice'])
    r = c.delete(f"/api/music/song/{iso['scanned']}")
    assert r.get_json()['removed'] == 'library'
    c.get('/api/music/library')
    assert not _visible(iso['alice'], iso['scanned'])
    assert SongModel.get_song_by_id(iso['scanned'])


def test_demoted_admin_loses_scanned_library_but_keeps_published(iso):
    published = iso['song']('/iso/published.mp3')
    LibraryAccessModel.on_scan_added([published])
    LibraryAccessModel.publish_to_all(published)
    second_admin = iso['user']('iso_admin2', role='sysadmin')
    assert _visible(second_admin, iso['scanned'])

    c = iso['client'](iso['admin'])
    r = c.post(f'/api/users/{second_admin}/role', json={'role': 'user'})
    assert r.status_code == 200
    assert not _visible(second_admin, iso['scanned'])
    assert _visible(second_admin, published)


def test_promoted_user_gains_scanned_library(iso):
    c = iso['client'](iso['admin'])
    assert c.post(f"/api/users/{iso['alice']}/role", json={'role': 'sysadmin'}).status_code == 200
    assert _visible(iso['alice'], iso['scanned'])
    assert _visible(iso['alice'], iso['private'])


def test_admin_routes_reject_regular_users(iso):
    c = iso['client'](iso['alice'])
    assert c.get('/api/users').status_code == 403
    assert c.post(f"/api/users/library/publish/{iso['private']}").status_code == 403


def test_privileged_changes_are_audited(iso):
    c = iso['client'](iso['admin'])
    c.post(f"/api/users/{iso['alice']}/full-library", json={'full_library': True})
    c.post(f"/api/users/library/publish/{iso['private']}")
    events = {r['event'] for r in Database.execute_query(
        "SELECT event FROM audit_events WHERE user_id = %s", (iso['admin'],),
        fetch_all=True)}
    assert {'full_library_changed', 'song_published'} <= events


# ── Per-song access on routes ───────────────────────────────────────────

@pytest.mark.parametrize('method,path', [
    ('get', '/api/music/info/{id}'),
    ('get', '/api/music/cast-url/{id}'),
    ('get', '/api/music/songs/{id}/metadata'),
    ('get', '/api/music/song/{id}/lyrics'),
    ('delete', '/api/music/song/{id}/lyrics'),
    ('post', '/api/music/song/{id}/lyrics'),
    ('get', '/api/music/song/{id}/lightshow/status'),
    ('delete', '/api/music/song/{id}/lightshow'),
    ('post', '/api/music/song/{id}/lightshow/analyze'),
    ('get', '/api/music/song/{id}/lyrics-words'),
    ('post', '/api/music/artists/Someone/songs/{id}'),
])
def test_song_routes_hide_other_accounts_songs(iso, method, path):
    c = iso['client'](iso['admin'])
    r = getattr(c, method)(path.format(id=iso['private']), json={})
    assert r.status_code == 404


def test_artist_song_list_only_shows_own_library(iso):
    c = iso['client'](iso['alice'])
    songs = c.get('/api/music/artists/Iso%20Artist/songs').get_json()['songs']
    ids = {s['id'] for s in songs}
    assert iso['private'] in ids and iso['scanned'] not in ids


def test_artist_profile_edit_needs_the_artist_in_your_library(iso):
    c = iso['client'](iso['alice'])
    body = {'description': 'x', 'image_url': ''}
    assert c.post('/api/music/artists/Iso%20Artist', json=body).status_code == 404
    assert c.post('/api/music/artists/Private%20Artist',
                  json={'description': 'x', 'image_url': 'javascript:alert(1)'}).status_code == 400
    assert c.post('/api/music/artists/Private%20Artist', json=body).status_code == 200
    Database.execute_query(
        "DELETE FROM artists_metadata WHERE artist_name = 'Private Artist'")


def test_duplicates_only_list_own_songs(iso):
    twin = iso['song']('/iso/private-twin.mp3', title='Private Song', artist='Private Artist')
    c = iso['client'](iso['alice'])
    groups = c.get('/api/music/duplicates').get_json()['groups']
    assert not any(iso['private'] in {s['id'] for s in g['songs']} for g in groups)
    LibraryAccessModel.grant(iso['alice'], twin)
    groups = c.get('/api/music/duplicates').get_json()['groups']
    assert any({iso['private'], twin} <= {s['id'] for s in g['songs']} for g in groups)


# ── Full scan keeps ids (and everything keyed on them) ──────────────────

def test_full_scan_updates_in_place(iso, tmp_path, monkeypatch):
    from utils import enrichment_worker, lightshow_worker, lyrics_worker
    from utils.scanner import MusicScanner
    from models.enrichment_job import EnrichmentJobModel

    # Isolate the scan from the rest of the database and the job queues.
    prefix = 'rainy-iso-scan/'
    real_existing = SongModel.get_songs_with_file_info
    monkeypatch.setattr(SongModel, 'get_songs_with_file_info', staticmethod(
        lambda: {p: r for p, r in real_existing().items() if p.startswith(prefix)}))
    monkeypatch.setattr(ScanHistoryModel, 'start_scan', staticmethod(lambda t: 0))
    monkeypatch.setattr(ScanHistoryModel, 'complete_scan', staticmethod(lambda *a: None))
    monkeypatch.setattr(EnrichmentJobModel, 'enqueue_song', staticmethod(lambda *a, **k: 0))
    for mod in (enrichment_worker, lightshow_worker, lyrics_worker):
        monkeypatch.setattr(mod, 'notify', lambda: None)
    for mod in (lightshow_worker, lyrics_worker):
        monkeypatch.setattr(mod, 'enqueue_song', lambda *a, **k: None)

    folder = tmp_path / prefix
    folder.mkdir()
    (folder / 'keep.mp3').write_bytes(b'not really audio')
    (folder / 'gone.mp3').write_bytes(b'not really audio')

    scanner = MusicScanner(str(tmp_path))
    scanner.scan_to_database(full_scan=False)
    keep = SongModel.get_song_by_path(prefix + 'keep.mp3')['id']
    gone = SongModel.get_song_by_path(prefix + 'gone.mp3')['id']
    try:
        LibraryAccessModel.grant(iso['alice'], keep, origin='import')
        playlist = Database.execute_query(
            "INSERT INTO playlists (name, owner_user_id) VALUES (%s, %s)",
            ('Iso Scan Playlist', iso['alice']))
        Database.execute_query(
            "INSERT INTO playlist_entries (playlist_id, track_id) VALUES (%s, %s)",
            (playlist, keep))

        os.remove(folder / 'gone.mp3')
        stats = scanner.scan_to_database(full_scan=True)

        assert stats['files_removed'] == 1
        assert SongModel.get_song_by_path(prefix + 'keep.mp3')['id'] == keep
        assert SongModel.get_song_by_id(gone) is None
        assert _visible(iso['alice'], keep)
        assert Database.execute_query(
            "SELECT 1 FROM playlist_entries WHERE playlist_id = %s AND track_id = %s",
            (playlist, keep), fetch_one=True)
    finally:
        Database.execute_query("DELETE FROM songs WHERE file_path LIKE %s", (prefix + '%',))
        Database.execute_query("DELETE FROM playlists WHERE name = 'Iso Scan Playlist'")


# ── Settings permissions ────────────────────────────────────────────────

@pytest.mark.parametrize('path', ['/api/music/lightshow/backfill',
                                  '/api/music/lyrics/backfill',
                                  '/api/music/enrich/backfill'])
def test_forced_backfill_is_admin_only(iso, monkeypatch, path):
    from models.enrichment_job import EnrichmentJobModel
    from models.lightshow_job import LightshowJobModel
    from models.lyrics_job import LyricsJobModel
    for model in (EnrichmentJobModel, LightshowJobModel, LyricsJobModel):
        monkeypatch.setattr(model, 'enqueue_backfill', staticmethod(lambda **k: 0))
        monkeypatch.setattr(model, 'get', staticmethod(lambda job_id: None))
    c = iso['client'](iso['alice'])
    assert c.post(path, json={'force': True}).status_code == 403
    assert c.post(path, json={}).status_code != 403


def _dup_group(client, song_id):
    groups = client.get('/api/music/duplicates').get_json()['groups']
    return next(g for g in groups if song_id in {s['id'] for s in g['songs']})


def test_user_merges_duplicates_that_are_theirs_alone(iso):
    twin = iso['song']('/iso/private-twin.mp3', title='Private Song', artist='Private Artist')
    LibraryAccessModel.grant(iso['alice'], twin)
    c = iso['client'](iso['alice'])
    assert _dup_group(c, twin)['can_merge'] is True
    r = c.post('/api/music/duplicates/merge',
               json={'song_ids': [iso['private'], twin], 'keeper_id': iso['private']})
    assert r.status_code == 200
    assert SongModel.get_song_by_id(twin) is None
    assert _visible(iso['alice'], iso['private'])


def test_user_cannot_merge_shared_duplicates(iso):
    twin = iso['song']('/iso/scanned-twin.mp3', title='Private Song', artist='Private Artist')
    LibraryAccessModel.grant(iso['alice'], twin)
    LibraryAccessModel.grant(iso['admin'], twin, origin='scan')
    c = iso['client'](iso['alice'])
    assert _dup_group(c, twin)['can_merge'] is False
    r = c.post('/api/music/duplicates/merge', json={'song_ids': [iso['private'], twin]})
    assert r.status_code == 403
    assert SongModel.get_song_by_id(twin)


def test_merge_keeps_every_accounts_access(iso):
    twin = iso['song']('/iso/scanned-twin.mp3', title='Private Song', artist='Private Artist')
    LibraryAccessModel.on_scan_added([twin])
    LibraryAccessModel.publish_to_all(twin)
    c = iso['client'](iso['admin'])
    r = c.post('/api/music/duplicates/merge',
               json={'song_ids': [iso['private'], twin], 'keeper_id': iso['private']})
    assert r.status_code == 200
    bob = iso['user']('iso_bob')
    for uid in (iso['admin'], iso['alice'], bob):
        assert _visible(uid, iso['private'])


def test_syncs_on_ownerless_playlists_are_admin_only(iso):
    from models.playlist_sync import PlaylistSyncModel
    playlist = Database.execute_query(
        "INSERT INTO playlists (name, owner_user_id) VALUES (%s, NULL)", ('Iso Legacy',))
    try:
        sync_id = PlaylistSyncModel.create(playlist, 'youtube', 'https://youtube.com/playlist?list=x')
        user, admin = iso['client'](iso['alice']), iso['client'](iso['admin'])
        assert sync_id not in {s['id'] for s in user.get('/api/playlist-syncs').get_json()['syncs']}
        assert sync_id in {s['id'] for s in admin.get('/api/playlist-syncs').get_json()['syncs']}
        assert user.delete(f'/api/playlist-syncs/{sync_id}').status_code == 403
        assert admin.delete(f'/api/playlist-syncs/{sync_id}').status_code == 200
    finally:
        Database.execute_query("DELETE FROM playlists WHERE id = %s", (playlist,))


def test_preferences_must_be_a_small_object(iso):
    c = iso['client'](iso['alice'])
    assert c.post('/api/auth/preferences', json={'preferences': 'x'}).status_code == 400
    assert c.post('/api/auth/preferences',
                  json={'preferences': {'blob': 'x' * 70000}}).status_code == 413
    assert c.post('/api/auth/preferences', json={'preferences': {'theme_color': '#fff'}}).status_code == 200


def test_merge_deletes_the_leftover_files(iso, tmp_path, monkeypatch):
    from models.settings import SettingsModel
    monkeypatch.setattr(SettingsModel, 'get_music_path', staticmethod(lambda: str(tmp_path)))
    (tmp_path / 'covers').mkdir()
    for name in ('keep.mp3', 'dupe.mp3', 'covers/shared.jpg', 'covers/dupe.jpg'):
        (tmp_path / name).write_bytes(b'x')
    outside = tmp_path.parent / 'outside.mp3'
    outside.write_bytes(b'x')

    def song(path, cover):
        sid = iso['song'](path, title='Merge Me', artist='Iso Artist')
        Database.execute_query("UPDATE songs SET cover_path = %s WHERE id = %s", (cover, sid))
        return sid

    keep = song('keep.mp3', 'covers/shared.jpg')
    dupe = song('dupe.mp3', 'covers/dupe.jpg')
    escape = song('../outside.mp3', 'covers/shared.jpg')   # points outside the folder

    c = iso['client'](iso['admin'])
    r = c.post('/api/music/duplicates/merge',
               json={'song_ids': [keep, dupe, escape], 'keeper_id': keep})
    assert r.status_code == 200 and 'removed_files' not in r.get_json()

    assert (tmp_path / 'keep.mp3').exists()
    assert not (tmp_path / 'dupe.mp3').exists()
    assert not (tmp_path / 'covers/dupe.jpg').exists()
    assert (tmp_path / 'covers/shared.jpg').exists()   # still the keeper's cover
    assert outside.exists()                             # never outside the folder
