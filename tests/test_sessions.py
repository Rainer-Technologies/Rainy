"""Server-side sessions, media tokens, login throttling, CSRF origin check."""
from conftest import sign_in
from models.session import SessionModel
from utils import media_token, ratelimit


def test_revoked_session_is_rejected(app):
    c = app.test_client()
    token = sign_in(c, 1)
    assert c.get('/api/auth/me').status_code == 200
    SessionModel.revoke(token)
    assert c.get('/api/auth/me').status_code == 401


def test_cookie_without_sid_is_rejected(app):
    c = app.test_client()
    with c.session_transaction() as sess:
        sess['user_id'] = 1
    assert c.get('/api/auth/me').status_code == 401


def test_logout_revokes_server_side(app):
    c = app.test_client()
    token = sign_in(c, 1)
    assert c.post('/api/auth/logout').status_code == 200
    assert SessionModel.validate(token, 3600) is None


def test_query_session_token_no_longer_accepted(app, client):
    raw = app.test_client()
    assert raw.get('/api/music/library?session=abc').status_code == 401
    assert raw.get('/api/music/library', headers={'X-Session-Token': 'abc'}).status_code == 401


def test_media_token_only_opens_media_endpoints(app):
    app.secret_key  # ensure initialised
    with app.test_request_context():
        tok = media_token.issue(1)
    anon = app.test_client()
    assert anon.get(f'/api/music/library?mt={tok}').status_code == 401
    # stream for a missing song → passes auth (404/400), not 401
    assert anon.get(f'/api/music/stream/999999999?mt={tok}').status_code != 401
    assert anon.get('/api/music/stream/999999999?mt=garbage').status_code == 401


def test_login_throttled_after_repeated_failures(app):
    email = 'nobody-throttle@example.invalid'
    ratelimit.reset(f'login:email:{email}')
    c = app.test_client()
    codes = [c.post('/api/auth/login', json={'email': email, 'password': 'wrong-pass'}).status_code
             for _ in range(10)]
    assert codes[0] == 401
    assert codes[-1] == 429
    ratelimit.reset(f'login:email:{email}')


def test_cross_origin_post_blocked(app, client):
    r = client.post('/api/auth/logout', headers={'Origin': 'https://evil.example'})
    assert r.status_code == 403
