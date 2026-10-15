"""UI theme packages: the manifest, the rules for a theme's CSS, the routes and file serving."""
import io
import json
import os
import zipfile

import pytest

import app as app_module
from conftest import sign_in
from models.theme import ThemeModel
from models.user import UserModel
from utils import themes as packages
from utils.themes import PackageError, lint_css

MANIFEST = {
    'manifest': 1, 'api': 1, 'id': 'test-theme', 'name': 'Test Theme', 'version': '1.0.0',
    'description': 'For the tests', 'author': 'Rainy', 'colorScheme': 'light',
    'tokens': {'--accent-primary': '#e53935', '--bg-primary': '#ffffff', '--theme-glow': '0 0 4px red'},
    'styles': ['style.css'], 'entry': 'index.js', 'preview': 'preview.png',
    'i18n': {'es': {'name': 'Tema de prueba'}},
}
FILES = {
    'style.css': '[data-part~="sidebar"] { width: 72px; }\n.nav-item::after { display: none; }\n',
    'index.js': 'export default class { mount() {} unmount() {} }\n',
    'preview.png': 'not really a png',
    'fonts/display.woff2': 'font',
}


def make_zip(manifest=MANIFEST, files=FILES, prefix='', extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        if manifest is not None:
            zf.writestr(prefix + packages.MANIFEST_NAME, json.dumps(manifest))
        for name, body in {**files, **(extra or {})}.items():
            zf.writestr(prefix + name, body)
    return buf.getvalue()


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    # Keep the before_request hooks from spinning up real background workers.
    for flag in ('_import_worker_started', '_enrichment_worker_started',
                 '_sync_worker_started', '_lightshow_worker_started', '_lyrics_worker_started'):
        monkeypatch.setattr(app_module, flag, True)
    monkeypatch.setattr(packages.Config, 'THEMES_CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setattr(packages.Config, 'THEMES_DEV_DIR', None)
    yield
    for row in ThemeModel.list_all(include_disabled=True):
        ThemeModel.delete(row['id'])
    ThemeModel.set_default(None)


@pytest.fixture
def admin(app):
    c = app.test_client()
    sign_in(c, 1)
    return c


@pytest.fixture
def member(app):
    email = 'theme-test-member@example.test'
    user = UserModel.get_user_by_email(email)
    uid = user['id'] if user else UserModel.create_user('theme-test-member', email, 'not-a-real-password', role='user')
    c = app.test_client()
    sign_in(c, uid)
    yield c
    UserModel.delete_user(uid)


def upload(client, data, name='theme.zip'):
    return client.post('/api/themes', data={'package': (io.BytesIO(data), name)},
                       content_type='multipart/form-data')


# ------------------------------------------------------------ manifest

def test_reads_a_valid_package():
    manifest = packages.read_package(make_zip())
    assert manifest['id'] == 'test-theme'
    assert manifest['colorScheme'] == 'light'
    assert manifest['tokens']['--accent-primary'] == '#e53935'
    assert manifest['styles'] == ['style.css'] and manifest['entry'] == 'index.js'
    assert manifest['i18n'] == {'es': {'name': 'Tema de prueba'}}
    assert packages.read_package(make_zip(prefix='test-theme-main/'))['id'] == 'test-theme'


def test_code_and_tokens_are_optional():
    only_tokens = {k: v for k, v in MANIFEST.items() if k not in ('styles', 'entry', 'preview')}
    assert packages.read_package(make_zip(only_tokens))['styles'] == []
    only_styles = {**MANIFEST, 'tokens': {}}
    assert packages.read_package(make_zip(only_styles))['tokens'] == {}
    with pytest.raises(PackageError, match='would not change anything'):
        packages.read_package(make_zip({**MANIFEST, 'tokens': {}, 'styles': []}))


@pytest.mark.parametrize('change, message', [
    ({'id': 'rainy'}, 'built-in theme'),
    ({'api': 99}, 'API version 99'),
    ({'colorScheme': 'sepia'}, 'colorScheme'),
    ({'styles': ['missing.css']}, 'not in the package'),
    ({'entry': 'style.css'}, 'must be one of'),
    ({'tokens': {'--bg-primary': 'red; } body { display: none'}}, 'may not hold'),
    ({'tokens': {'--bg-primary': 'url(https://example.com/x.png)'}}, 'may not hold'),
    ({'tokens': {'--bg-primary': 'red !important'}}, 'may not hold'),
    ({'tokens': {'--made-up': 'red'}}, 'not one of Rainy'),
    ({'tokens': {'color': 'red'}}, 'not a token name'),
    ({'tokens': ['--bg-primary']}, '"tokens" must map'),
])
def test_rejects_bad_manifests(change, message):
    with pytest.raises(PackageError, match=message):
        packages.read_package(make_zip({**MANIFEST, **change}))


def test_rejects_malformed_packages():
    with pytest.raises(PackageError):
        packages.read_package(b'not a zip')
    with pytest.raises(PackageError, match='no rainy-theme.json'):
        packages.read_package(make_zip(manifest=None))
    with pytest.raises(PackageError, match='not allowed'):
        packages.read_package(make_zip(extra={'page.html': '<script></script>'}))


# ------------------------------------------------------------ CSS rules

@pytest.mark.parametrize('css', [
    '[data-part~="player-bar"] { display: grid; grid-template-columns: auto 1fr auto; }',
    '@media (min-width: 900px) { [data-part~="sidebar"] { position: fixed; } }',
    '.nav-item::before { display: none; } .song-card:after { opacity: 0 }',
    '.theme-aurora { display: none; } #rainy-theme-layer .x { opacity: 0 }',
    '[data-part~="logo"] { display: none; } [data-part="library-stats"] { visibility: hidden; }',
    '@keyframes in { from { opacity: 0 } to { opacity: 1 } }',
    '.btn::after { content: "} .btn { display: none }"; }',
    '@font-face { font-family: X; src: url(fonts/display.woff2); } .x { background: url("data:image/png;base64,AA") }',
    '.nav-item { &::after { display: none } &:hover { color: red } }',
])
def test_lint_allows(css):
    errors, _warnings = lint_css(css)
    assert errors == []


@pytest.mark.parametrize('css, message', [
    ('.btn { display: none; }', 'could hide'),
    ('[data-part~="transport"] button { visibility: hidden }', 'could hide'),
    ('[data-part~="search"] { opacity: 0 }', 'could hide'),
    ('@media (max-width: 500px) { .control-btn { pointer-events: none } }', 'could hide'),
    ('[data-part~="header"] { & .icon-btn { font-size: 0 } }', 'could hide'),
    ('.nav-item { &.active { display: contents } }', 'could hide'),
    ('.btn { color: red !important }', '!important'),
    ('@import url("more.css");', '@import'),
    ('.x { background: url(https://cdn.example/x.png) }', 'loads from elsewhere'),
    ('.x { background: url(//cdn.example/x.png) }', 'loads from elsewhere'),
])
def test_lint_refuses(css, message):
    errors, _warnings = lint_css(css)
    assert errors and message in errors[0]


def test_lint_warns_about_internal_names_and_unknown_parts():
    _errors, warnings = lint_css('.some-internal-class { color: red } [data-part~="no-such-part"] { color: red }')
    text = ' '.join(warnings)
    assert 'no-such-part' in text and '.some-internal-class' in text
    assert lint_css('.song-card .btn-primary [data-part~="sidebar"] { color: red }') == ([], [])


def test_a_theme_that_hides_controls_is_not_installed():
    with pytest.raises(PackageError, match='could hide'):
        packages.read_package(make_zip(files={**FILES, 'style.css': '.player-bar .control-btn { display: none }'}))


def test_pack_is_deterministic(tmp_path):
    src = tmp_path / 'src'
    (src / 'fonts').mkdir(parents=True)
    (src / packages.MANIFEST_NAME).write_text(json.dumps(MANIFEST))
    for name, body in FILES.items():
        (src / name).write_text(body)
    (src / 'tests').mkdir()
    (src / 'tests' / 'x.test.mjs').write_text('')
    warnings = []
    manifest, data = packages.pack_directory(str(src), warnings=warnings)
    assert manifest['id'] == 'test-theme' and warnings == []
    assert sorted(zipfile.ZipFile(io.BytesIO(data)).namelist()) == sorted([packages.MANIFEST_NAME, *FILES])
    assert packages.pack_directory(str(src))[1] == data


# ------------------------------------------------------------ routes

def test_only_admins_manage(member, admin):
    assert upload(member, make_zip()).status_code == 403
    assert member.patch('/api/themes/test-theme', json={'enabled': False}).status_code == 403
    assert member.delete('/api/themes/test-theme').status_code == 403
    assert member.put('/api/themes/default', json={'id': None}).status_code == 403
    listing = member.get('/api/themes').get_json()
    assert listing['can_manage'] is False and listing['themes'] == []


def test_install_list_and_serve(admin, member, anon_client):
    res = upload(admin, make_zip(extra={'extra.css': '.x { color: red }'}))
    assert res.status_code == 200, res.get_json()
    body = res.get_json()
    theme = body['theme']
    assert body['updated'] is False and body['warnings'] == []
    assert theme['styles'] == [theme['base'] + 'style.css'] and theme['entry'] == theme['base'] + 'index.js'
    assert theme['tokens']['--accent-primary'] == '#e53935' and theme['colorScheme'] == 'light'

    listed = member.get('/api/themes').get_json()
    assert [t['id'] for t in listed['themes']] == ['test-theme'] and listed['default'] is None
    assert 'sha256' not in listed['themes'][0]

    # No session needed for the files: the sign-in screen wears the theme too.
    css = anon_client.get(theme['styles'][0])
    assert css.status_code == 200 and css.mimetype == 'text/css'
    assert 'immutable' in css.headers['Cache-Control'] and css.headers['X-Content-Type-Options'] == 'nosniff'
    assert anon_client.get(theme['base'] + 'fonts/display.woff2').status_code == 200
    assert anon_client.get(theme['base'] + '../../../app.py').status_code == 404
    assert anon_client.get(theme['base'].replace(theme['rev'], '000000000000') + 'style.css').status_code == 404
    # The API itself is not public.
    assert anon_client.get('/api/themes').status_code == 401


def test_install_reports_warnings(admin):
    res = upload(admin, make_zip(files={**FILES, 'style.css': '.made-up-internal { color: red }'}))
    assert res.status_code == 200
    assert any('.made-up-internal' in w for w in res.get_json()['warnings'])


def test_refused_upload_leaves_nothing_behind(admin):
    res = upload(admin, make_zip(files={**FILES, 'style.css': '.btn { display: none }'}))
    assert res.status_code == 400 and 'could hide' in res.get_json()['error']
    assert ThemeModel.get('test-theme') is None
    assert not os.path.exists(os.path.join(packages.Config.THEMES_CACHE_DIR, 'test-theme'))


def test_disable_hides_it_and_stops_serving(admin, member, anon_client):
    theme = upload(admin, make_zip()).get_json()['theme']
    assert admin.put('/api/themes/default', json={'id': 'test-theme'}).get_json()['default'] == 'test-theme'
    assert member.get('/api/themes').get_json()['default'] == 'test-theme'

    assert admin.patch('/api/themes/test-theme', json={'enabled': False}).status_code == 200
    assert member.get('/api/themes').get_json()['themes'] == []
    assert member.get('/api/themes').get_json()['default'] is None
    assert [t['enabled'] for t in admin.get('/api/themes').get_json()['themes']] == [False]
    assert anon_client.get(theme['styles'][0]).status_code == 404
    # The default does not come back on its own.
    admin.patch('/api/themes/test-theme', json={'enabled': True})
    assert member.get('/api/themes').get_json()['default'] is None


def test_default_must_be_an_enabled_theme(admin):
    assert admin.put('/api/themes/default', json={'id': 'nope'}).status_code == 404
    assert admin.put('/api/themes/default', json={'id': 7}).status_code == 400
    upload(admin, make_zip())
    assert admin.put('/api/themes/default', json={'id': 'test-theme'}).status_code == 200
    assert admin.put('/api/themes/default', json={'id': None}).get_json()['default'] is None


def test_update_and_remove(admin, anon_client):
    first = upload(admin, make_zip()).get_json()['theme']
    admin.put('/api/themes/default', json={'id': 'test-theme'})
    res = upload(admin, make_zip({**MANIFEST, 'version': '1.1.0'}, files={**FILES, 'style.css': '.x { color: blue }'}))
    body = res.get_json()
    assert body['updated'] is True and body['previous_version'] == '1.0.0'
    assert body['theme']['rev'] != first['rev']
    assert anon_client.get(first['styles'][0]).status_code == 404
    assert anon_client.get(body['theme']['styles'][0]).status_code == 200

    assert admin.delete('/api/themes/test-theme').status_code == 200
    assert ThemeModel.get('test-theme') is None and ThemeModel.get_default() is None
    assert not os.path.exists(os.path.join(packages.Config.THEMES_CACHE_DIR, 'test-theme'))
    assert admin.delete('/api/themes/test-theme').status_code == 404


def test_cache_is_rebuilt_when_wiped(admin, anon_client):
    import shutil
    theme = upload(admin, make_zip()).get_json()['theme']
    shutil.rmtree(packages.Config.THEMES_CACHE_DIR)
    assert anon_client.get(theme['styles'][0]).status_code == 200


def test_development_folder(admin, anon_client, monkeypatch, tmp_path):
    dev = tmp_path / 'dev'
    src = dev / 'my-theme'
    (src / 'fonts').mkdir(parents=True)
    (src / packages.MANIFEST_NAME).write_text(json.dumps({**MANIFEST, 'id': 'my-theme'}))
    for name, body in FILES.items():
        (src / name).write_text(body)
    # Another kind's package in the same folder, and a broken theme: both left out.
    (dev / 'an-environment').mkdir()
    (dev / 'an-environment' / 'rainy-environment.json').write_text('{}')
    (dev / 'broken').mkdir()
    (dev / 'broken' / packages.MANIFEST_NAME).write_text('{')
    monkeypatch.setattr(packages.Config, 'THEMES_DEV_DIR', str(dev))

    listed = admin.get('/api/themes').get_json()['themes']
    assert [(t['id'], t['dev']) for t in listed] == [('my-theme', True)]
    res = anon_client.get(listed[0]['styles'][0])
    assert res.status_code == 200 and res.headers['Cache-Control'] == 'no-store'
