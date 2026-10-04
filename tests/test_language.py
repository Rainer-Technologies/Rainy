"""Per-user UI language: picked at setup, returned by /me, changed in Settings."""
import uuid

from conftest import sign_in
from models.settings import SettingsModel
from models.user import UserModel


def _new_user(language=None):
    tag = uuid.uuid4().hex[:8]
    return UserModel.create_user(f'lang-{tag}', f'lang-{tag}@example.invalid',
                                 'password123', language=language)


def test_normalize_language():
    assert UserModel.normalize_language('es-ES') == 'es'
    assert UserModel.normalize_language('PL') == 'pl'
    assert UserModel.normalize_language('ca_ES') == 'ca'
    assert UserModel.normalize_language('en') == 'en'
    assert UserModel.normalize_language('fr') is None
    assert UserModel.normalize_language(None) is None
    assert UserModel.normalize_language(42) is None


def test_language_round_trip(app):
    user_id = _new_user()
    try:
        c = app.test_client()
        sign_in(c, user_id)
        # No choice yet: the client follows the browser's language.
        assert c.get('/api/auth/me').get_json()['user']['language'] is None

        r = c.post('/api/auth/language', json={'language': 'ca'})
        assert r.status_code == 200
        assert r.get_json()['language'] == 'ca'
        assert c.get('/api/auth/me').get_json()['user']['language'] == 'ca'

        assert c.post('/api/auth/language', json={'language': 'fr'}).status_code == 400
        assert c.post('/api/auth/language', json={}).status_code == 400
        assert c.get('/api/auth/me').get_json()['user']['language'] == 'ca'

        assert c.post('/api/auth/language', json={'language': None}).status_code == 200
        assert c.get('/api/auth/me').get_json()['user']['language'] is None
    finally:
        UserModel.delete_user(user_id)


def test_language_requires_auth(anon_client):
    r = anon_client.post('/api/auth/language', json={'language': 'es'})
    assert r.status_code == 401


def test_login_returns_language(app):
    user_id = _new_user(language='pl')
    try:
        user = UserModel.get_user_by_id(user_id)
        r = app.test_client().post('/api/auth/login',
                                   json={'email': user['email'], 'password': 'password123'})
        assert r.status_code == 200
        assert r.get_json()['user']['language'] == 'pl'
    finally:
        UserModel.delete_user(user_id)


def test_setup_stores_admin_language(app, monkeypatch, tmp_path):
    monkeypatch.setattr(UserModel, 'is_first_run', staticmethod(lambda: True))
    previous_music_path = SettingsModel.get_music_path()
    tag = uuid.uuid4().hex[:8]
    email = f'setup-{tag}@example.invalid'
    try:
        r = app.test_client().post('/api/setup/complete', json={
            'username': f'setup-{tag}',
            'email': email,
            'password': 'password123',
            'music_path': str(tmp_path),
            'language': 'es-ES',
        })
        assert r.status_code == 200
        assert r.get_json()['user']['language'] == 'es'
        user = UserModel.get_user_by_email(email)
        assert user['language'] == 'es'
        assert user['role'] == 'sysadmin'
    finally:
        user = UserModel.get_user_by_email(email)
        if user:
            UserModel.delete_user(user['id'])
        if previous_music_path:
            SettingsModel.set_music_path(previous_music_path)
