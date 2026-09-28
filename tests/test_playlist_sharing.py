"""Playlist sharing tests: invite → accept → collaborate → revoke."""
import pytest

from models.database import Database
from models.user import UserModel


@pytest.fixture
def share_setup():
    """Two extra users + a song both can hear + a playlist owned by user 1."""
    ids = []
    for username, email in [('share_a', 'sharea@test.local'),
                            ('share_b', 'shareb@test.local')]:
        if not UserModel.get_user_by_email(email):
            UserModel.create_user(username, email, 'secret1')
        ids.append(UserModel.get_user_by_email(email)['id'])
    user_a, user_b = ids

    song = Database.execute_query(
        "INSERT INTO songs (file_path, title, artist) VALUES (%s, %s, %s)",
        ('/test/share-song.mp3', 'Share Song', 'Test Artist'))
    song_id = song if isinstance(song, int) else Database.execute_query(
        "SELECT id FROM songs WHERE file_path = '/test/share-song.mp3'",
        fetch_one=True)['id']
    for uid in (1, user_a, user_b):
        Database.execute_query(
            "INSERT IGNORE INTO library_access (user_id, song_id, origin) "
            "VALUES (%s, %s, 'scan')", (uid, song_id))

    playlist_id = Database.execute_query(
        "INSERT INTO playlists (name, owner_user_id) VALUES (%s, %s)",
        ('Shared Test Playlist', 1))

    yield {'user_a': user_a, 'user_b': user_b, 'song_id': song_id,
           'playlist_id': playlist_id}

    Database.execute_query("DELETE FROM playlists WHERE id = %s", (playlist_id,))
    Database.execute_query("DELETE FROM songs WHERE id = %s", (song_id,))
    for uid in ids:
        UserModel.delete_user(uid)


@pytest.fixture
def client_as(app):
    def _make(user_id):
        c = app.test_client()
        with c.session_transaction() as sess:
            sess['user_id'] = user_id
        return c
    return _make


def make_friends(ca, cb, email_b):
    ca.post('/api/friends/requests', json={'email': email_b})
    inc = cb.get('/api/friends/requests').get_json()['incoming']
    cb.post(f"/api/friends/requests/{inc[0]['id']}/accept")


@pytest.fixture
def friends_fixture(client_as, share_setup):
    ca = client_as(1)
    cb = client_as(share_setup['user_a'])
    make_friends(ca, cb, 'sharea@test.local')
    return ca, cb


def test_invite_requires_friendship(friends_fixture, share_setup, client_as):
    ca, _ = friends_fixture
    stranger = client_as(share_setup['user_b'])
    # user_b is NOT a friend of user 1 in this fixture
    r = ca.post(f"/api/playlists/{share_setup['playlist_id']}/shares",
                json={'user_id': share_setup['user_b']})
    assert r.status_code == 403
    # A friend CAN be invited; a stranger cannot self-invite
    r = stranger.post(f"/api/playlists/{share_setup['playlist_id']}/shares",
                      json={'user_id': share_setup['user_b']})
    assert r.status_code == 403


def test_invite_accept_and_appear(friends_fixture, share_setup, client_as):
    ca, cb = friends_fixture
    pid = share_setup['playlist_id']
    user_a = share_setup['user_a']

    # Invite
    r = ca.post(f'/api/playlists/{pid}/shares', json={'user_id': user_a})
    assert r.status_code == 200

    # Pending: invitee sees the invite, but NOT the playlist
    invites = cb.get('/api/playlists/invites').get_json()['invites']
    assert len(invites) == 1 and invites[0]['playlist_id'] == pid
    assert invites[0]['status'] == 'pending'
    assert cb.get('/api/playlists/').get_json() == [] or \
        all(p['id'] != pid for p in cb.get('/api/playlists/').get_json())
    assert cb.get(f'/api/playlists/{pid}').status_code == 403

    # Can't edit while pending either
    assert cb.post(f'/api/playlists/{pid}/songs',
                   json={'song_id': share_setup['song_id']}).status_code == 403

    # Accept
    r = cb.post(f"/api/playlists/invites/{invites[0]['id']}/accept")
    assert r.status_code == 200

    # Now visible as shared
    playlists = cb.get('/api/playlists/').get_json()
    mine = [p for p in playlists if p['id'] == pid]
    assert len(mine) == 1 and mine[0]['shared'] is True

    # Owner still listed the playlist
    owner_list = ca.get('/api/playlists/').get_json()
    owner_row = [p for p in owner_list if p['id'] == pid][0]
    assert owner_row['shared'] is False

    # GET works and reports role (default invite role is 'admin')
    detail = cb.get(f'/api/playlists/{pid}').get_json()
    assert detail['role'] == 'admin' and detail['songs'] == []


def test_collaborator_can_edit(friends_fixture, share_setup, client_as):
    ca, cb = friends_fixture
    pid = share_setup['playlist_id']
    song_id = share_setup['song_id']
    user_a = share_setup['user_a']

    ca.post(f'/api/playlists/{pid}/shares', json={'user_id': user_a})
    share_id = cb.get('/api/playlists/invites').get_json()['invites'][0]['id']
    cb.post(f'/api/playlists/invites/{share_id}/accept')

    # Add a song, rename, reorder
    assert cb.post(f'/api/playlists/{pid}/songs',
                   json={'song_id': song_id}).status_code == 200
    assert cb.put(f'/api/playlists/{pid}', json={'name': 'Renamed Together'}).status_code == 200
    assert cb.post(f'/api/playlists/{pid}/reorder',
                   json={'ordered_track_ids': [song_id]}).status_code == 200
    detail = cb.get(f'/api/playlists/{pid}').get_json()
    assert detail['name'] == 'Renamed Together'
    assert detail['songs'][0]['id'] == song_id

    # Owner sees the collaborator's addition too
    owner_detail = ca.get(f'/api/playlists/{pid}').get_json()
    assert len(owner_detail['songs']) == 1

    # Collaborator can remove songs
    assert cb.delete(f'/api/playlists/{pid}/songs/{song_id}').status_code == 200
    assert ca.get(f'/api/playlists/{pid}').get_json()['songs'] == []


def test_collaborator_cannot_delete_or_invite(friends_fixture, share_setup, client_as):
    ca, cb = friends_fixture
    pid = share_setup['playlist_id']
    user_a = share_setup['user_a']
    user_b = share_setup['user_b']

    ca.post(f'/api/playlists/{pid}/shares', json={'user_id': user_a})
    share_id = cb.get('/api/playlists/invites').get_json()['invites'][0]['id']
    cb.post(f'/api/playlists/invites/{share_id}/accept')

    # Collaborator cannot delete the playlist, owner can
    assert cb.delete(f'/api/playlists/{pid}').status_code == 403
    assert cb.post(f'/api/playlists/{pid}/shares',
                   json={'user_id': user_b}).status_code == 403

    # Fresh playlist: collaborator also cannot invite others
    created = ca.post('/api/playlists/', json={'name': 'Temp Invite Test'}).get_json()
    pid2 = created['id']
    ca.post(f'/api/playlists/{pid2}/shares', json={'user_id': user_a})
    share_id2 = cb.get('/api/playlists/invites').get_json()['invites'][0]['id']
    cb.post(f'/api/playlists/invites/{share_id2}/accept')
    assert cb.post(f'/api/playlists/{pid2}/shares',
                   json={'user_id': user_b}).status_code == 403
    ca.delete(f'/api/playlists/{pid2}')


def test_viewer_cannot_edit(friends_fixture, share_setup, client_as):
    ca, cb = friends_fixture
    pid = share_setup['playlist_id']
    song_id = share_setup['song_id']
    user_a = share_setup['user_a']
    user_b = share_setup['user_b']

    # Owner invites user_a as a VIEWER
    r = ca.post(f'/api/playlists/{pid}/shares',
                json={'user_id': user_a, 'role': 'viewer'})
    assert r.status_code == 200
    share_id = cb.get('/api/playlists/invites').get_json()['invites'][0]['id']
    cb.post(f'/api/playlists/invites/{share_id}/accept')

    # Visible, role reported as viewer
    detail = cb.get(f'/api/playlists/{pid}').get_json()
    assert detail['role'] == 'viewer'

    # Viewer can download/export (read access) but no song editing
    assert cb.get(f'/api/playlists/{pid}/download').status_code == 400  # empty playlist, but authorized
    assert cb.get(f'/api/playlists/{pid}/export?format=m3u').status_code == 400
    assert cb.post(f'/api/playlists/{pid}/songs',
                   json={'song_id': song_id}).status_code == 403
    assert cb.put(f'/api/playlists/{pid}', json={'name': 'Viewer Rename'}).status_code == 403
    assert cb.post(f'/api/playlists/{pid}/reorder',
                   json={'ordered_track_ids': [song_id]}).status_code == 403
    assert cb.post(f'/api/playlists/{pid}/cover').status_code == 403

    # Owner adds a song; viewer still cannot remove it
    assert ca.post(f'/api/playlists/{pid}/songs',
                   json={'song_id': song_id}).status_code == 200
    assert cb.delete(f'/api/playlists/{pid}/songs/{song_id}').status_code == 403
    assert ca.get(f'/api/playlists/{pid}').get_json()['songs'][0]['id'] == song_id

    # Viewer cannot delete the playlist, cannot invite, cannot revoke
    assert cb.delete(f'/api/playlists/{pid}').status_code == 403
    assert cb.post(f'/api/playlists/{pid}/shares',
                   json={'user_id': user_b}).status_code == 403

    # Viewer can leave (remove from their library only)
    assert cb.post(f'/api/playlists/{pid}/leave').status_code == 200
    assert cb.get(f'/api/playlists/{pid}').status_code == 403
    # Owner unaffected
    assert ca.get(f'/api/playlists/{pid}').status_code == 200


def test_owner_can_change_role(friends_fixture, share_setup, client_as):
    ca, cb = friends_fixture
    pid = share_setup['playlist_id']
    song_id = share_setup['song_id']
    user_a = share_setup['user_a']

    # Invite as viewer
    ca.post(f'/api/playlists/{pid}/shares', json={'user_id': user_a, 'role': 'viewer'})
    share_id = cb.get('/api/playlists/invites').get_json()['invites'][0]['id']
    cb.post(f'/api/playlists/invites/{share_id}/accept')
    assert cb.post(f'/api/playlists/{pid}/songs',
                   json={'song_id': song_id}).status_code == 403

    # Owner promotes viewer -> admin: now they can add songs
    assert ca.put(f'/api/playlists/{pid}/shares/{share_id}',
                  json={'role': 'admin'}).status_code == 200
    assert cb.get(f'/api/playlists/{pid}').get_json()['role'] == 'admin'
    assert cb.post(f'/api/playlists/{pid}/songs',
                   json={'song_id': song_id}).status_code == 200

    # Owner demotes admin -> viewer: edit rights revoked again
    assert ca.put(f'/api/playlists/{pid}/shares/{share_id}',
                  json={'role': 'viewer'}).status_code == 200
    assert cb.delete(f'/api/playlists/{pid}/songs/{song_id}').status_code == 403

    # Collaborator cannot change their own role
    assert cb.put(f'/api/playlists/{pid}/shares/{share_id}',
                  json={'role': 'admin'}).status_code == 403

    # Invalid role rejected
    assert ca.put(f'/api/playlists/{pid}/shares/{share_id}',
                  json={'role': 'superuser'}).status_code == 400
    assert ca.post(f'/api/playlists/{pid}/shares',
                   json={'user_id': user_a, 'role': 'superuser'}).status_code == 400


def test_role_controls_listing(friends_fixture, share_setup, client_as):
    """Accepted shares surface share_role so the UI can gate actions."""
    ca, cb = friends_fixture
    pid = share_setup['playlist_id']
    user_a = share_setup['user_a']

    ca.post(f'/api/playlists/{pid}/shares', json={'user_id': user_a, 'role': 'viewer'})
    share_id = cb.get('/api/playlists/invites').get_json()['invites'][0]['id']
    cb.post(f'/api/playlists/invites/{share_id}/accept')

    mine = [p for p in cb.get('/api/playlists/').get_json() if p['id'] == pid]
    assert len(mine) == 1
    assert mine[0]['shared'] is True
    assert mine[0]['share_role'] == 'viewer'
    assert mine[0]['owner_username'] is not None


def test_owner_revoke_and_leave(friends_fixture, share_setup, client_as):
    ca, cb = friends_fixture
    pid = share_setup['playlist_id']
    user_a = share_setup['user_a']

    ca.post(f'/api/playlists/{pid}/shares', json={'user_id': user_a})
    share_id = cb.get('/api/playlists/invites').get_json()['invites'][0]['id']
    cb.post(f'/api/playlists/invites/{share_id}/accept')

    # Collaborator leaves on their own
    assert cb.post(f'/api/playlists/shares/{share_id}/leave').status_code == 200
    assert cb.get(f'/api/playlists/{pid}').status_code == 403

    # Re-invite, accept, then owner revokes
    ca.post(f'/api/playlists/{pid}/shares', json={'user_id': user_a})
    share_id = cb.get('/api/playlists/invites').get_json()['invites'][0]['id']
    cb.post(f'/api/playlists/invites/{share_id}/accept')

    shares = ca.get(f'/api/playlists/{pid}/shares').get_json()['shares']
    assert len(shares) == 1 and shares[0]['status'] == 'accepted'
    assert ca.delete(f'/api/playlists/{pid}/shares/{share_id}').status_code == 200
    assert cb.get(f'/api/playlists/{pid}').status_code == 403
    # Owner's own access is intact
    assert ca.get(f'/api/playlists/{pid}').status_code == 200