"""Friendship API tests: request → accept → friends → unfriend lifecycle."""
import pytest
from models.database import Database
from models.user import UserModel


@pytest.fixture
def friend_users():
    """Users 2 and 3 exist for friendship tests (created assertively)."""
    ids = []
    for uid, (username, email) in {
        2: ('friend_a', 'frienda@test.local'),
        3: ('friend_b', 'friendb@test.local'),
    }.items():
        if not UserModel.get_user_by_email(email):
            UserModel.create_user(username, email, 'secret1')
        ids.append(UserModel.get_user_by_email(email)['id'])
    yield ids
    for uid in ids:
        UserModel.delete_user(uid)


@pytest.fixture
def client_as(app):
    """Authenticated test client as a given user id."""
    def _make(user_id):
        from conftest import sign_in
        c = app.test_client()
        sign_in(c, user_id)
        return c
    return _make


def test_friend_request_lifecycle(app, client_as, friend_users):
    user_a, user_b = friend_users
    ca, cb = client_as(user_a), client_as(user_b)

    # A sends request to B
    r = ca.post('/api/friends/requests', json={'email': 'friendb@test.local'})
    assert r.status_code == 200
    assert r.get_json()['status'] == 'pending'

    # B sees it incoming, A sees it outgoing
    inc = cb.get('/api/friends/requests').get_json()
    assert len(inc['incoming']) == 1 and inc['incoming'][0]['user_id'] == user_a
    assert inc['outgoing'] == []
    out = ca.get('/api/friends/requests').get_json()
    assert len(out['outgoing']) == 1 and out['outgoing'][0]['user_id'] == user_b

    # Not friends yet, no shared playlists
    assert ca.get('/api/friends').get_json()['friends'] == []

    # B accepts
    rid = inc['incoming'][0]['id']
    r = cb.post(f'/api/friends/requests/{rid}/accept')
    assert r.status_code == 200

    # Both see each other now
    assert len(ca.get('/api/friends').get_json()['friends']) == 1
    assert len(cb.get('/api/friends').get_json()['friends']) == 1

    # Duplicate request → 409
    r = ca.post('/api/friends/requests', json={'email': 'friendb@test.local'})
    assert r.status_code == 409

    # Unfriend → empty again; B can re-request
    r = ca.delete(f'/api/friends/{user_b}')
    assert r.status_code == 200
    assert ca.get('/api/friends').get_json()['friends'] == []
    r = cb.post('/api/friends/requests', json={'username': 'friend_a'})
    assert r.status_code == 200
    assert r.get_json()['status'] == 'pending'


def test_reverse_request_auto_accepts(app, client_as, friend_users):
    user_a, user_b = friend_users
    ca, cb = client_as(user_a), client_as(user_b)

    # B requests A first
    r = cb.post('/api/friends/requests', json={'email': 'frienda@test.local'})
    assert r.get_json()['status'] == 'pending'

    # A requests B → mutual connect, instant friends
    r = ca.post('/api/friends/requests', json={'email': 'friendb@test.local'})
    assert r.status_code == 200
    assert r.get_json()['status'] == 'accepted'

    assert len(ca.get('/api/friends').get_json()['friends']) == 1
    assert len(cb.get('/api/friends').get_json()['friends']) == 1


def test_decline_and_withdraw(app, client_as, friend_users):
    user_a, user_b = friend_users
    ca, cb = client_as(user_a), client_as(user_b)

    ca.post('/api/friends/requests', json={'email': 'friendb@test.local'})
    inc = cb.get('/api/friends/requests').get_json()['incoming']
    rid = inc[0]['id']

    # B declines
    assert cb.post(f'/api/friends/requests/{rid}/decline').status_code == 200
    assert cb.get('/api/friends/requests').get_json()['incoming'] == []

    # A can withdraw their own pending request via decline too
    ca.post('/api/friends/requests', json={'email': 'friendb@test.local'})
    out = ca.get('/api/friends/requests').get_json()['outgoing']
    assert len(out) == 1
    assert ca.post(f"/api/friends/requests/{out[0]['id']}/decline").status_code == 200
    assert ca.get('/api/friends/requests').get_json()['outgoing'] == []


def test_friend_request_validation(app, client_as, friend_users):
    user_a, _ = friend_users
    ca = client_as(user_a)

    # Self-request rejected
    r = ca.post('/api/friends/requests', json={'email': 'frienda@test.local'})
    assert r.status_code == 400

    # Unknown user
    r = ca.post('/api/friends/requests', json={'email': 'nobody@test.local'})
    assert r.status_code == 404

    # Missing identifier
    r = ca.post('/api/friends/requests', json={})
    assert r.status_code == 400

    # Unauthenticated
    assert app.test_client().get('/api/friends').status_code == 401

def test_sender_cannot_accept_own_request(app, client_as, friend_users):
    from models.friendship import FriendshipModel
    user_a, user_b = friend_users
    a, b = client_as(user_a), client_as(user_b)
    identifier = b.get('/api/auth/me').get_json()['user']['email']
    assert a.post('/api/friends/requests', json={'email': identifier}).status_code == 200
    req_id = a.get('/api/friends/requests').get_json()['outgoing'][0]['id']

    assert a.post(f'/api/friends/requests/{req_id}/accept').status_code == 403
    assert not FriendshipModel.are_friends(user_a, user_b)

    assert b.post(f'/api/friends/requests/{req_id}/accept').status_code == 200
    assert FriendshipModel.are_friends(user_a, user_b)
