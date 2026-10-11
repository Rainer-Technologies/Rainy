"""Light show environment packages.

An environment is a kind of light show that runs in the browser (see
static/js/lightshow/environments/). Besides the built-in one, a server can
have more installed as packages: a zip holding a ``rainy-environment.json``
manifest, an ES module entry point and whatever files it needs
(docs/ENVIRONMENTS.md).

This module is everything about a package that does not need the database:
reading and validating one, packing a folder into one, and unpacking it to
the directory its files are served from. A package's code runs in the page of
every user of the server, so only an administrator may install one; the
checks here keep a package well formed and its files inside its own folder,
they do not make an untrusted package safe.
"""
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile

from config import Config

MANIFEST_NAME = 'rainy-environment.json'
MANIFEST_VERSION = 1
# Versions of the environment contract this server's frontend speaks
# (API_VERSION in static/js/lightshow/sdk.js).
API_VERSIONS = (1,)

MAX_ZIP_BYTES = 20 * 1024 * 1024
MAX_UNPACKED_BYTES = 60 * 1024 * 1024
MAX_FILES = 500

RESERVED_IDS = {'classic'}
LAYOUTS = ('stage', 'immersive')
REQUIRES = ('webgl', 'webgl2', 'webgpu')

_ID = re.compile(r'^[a-z][a-z0-9-]{1,31}$')
_VERSION = re.compile(r'^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$')
_LANG = re.compile(r'^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$')
_SEGMENT = re.compile(r'^[A-Za-z0-9_@+()\[\] -][A-Za-z0-9_.@+()\[\] -]*$')

# What a package may contain, and how each kind is served.
MIME_TYPES = {
    '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.glsl': 'text/plain', '.vert': 'text/plain', '.frag': 'text/plain', '.wgsl': 'text/plain',
    '.txt': 'text/plain', '.md': 'text/plain', '': 'text/plain',
    '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
}
_SCRIPT_EXT = ('.js', '.mjs')
_IMAGE_EXT = ('.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg')
# Left out of a package without complaint: what archivers and repositories add on their own.
_IGNORED_DIRS = {'__MACOSX', 'node_modules'}


class PackageError(ValueError):
    """The package is not one this server can install (the message is shown to the administrator)."""


# ---------------------------------------------------------------- paths

def _clean_path(name):
    """A zip entry's name as a safe relative path, or None for one that is left out."""
    if '\\' in name or '\x00' in name:
        raise PackageError(f'Invalid file name in the package: {name!r}')
    if name.startswith('/') or re.match(r'^[A-Za-z]:', name):
        raise PackageError(f'The package holds an absolute path: {name!r}')
    parts = [p for p in name.split('/') if p != '']
    if not parts:
        return None
    for part in parts:
        if part in ('.', '..'):
            raise PackageError(f'The package reaches outside its own folder: {name!r}')
    if any(p.startswith('.') or p in _IGNORED_DIRS for p in parts):
        return None
    if parts[-1] in ('Thumbs.db', 'desktop.ini'):
        return None
    for part in parts:
        if not _SEGMENT.match(part) or len(part) > 100:
            raise PackageError(f'Invalid file name in the package: {name!r}')
    return '/'.join(parts)


def _check_extension(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in MIME_TYPES:
        raise PackageError(f'Files of type "{ext}" are not allowed in a package: {path}')


def mime_type(path):
    return MIME_TYPES.get(os.path.splitext(path)[1].lower(), 'application/octet-stream')


def _strip_common_folder(paths):
    """Repository downloads wrap everything in one folder: find it, if the manifest is not at the root."""
    if MANIFEST_NAME in paths:
        return ''
    tops = {p.split('/', 1)[0] for p in paths}
    if len(tops) == 1 and all('/' in p for p in paths):
        top = next(iter(tops))
        if f'{top}/{MANIFEST_NAME}' in paths:
            return top + '/'
    raise PackageError(f'The package has no {MANIFEST_NAME} at its root.')


# ------------------------------------------------------------- manifest

def _text(data, key, limit, required=False):
    value = data.get(key)
    if value is None or value == '':
        if required:
            raise PackageError(f'The manifest is missing "{key}".')
        return ''
    if not isinstance(value, str):
        raise PackageError(f'"{key}" in the manifest must be text.')
    value = ' '.join(value.split())
    if len(value) > limit:
        raise PackageError(f'"{key}" in the manifest is too long (at most {limit} characters).')
    return value


def _file(data, key, files, extensions, required=False):
    value = data.get(key)
    if value is None or value == '':
        if required:
            raise PackageError(f'The manifest is missing "{key}".')
        return None
    if not isinstance(value, str):
        raise PackageError(f'"{key}" in the manifest must be a file path.')
    path = value[2:] if value.startswith('./') else value
    if path not in files:
        raise PackageError(f'"{key}" names a file that is not in the package: {value}')
    if not path.lower().endswith(extensions):
        raise PackageError(f'"{key}" must be one of {", ".join(extensions)}: {value}')
    return path


def validate_manifest(data, files):
    """Check a parsed manifest against the files of its package.

    Returns the manifest as this server stores it: known fields only, in
    their normal form. Raises PackageError with a message for the author.
    """
    if not isinstance(data, dict):
        raise PackageError('The manifest must be a JSON object.')
    if data.get('manifest') != MANIFEST_VERSION:
        raise PackageError(f'Unsupported manifest version: {data.get("manifest")!r} (this server reads version {MANIFEST_VERSION}).')
    api = data.get('api')
    if isinstance(api, bool) or not isinstance(api, int):
        raise PackageError('The manifest must say which "api" version the environment was written for.')
    if api not in API_VERSIONS:
        raise PackageError(f'This environment was written for API version {api}; '
                           f'this server supports {", ".join(str(v) for v in API_VERSIONS)}.')

    env_id = data.get('id')
    if not isinstance(env_id, str) or not _ID.match(env_id):
        raise PackageError('"id" must be 2 to 32 characters: lowercase letters, digits and hyphens, starting with a letter.')
    if env_id in RESERVED_IDS:
        raise PackageError(f'"{env_id}" is the id of a built-in environment.')
    version = data.get('version')
    if not isinstance(version, str) or not _VERSION.match(version):
        raise PackageError('"version" must look like 1.2.3.')

    layout = data.get('layout', 'stage')
    if layout not in LAYOUTS:
        raise PackageError(f'"layout" must be one of: {", ".join(LAYOUTS)}.')
    requires = data.get('requires', [])
    if not isinstance(requires, list) or any(r not in REQUIRES for r in requires):
        raise PackageError(f'"requires" may list: {", ".join(REQUIRES)}.')

    styles = data.get('styles', [])
    if not isinstance(styles, list) or len(styles) > 8:
        raise PackageError('"styles" must be a list of at most 8 stylesheets.')
    homepage = _text(data, 'homepage', 300)
    if homepage and not re.match(r'^https?://', homepage):
        raise PackageError('"homepage" must be an http(s) address.')

    i18n = {}
    raw = data.get('i18n', {})
    if not isinstance(raw, dict):
        raise PackageError('"i18n" must map a language to its texts.')
    for lang, texts in raw.items():
        if not isinstance(lang, str) or not _LANG.match(lang) or not isinstance(texts, dict):
            raise PackageError('"i18n" must map a language code to { "name", "description" }.')
        entry = {k: _text(texts, k, 300) for k in ('name', 'description')}
        i18n[lang] = {k: v for k, v in entry.items() if v}

    return {
        'manifest': MANIFEST_VERSION,
        'api': api,
        'id': env_id,
        'name': _text(data, 'name', 60, required=True),
        'version': version,
        'description': _text(data, 'description', 300),
        'author': _text(data, 'author', 80),
        'license': _text(data, 'license', 60),
        'homepage': homepage,
        'entry': _file(data, 'entry', files, _SCRIPT_EXT, required=True),
        'styles': [_file({'styles': s}, 'styles', files, ('.css',), required=True) for s in styles],
        'preview': _file(data, 'preview', files, _IMAGE_EXT),
        'layout': layout,
        'requires': sorted(set(requires)),
        'i18n': i18n,
    }


def _parse_manifest(raw):
    try:
        return json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as e:
        raise PackageError(f'{MANIFEST_NAME} is not valid JSON: {e}') from None


# ------------------------------------------------------------- packages

def _entries(zf):
    """The files of an open package as {clean relative path: ZipInfo}, checked for size and shape."""
    found = {}
    total = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        mode = info.external_attr >> 16
        if mode and stat.S_ISLNK(mode):
            raise PackageError(f'The package holds a link, which is not allowed: {info.filename}')
        path = _clean_path(info.filename)
        if path is None:
            continue
        if path in found:
            raise PackageError(f'The package holds the same file twice: {path}')
        total += info.file_size
        if total > MAX_UNPACKED_BYTES:
            raise PackageError(f'The package unpacks to more than {MAX_UNPACKED_BYTES // (1024 * 1024)} MB.')
        found[path] = info
        if len(found) > MAX_FILES:
            raise PackageError(f'The package holds more than {MAX_FILES} files.')
    if not found:
        raise PackageError('The package is empty.')
    prefix = _strip_common_folder(found)
    files = {path[len(prefix):]: info for path, info in found.items()}
    for path in files:
        _check_extension(path)
    return files


def _open(data):
    if len(data) > MAX_ZIP_BYTES:
        raise PackageError(f'The package is larger than {MAX_ZIP_BYTES // (1024 * 1024)} MB.')
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise PackageError('The file is not a zip archive.') from None


def read_package(data):
    """Validate a package (the bytes of its zip) and return its manifest."""
    with _open(data) as zf:
        files = _entries(zf)
        with zf.open(files[MANIFEST_NAME]) as fh:
            raw = fh.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise PackageError(f'{MANIFEST_NAME} is too large.')
        return validate_manifest(_parse_manifest(raw), files)


def package_digest(data):
    return hashlib.sha256(data).hexdigest()


def extract_package(data, dest):
    """Unpack a validated package into ``dest`` (created; replaced whole if it exists)."""
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='.unpack-', dir=parent)
    try:
        with _open(data) as zf:
            for path, info in _entries(zf).items():
                target = os.path.join(tmp, *path.split('/'))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info) as src, open(target, 'wb') as out:
                    shutil.copyfileobj(src, out)
        if os.path.isdir(dest):
            shutil.rmtree(dest, ignore_errors=True)
        os.replace(tmp, dest)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


# ----------------------------------------------------------- directories

def _walk(directory, exclude=()):
    """Files of an unpacked package as {relative path: absolute path}."""
    files = {}
    for root, dirs, names in os.walk(directory):
        rel_root = os.path.relpath(root, directory).replace(os.sep, '/')
        rel_root = '' if rel_root == '.' else rel_root + '/'
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in _IGNORED_DIRS
                         and (rel_root + d) not in exclude)
        for name in sorted(names):
            if os.path.islink(os.path.join(root, name)):
                continue
            path = _clean_path(rel_root + name)
            if path is not None:
                files[path] = os.path.join(root, name)
    return files


def read_directory(directory):
    """Validate an unpacked package and return (manifest, files)."""
    files = _walk(directory)
    if MANIFEST_NAME not in files:
        raise PackageError(f'{directory} has no {MANIFEST_NAME}.')
    with open(files[MANIFEST_NAME], 'rb') as fh:
        manifest = validate_manifest(_parse_manifest(fh.read()), files)
    return manifest, files


def pack_directory(directory, exclude=('tests',)):
    """Zip an unpacked package. Returns (manifest, bytes of the zip).

    The archive is the same byte for byte for the same files, so a package's
    digest only changes when its contents do.
    """
    files = _walk(directory, exclude=set(exclude))
    for path in files:
        _check_extension(path)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(files):
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(files[path], 'rb') as fh:
                zf.writestr(info, fh.read())
    data = buf.getvalue()
    return read_package(data), data


# ----------------------------------------------------------------- cache

def revision(digest):
    """The part of a package's digest that goes in its URLs."""
    return digest[:12]


def cache_dir(env_id, digest):
    return os.path.join(Config.ENVIRONMENTS_CACHE_DIR, env_id, revision(digest))


def ensure_unpacked(env_id, digest, load_package):
    """The directory an installed package's files are served from.

    The zip in the database is what is installed; this folder is only a copy
    of it, unpacked again whenever it is missing (a new container, a wiped
    data folder). ``load_package`` returns the zip's bytes.
    """
    dest = cache_dir(env_id, digest)
    if os.path.isfile(os.path.join(dest, MANIFEST_NAME)):
        return dest
    data = load_package()
    if not data:
        return None
    extract_package(bytes(data), dest)
    prune_cache(env_id, keep=digest)
    return dest


def prune_cache(env_id, keep=None):
    """Drop the unpacked copies of an environment (all but the revision in ``keep``)."""
    base = os.path.join(Config.ENVIRONMENTS_CACHE_DIR, env_id)
    if not os.path.isdir(base):
        return
    for name in os.listdir(base):
        if keep and name == revision(keep):
            continue
        shutil.rmtree(os.path.join(base, name), ignore_errors=True)
    if not keep:
        shutil.rmtree(base, ignore_errors=True)


# ------------------------------------------------------------ development

def dev_packages():
    """Unpacked packages served straight from RAINY_ENVIRONMENTS_DEV (development only).

    Returns {id: (manifest, directory, revision)}; a folder that does not
    validate is reported on the console and left out.
    """
    base = Config.ENVIRONMENTS_DEV_DIR
    found = {}
    if not base or not os.path.isdir(base):
        return found
    for name in sorted(os.listdir(base)):
        directory = os.path.join(base, name)
        if not os.path.isfile(os.path.join(directory, MANIFEST_NAME)):
            continue
        try:
            manifest, files = read_directory(directory)
        except PackageError as e:
            print(f'Environment package {name} skipped: {e}')
            continue
        newest = max(int(os.path.getmtime(p)) for p in files.values())
        found[manifest['id']] = (manifest, directory, f'dev-{newest:x}')
    return found
