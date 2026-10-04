"""Library change fingerprints polled by the UI for live updates."""
import pytest

from models.database import Database
from models.user import UserModel


def _version(client):
    res = client.get('/api/music/library/version')
    assert res.status_code == 200
    return res.get_json()


@pytest.fixture
def other_user():
    email = 'libversion_other@test.local'
    if not UserModel.get_user_by_email(email):
        UserModel.create_user('libversion_other', email, 'secret1')
    user_id = UserModel.get_user_by_email(email)['id']
    yield user_id
    UserModel.delete_user(user_id)


@pytest.fixture
def song():
    song_id = Database.execute_query(
        "INSERT INTO songs (file_path, title, artist) VALUES (%s, %s, %s)",
        ('/test/libversion-song.mp3', 'Version Song', 'Test Artist'))
    yield song_id
    Database.execute_query("DELETE FROM songs WHERE id = %s", (song_id,))


def test_requires_auth(anon_client):
    assert anon_client.get('/api/music/library/version').status_code == 401


def test_songs_version_tracks_library_membership(client, song):
    before = _version(client)['songs']

    Database.execute_query(
        "INSERT IGNORE INTO library_access (user_id, song_id, origin) "
        "VALUES (1, %s, 'import')", (song,))
    added = _version(client)['songs']
    assert added != before

    # The full library payload reports the same version it rendered.
    assert client.get('/api/music/library').get_json()['version'] == added

    Database.execute_query("DELETE FROM songs WHERE id = %s", (song,))
    assert _version(client)['songs'] == before


def test_playlists_version_tracks_visible_playlists(client, song, other_user):
    Database.execute_query(
        "INSERT IGNORE INTO library_access (user_id, song_id, origin) "
        "VALUES (1, %s, 'import')", (song,))
    v0 = _version(client)['playlists']

    # Another account's private playlist is invisible, so no change.
    hidden = Database.execute_query(
        "INSERT INTO playlists (name, owner_user_id) VALUES (%s, %s)",
        ('Hidden Version Playlist', other_user))
    assert _version(client)['playlists'] == v0

    mine = Database.execute_query(
        "INSERT INTO playlists (name, owner_user_id) VALUES (%s, %s)",
        ('Version Playlist', 1))
    try:
        v1 = _version(client)['playlists']
        assert v1 != v0

        Database.execute_query(
            "INSERT INTO playlist_entries (playlist_id, track_id, order_num) "
            "VALUES (%s, %s, 0)", (mine, song))
        v2 = _version(client)['playlists']
        assert v2 != v1

        Database.execute_query(
            "UPDATE playlists SET name = %s WHERE id = %s", ('Renamed', mine))
        assert _version(client)['playlists'] != v2
    finally:
        Database.execute_query("DELETE FROM playlists WHERE id IN (%s, %s)",
                               (mine, hidden))

    assert _version(client)['playlists'] == v0
