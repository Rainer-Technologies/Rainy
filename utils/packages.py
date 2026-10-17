"""Installable packages: what light show environments and UI themes share.

A package is a zip holding a manifest (``rainy-environment.json``,
``rainy-theme.json``) and the files it names. This module is everything about
one that does not depend on its kind or need the database: reading and
checking a zip, packing a folder into one, unpacking it to the directory its
files are served from, and finding the folders being developed. Each kind
(utils/environments.py, utils/themes.py) is a PackageKind: its manifest, how
to check it, its limits and its folders.

A package's code and styles run in the page of every user of the server, so
only an administrator may install one. The checks here keep a package well
formed and its files inside its own folder; they do not make an untrusted
package safe.
"""
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import zipfile

from config import Config

ID_PATTERN = re.compile(r'^[a-z][a-z0-9-]{1,31}$')
VERSION_PATTERN = re.compile(r'^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$')
LANG_PATTERN = re.compile(r'^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$')
_SEGMENT = re.compile(r'^[A-Za-z0-9_@+()\[\] -][A-Za-z0-9_.@+()\[\] -]*$')

# What a package may contain, and how each kind of file is served.
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
SCRIPT_EXT = ('.js', '.mjs')
IMAGE_EXT = ('.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg')
# Left out of a package without complaint: what archivers and repositories add on their own.
_IGNORED_DIRS = {'__MACOSX', 'node_modules'}


class PackageError(ValueError):
    """The package is not one this server can install (the message is shown to the administrator)."""


# ---------------------------------------------------------------- paths

def clean_path(name):
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


def check_extension(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in MIME_TYPES:
        raise PackageError(f'Files of type "{ext}" are not allowed in a package: {path}')


def mime_type(path):
    return MIME_TYPES.get(os.path.splitext(path)[1].lower(), 'application/octet-stream')


def package_digest(data):
    return hashlib.sha256(data).hexdigest()


def revision(digest):
    """The part of a package's digest that goes in its URLs."""
    return digest[:12]


# ------------------------------------------------------------- manifest fields

def text_field(data, key, limit, required=False):
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


def file_field(data, key, files, extensions, required=False):
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


def common_fields(data, kind, reserved_ids, api_versions, manifest_version=1):
    """The fields every manifest has, checked: (manifest version, api, id, version, homepage, i18n)."""
    if not isinstance(data, dict):
        raise PackageError('The manifest must be a JSON object.')
    if data.get('manifest') != manifest_version:
        raise PackageError(f'Unsupported manifest version: {data.get("manifest")!r} '
                           f'(this server reads version {manifest_version}).')
    api = data.get('api')
    if isinstance(api, bool) or not isinstance(api, int):
        raise PackageError(f'The manifest must say which "api" version the {kind} was written for.')
    if api not in api_versions:
        raise PackageError(f'This {kind} was written for API version {api}; '
                           f'this server supports {", ".join(str(v) for v in api_versions)}.')
    pkg_id = data.get('id')
    if not isinstance(pkg_id, str) or not ID_PATTERN.match(pkg_id):
        raise PackageError('"id" must be 2 to 32 characters: lowercase letters, digits and hyphens, starting with a letter.')
    if pkg_id in reserved_ids:
        raise PackageError(f'"{pkg_id}" is the id of a built-in {kind}.')
    version = data.get('version')
    if not isinstance(version, str) or not VERSION_PATTERN.match(version):
        raise PackageError('"version" must look like 1.2.3.')
    homepage = text_field(data, 'homepage', 300)
    if homepage and not re.match(r'^https?://', homepage):
        raise PackageError('"homepage" must be an http(s) address.')
    i18n = {}
    raw = data.get('i18n', {})
    if not isinstance(raw, dict):
        raise PackageError('"i18n" must map a language to its texts.')
    for lang, texts in raw.items():
        if not isinstance(lang, str) or not LANG_PATTERN.match(lang) or not isinstance(texts, dict):
            raise PackageError('"i18n" must map a language code to { "name", "description" }.')
        entry = {k: text_field(texts, k, 300) for k in ('name', 'description')}
        i18n[lang] = {k: v for k, v in entry.items() if v}
    return {
        'manifest': manifest_version,
        'api': api,
        'id': pkg_id,
        'name': text_field(data, 'name', 60, required=True),
        'version': version,
        'description': text_field(data, 'description', 300),
        'author': text_field(data, 'author', 80),
        'license': text_field(data, 'license', 60),
        'homepage': homepage,
        'i18n': i18n,
    }


def parse_manifest(raw, manifest_name):
    try:
        return json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as e:
        raise PackageError(f'{manifest_name} is not valid JSON: {e}') from None


_locks = {}
_locks_guard = threading.Lock()


def _unpack_lock(path):
    with _locks_guard:
        return _locks.setdefault(path, threading.Lock())


# ------------------------------------------------------------------ kinds

class PackageKind:
    """One kind of package.

    ``validate(data, files)`` checks a parsed manifest against the package's
    files and returns it as the server stores it. ``inspect(manifest, read)``
    (optional) looks inside the files the manifest names (``read(path)`` gives
    their bytes) and returns warnings; it raises PackageError for what must
    not be installed. ``limits`` is the module holding MAX_ZIP_BYTES,
    MAX_UNPACKED_BYTES and MAX_FILES, read on every call so they can be
    changed (tests do). ``cache_attr`` and ``dev_attr`` name the Config
    settings of the kind's folders.
    """

    def __init__(self, *, label, manifest_name, validate, limits, cache_attr, dev_attr, inspect=None):
        self.label = label
        self.manifest_name = manifest_name
        self.validate = validate
        self.inspect = inspect
        self.limits = limits
        self.cache_attr = cache_attr
        self.dev_attr = dev_attr

    # -- zips

    def _strip_common_folder(self, paths):
        """Repository downloads wrap everything in one folder: find it, if the manifest is not at the root."""
        if self.manifest_name in paths:
            return ''
        tops = {p.split('/', 1)[0] for p in paths}
        if len(tops) == 1 and all('/' in p for p in paths):
            top = next(iter(tops))
            if f'{top}/{self.manifest_name}' in paths:
                return top + '/'
        raise PackageError(f'The package has no {self.manifest_name} at its root.')

    def _entries(self, zf):
        """The files of an open package as {clean relative path: ZipInfo}, checked for size and shape."""
        max_unpacked, max_files = self.limits.MAX_UNPACKED_BYTES, self.limits.MAX_FILES
        found = {}
        total = 0
        for info in zf.infolist():
            if info.is_dir():
                continue
            mode = info.external_attr >> 16
            if mode and stat.S_ISLNK(mode):
                raise PackageError(f'The package holds a link, which is not allowed: {info.filename}')
            path = clean_path(info.filename)
            if path is None:
                continue
            if path in found:
                raise PackageError(f'The package holds the same file twice: {path}')
            total += info.file_size
            if total > max_unpacked:
                raise PackageError(f'The package unpacks to more than {max_unpacked // (1024 * 1024)} MB.')
            found[path] = info
            if len(found) > max_files:
                raise PackageError(f'The package holds more than {max_files} files.')
        if not found:
            raise PackageError('The package is empty.')
        prefix = self._strip_common_folder(found)
        files = {path[len(prefix):]: info for path, info in found.items()}
        for path in files:
            check_extension(path)
        return files

    def _open(self, data):
        max_zip = self.limits.MAX_ZIP_BYTES
        if len(data) > max_zip:
            raise PackageError(f'The package is larger than {max_zip // (1024 * 1024)} MB.')
        try:
            return zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise PackageError('The file is not a zip archive.') from None

    def _check(self, raw_manifest, files, read, warnings):
        manifest = self.validate(parse_manifest(raw_manifest, self.manifest_name), files)
        if self.inspect:
            found = self.inspect(manifest, read) or []
            if warnings is not None:
                warnings.extend(found)
        return manifest

    def read_package(self, data, warnings=None):
        """Validate a package (the bytes of its zip) and return its manifest.

        Pass a list as ``warnings`` to collect what is allowed but worth fixing.
        """
        with self._open(data) as zf:
            files = self._entries(zf)
            with zf.open(files[self.manifest_name]) as fh:
                raw = fh.read(256 * 1024 + 1)
            if len(raw) > 256 * 1024:
                raise PackageError(f'{self.manifest_name} is too large.')

            def read(path):
                with zf.open(files[path]) as f:
                    return f.read()
            return self._check(raw, files, read, warnings)

    def extract_package(self, data, dest):
        """Unpack a validated package into ``dest`` (created; replaced whole if it exists)."""
        parent = os.path.dirname(dest)
        os.makedirs(parent, exist_ok=True)
        tmp = tempfile.mkdtemp(prefix='.unpack-', dir=parent)
        try:
            with self._open(data) as zf:
                for path, info in self._entries(zf).items():
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

    # -- folders

    @staticmethod
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
                path = clean_path(rel_root + name)
                if path is not None:
                    files[path] = os.path.join(root, name)
        return files

    def read_directory(self, directory, warnings=None):
        """Validate an unpacked package and return (manifest, files)."""
        files = self._walk(directory)
        if self.manifest_name not in files:
            raise PackageError(f'{directory} has no {self.manifest_name}.')
        with open(files[self.manifest_name], 'rb') as fh:
            raw = fh.read()

        def read(path):
            with open(files[path], 'rb') as f:
                return f.read()
        return self._check(raw, files, read, warnings), files

    def pack_directory(self, directory, exclude=('tests',), warnings=None):
        """Zip an unpacked package. Returns (manifest, bytes of the zip).

        The archive is the same byte for byte for the same files, so a package's
        digest only changes when its contents do.
        """
        files = self._walk(directory, exclude=set(exclude))
        for path in files:
            check_extension(path)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for path in sorted(files):
                info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                with open(files[path], 'rb') as fh:
                    zf.writestr(info, fh.read())
        data = buf.getvalue()
        return self.read_package(data, warnings=warnings), data

    # -- cache

    def cache_dir(self, pkg_id, digest):
        return os.path.join(getattr(Config, self.cache_attr), pkg_id, revision(digest))

    def ensure_unpacked(self, pkg_id, digest, load_package):
        """The directory an installed package's files are served from.

        The zip in the database is what is installed; this folder is only a copy
        of it, unpacked again whenever it is missing (a new container, a wiped
        data folder). ``load_package`` returns the zip's bytes.
        """
        dest = self.cache_dir(pkg_id, digest)
        if os.path.isfile(os.path.join(dest, self.manifest_name)):
            return dest
        # A page asks for several files at once: only one request unpacks, the
        # others wait for it (two unpacking at once would pull the folder from
        # under each other's feet).
        with _unpack_lock(dest):
            if os.path.isfile(os.path.join(dest, self.manifest_name)):
                return dest
            data = load_package()
            if not data:
                return None
            self.extract_package(bytes(data), dest)
            self.prune_cache(pkg_id, keep=digest)
            return dest

    def prune_cache(self, pkg_id, keep=None):
        """Drop the unpacked copies of a package (all but the revision in ``keep``)."""
        base = os.path.join(getattr(Config, self.cache_attr), pkg_id)
        if not os.path.isdir(base):
            return
        for name in os.listdir(base):
            if keep and name == revision(keep):
                continue
            shutil.rmtree(os.path.join(base, name), ignore_errors=True)
        if not keep:
            shutil.rmtree(base, ignore_errors=True)

    # -- development

    def dev_packages(self):
        """Unpacked packages served straight from the kind's development folder.

        Returns {id: (manifest, directory, revision)}; a folder that does not
        validate is reported on the console and left out. Folders holding
        another kind's manifest are not this kind's business.
        """
        base = getattr(Config, self.dev_attr, None)
        found = {}
        if not base or not os.path.isdir(base):
            return found
        for name in sorted(os.listdir(base)):
            directory = os.path.join(base, name)
            if not os.path.isfile(os.path.join(directory, self.manifest_name)):
                continue
            try:
                manifest, files = self.read_directory(directory)
            except PackageError as e:
                print(f'{self.label.capitalize()} package {name} skipped: {e}')
                continue
            newest = max(int(os.path.getmtime(p)) for p in files.values())
            found[manifest['id']] = (manifest, directory, f'dev-{newest:x}')
        return found
