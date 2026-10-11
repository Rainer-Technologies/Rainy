"""Light show environment packages: validation, install/remove routes and file serving."""
import io
import json
import os
import zipfile

import pytest

import app as app_module
from conftest import sign_in
from models.environment import EnvironmentModel
from models.user import UserModel
from utils import environments as packages
from utils.environments import PackageError

MANIFEST = {
    'manifest': 1, 'api': 1, 'id': 'test-env', 'name': 'Test Env', 'version': '1.0.0',
    'description': 'For the tests', 'author': 'Rainy', 'entry': 'index.js',
    'styles': ['style.css'], 'layout': 'immersive', 'requires': ['webgl2'],
    'i18n': {'es': {'name': 'Entorno de prueba'}},
}
FILES = {
    'index.js': 'export default class { mount() {} unmount() {} update() {} render() {} }\n',
    'style.css': '.x { color: red }\n',
    'lib/util.js': 'export const one = 1;\n',
}


def make_zip(manifest=MANIFEST, files=FILES, prefix='', extra=None, links=()):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        if manifest is not None:
            zf.writestr(prefix + packages.MANIFEST_NAME, json.dumps(manifest))
        for name, body in {**files, **(extra or {})}.items():
            zf.writestr(prefix + name if not name.startswith(('/', '..')) else name, body)
        for name in links:
            info = zipfile.ZipInfo(prefix + name)
            info.external_attr = 0o120777 << 16
            zf.writestr(info, '/etc/passwd')
    return buf.getvalue()


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    # Keep the before_request hooks from spinning up real background workers.
    for flag in ('_import_worker_started', '_enrichment_worker_started',
                 '_sync_worker_started', '_lightshow_worker_started', '_lyrics_worker_started'):
        monkeypatch.setattr(app_module, flag, True)
    monkeypatch.setattr(packages.Config, 'ENVIRONMENTS_CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setattr(packages.Config, 'ENVIRONMENTS_DEV_DIR', None)
    yield
    for row in EnvironmentModel.list_all(include_disabled=True):
        EnvironmentModel.delete(row['id'])


@pytest.fixture
def admin(app):
    c = app.test_client()
    sign_in(c, 1)
    return c


@pytest.fixture
def member(app):
    email = 'env-test-member@example.test'
    user = UserModel.get_user_by_email(email)
    uid = user['id'] if user else UserModel.create_user('env-test-member', email, 'not-a-real-password', role='user')
    c = app.test_client()
    sign_in(c, uid)
    yield c
    UserModel.delete_user(uid)


def upload(client, data, name='env.zip'):
    return client.post('/api/environments', data={'package': (io.BytesIO(data), name)},
                       content_type='multipart/form-data')


# ------------------------------------------------------------ validation

def test_reads_a_good_package():
    manifest = packages.read_package(make_zip())
    assert manifest['id'] == 'test-env' and manifest['entry'] == 'index.js'
    assert manifest['styles'] == ['style.css'] and manifest['layout'] == 'immersive'
    assert manifest['i18n'] == {'es': {'name': 'Entorno de prueba'}}


def test_accepts_one_wrapping_folder():
    assert packages.read_package(make_zip(prefix='test-env-main/'))['id'] == 'test-env'


def test_ignores_what_archivers_add():
    data = make_zip(extra={'__MACOSX/._index.js': 'x', '.DS_Store': 'x', '.git/config': 'x'})
    assert packages.read_package(data)['id'] == 'test-env'


@pytest.mark.parametrize('change, message', [
    ({'id': 'classic'}, 'built-in'),
    ({'id': 'Bad Id'}, '"id"'),
    ({'api': 99}, 'API version 99'),
    ({'api': None}, '"api"'),
    ({'manifest': 2}, 'manifest version'),
    ({'version': 'one'}, '"version"'),
    ({'entry': 'missing.js'}, 'not in the package'),
    ({'entry': 'style.css'}, '"entry"'),
    ({'styles': ['index.js']}, '"styles"'),
    ({'layout': 'sideways'}, '"layout"'),
    ({'requires': ['quantum']}, '"requires"'),
    ({'name': ''}, '"name"'),
    ({'homepage': 'javascript:alert(1)'}, '"homepage"'),
])
def test_rejects_a_bad_manifest(change, message):
    with pytest.raises(PackageError, match=message):
        packages.read_package(make_zip({**MANIFEST, **change}))


def test_rejects_malformed_packages():
    with pytest.raises(PackageError, match='not a zip'):
        packages.read_package(b'not a zip at all')
    with pytest.raises(PackageError, match='no rainy-environment.json'):
        packages.read_package(make_zip(manifest=None))
    with pytest.raises(PackageError, match='outside its own folder'):
        packages.read_package(make_zip(extra={'../evil.js': 'x'}))
    with pytest.raises(PackageError, match='absolute path'):
        packages.read_package(make_zip(extra={'/etc/evil.js': 'x'}))
    with pytest.raises(PackageError, match='not allowed'):
        packages.read_package(make_zip(extra={'run.sh': 'x'}))
    with pytest.raises(PackageError, match='not allowed'):
        packages.read_package(make_zip(extra={'page.html': '<script></script>'}))
    with pytest.raises(PackageError, match='link'):
        packages.read_package(make_zip(links=['passwd.txt']))


def test_rejects_oversized_packages(monkeypatch):
    monkeypatch.setattr(packages, 'MAX_UNPACKED_BYTES', 1000)
    with pytest.raises(PackageError, match='unpacks to more'):
        packages.read_package(make_zip(extra={'big.txt': 'x' * 5000}))
    monkeypatch.setattr(packages, 'MAX_FILES', 3)
    with pytest.raises(PackageError, match='more than 3 files'):
        packages.read_package(make_zip())
    monkeypatch.setattr(packages, 'MAX_ZIP_BYTES', 10)
    with pytest.raises(PackageError, match='larger than'):
        packages.read_package(make_zip())


def test_packs_a_folder_the_same_way_every_time(tmp_path):
    src = tmp_path / 'src'
    (src / 'lib').mkdir(parents=True)
    (src / 'tests').mkdir()
    (src / packages.MANIFEST_NAME).write_text(json.dumps(MANIFEST))
    for name, body in FILES.items():
        (src / name).write_text(body)
    (src / 'tests' / 'thing.test.mjs').write_text('// not shipped')
    (src / '.hidden').write_text('x')
    manifest, data = packages.pack_directory(str(src))
    assert manifest['id'] == 'test-env'
    assert sorted(zipfile.ZipFile(io.BytesIO(data)).namelist()) == sorted([packages.MANIFEST_NAME, *FILES])
    assert packages.pack_directory(str(src))[1] == data


# ---------------------------------------------------------------- routes

def test_only_administrators_manage(member, anon_client):
    assert anon_client.get('/api/environments').status_code == 401
    assert upload(member, make_zip()).status_code == 403
    assert member.patch('/api/environments/test-env', json={'enabled': False}).status_code == 403
    assert member.delete('/api/environments/test-env').status_code == 403
    assert EnvironmentModel.get('test-env') is None


def test_install_list_and_serve(admin, member):
    res = upload(admin, make_zip())
    assert res.status_code == 200, res.get_json()
    body = res.get_json()
    env = body['environment']
    assert body['updated'] is False and env['id'] == 'test-env' and env['enabled'] is True
    assert env['entry'].startswith('/environments/test-env/') and env['entry'].endswith('/index.js')
    assert env['styles'] == [env['base'] + 'style.css'] and env['size'] > 0

    listed = member.get('/api/environments').get_json()
    assert listed['can_manage'] is False and [e['id'] for e in listed['environments']] == ['test-env']
    assert 'sha256' not in listed['environments'][0]
    assert admin.get('/api/environments').get_json()['can_manage'] is True

    js = member.get(env['entry'])
    assert js.status_code == 200 and js.mimetype == 'text/javascript'
    assert 'immutable' in js.headers['Cache-Control'] and js.headers['X-Content-Type-Options'] == 'nosniff'
    assert member.get(env['base'] + 'lib/util.js').status_code == 200
    assert member.get(env['styles'][0]).mimetype == 'text/css'


def test_files_stay_inside_the_package(admin, anon_client):
    env = upload(admin, make_zip()).get_json()['environment']
    assert anon_client.get(env['entry']).status_code == 401
    for path in ('../../../app.py', '..%2f..%2fconfig.py', 'lib/../../x', '.hidden', 'nothing.js'):
        assert admin.get(env['base'] + path).status_code == 404, path
    assert admin.get('/environments/test-env/000000000000/index.js').status_code == 404
    assert admin.get('/environments/nope/abc/index.js').status_code == 404


def test_rejected_upload_installs_nothing(admin):
    res = upload(admin, make_zip({**MANIFEST, 'api': 99}))
    assert res.status_code == 400 and 'API version 99' in res.get_json()['error']
    assert upload(admin, b'junk').status_code == 400
    assert admin.post('/api/environments', data={}, content_type='multipart/form-data').status_code == 400
    assert EnvironmentModel.get('test-env') is None


def test_update_replaces_the_package(admin):
    first = upload(admin, make_zip()).get_json()['environment']
    admin.patch('/api/environments/test-env', json={'enabled': False})
    newer = make_zip({**MANIFEST, 'version': '1.1.0'}, {**FILES, 'index.js': 'export default class {}\n'})
    body = upload(admin, newer).get_json()
    assert body['updated'] is True and body['previous_version'] == '1.0.0'
    second = body['environment']
    assert second['version'] == '1.1.0' and second['base'] != first['base']
    # An update does not switch a disabled environment back on.
    assert second['enabled'] is False
    admin.patch('/api/environments/test-env', json={'enabled': True})
    assert admin.get(second['entry']).get_data(as_text=True) == 'export default class {}\n'
    assert admin.get(first['entry']).status_code == 404
    assert len(EnvironmentModel.list_all(include_disabled=True)) == 1


def test_disable_hides_it_from_everyone_else(admin, member):
    env = upload(admin, make_zip()).get_json()['environment']
    assert admin.patch('/api/environments/test-env', json={'enabled': False}).get_json()['environment']['enabled'] is False
    assert member.get('/api/environments').get_json()['environments'] == []
    assert member.get(env['entry']).status_code == 404
    assert [e['enabled'] for e in admin.get('/api/environments').get_json()['environments']] == [False]
    assert admin.patch('/api/environments/test-env', json={}).status_code == 400
    assert admin.patch('/api/environments/nope', json={'enabled': True}).status_code == 404


def test_remove(admin):
    env = upload(admin, make_zip()).get_json()['environment']
    assert admin.delete('/api/environments/test-env').get_json()['success'] is True
    assert admin.get(env['entry']).status_code == 404
    assert admin.get('/api/environments').get_json()['environments'] == []
    assert not os.path.exists(os.path.join(packages.Config.ENVIRONMENTS_CACHE_DIR, 'test-env'))
    assert admin.delete('/api/environments/test-env').status_code == 404


def test_files_come_back_when_the_cache_is_wiped(admin):
    import shutil
    env = upload(admin, make_zip()).get_json()['environment']
    shutil.rmtree(packages.Config.ENVIRONMENTS_CACHE_DIR)
    assert admin.get(env['entry']).status_code == 200
    assert admin.get(env['base'] + 'lib/util.js').status_code == 200


def test_development_folder_is_served_as_it_is(admin, monkeypatch, tmp_path):
    src = tmp_path / 'dev' / 'thing'
    src.mkdir(parents=True)
    (src / packages.MANIFEST_NAME).write_text(json.dumps({**MANIFEST, 'styles': []}))
    (src / 'index.js').write_text('export default class A {}\n')
    (tmp_path / 'dev' / 'broken').mkdir()
    (tmp_path / 'dev' / 'broken' / packages.MANIFEST_NAME).write_text('{')
    monkeypatch.setattr(packages.Config, 'ENVIRONMENTS_DEV_DIR', str(tmp_path / 'dev'))

    upload(admin, make_zip())     # the folder stands in for the installed package of the same id
    listed = admin.get('/api/environments').get_json()['environments']
    assert len(listed) == 1 and listed[0]['dev'] is True and '/dev-' in listed[0]['base']
    res = admin.get(listed[0]['entry'])
    assert res.get_data(as_text=True) == 'export default class A {}\n' and res.headers['Cache-Control'] == 'no-store'
    (src / 'index.js').write_text('export default class B {}\n')
    assert 'class B' in admin.get(listed[0]['entry']).get_data(as_text=True)
