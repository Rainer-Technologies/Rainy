"""Light show environment packages.

An environment is a kind of light show that runs in the browser (see
static/js/lightshow/environments/). Besides the built-in one, a server can
have more installed as packages: a zip holding a ``rainy-environment.json``
manifest, an ES module entry point and whatever files it needs
(docs/ENVIRONMENTS.md).

What packages of every kind share (reading a zip, packing a folder, the
unpacked cache, development folders) is in utils/packages.py; this module is
the environment's manifest and limits, under the names the rest of the server
has always used. A package's code runs in the page of every user of the
server, so only an administrator may install one; the checks keep a package
well formed and its files inside its own folder, they do not make an
untrusted package safe.
"""
import sys

from config import Config  # noqa: F401  (tests point its folders elsewhere through this module)
from utils.packages import (  # noqa: F401  (part of this module's interface)
    IMAGE_EXT as _IMAGE_EXT,
    MIME_TYPES,
    SCRIPT_EXT as _SCRIPT_EXT,
    PackageError,
    PackageKind,
    common_fields,
    file_field,
    mime_type,
    package_digest,
    revision,
)

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


def validate_manifest(data, files):
    """Check a parsed manifest against the files of its package.

    Returns the manifest as this server stores it: known fields only, in
    their normal form. Raises PackageError with a message for the author.
    """
    common = common_fields(data, 'environment', RESERVED_IDS, API_VERSIONS, MANIFEST_VERSION)

    layout = data.get('layout', 'stage')
    if layout not in LAYOUTS:
        raise PackageError(f'"layout" must be one of: {", ".join(LAYOUTS)}.')
    requires = data.get('requires', [])
    if not isinstance(requires, list) or any(r not in REQUIRES for r in requires):
        raise PackageError(f'"requires" may list: {", ".join(REQUIRES)}.')
    styles = data.get('styles', [])
    if not isinstance(styles, list) or len(styles) > 8:
        raise PackageError('"styles" must be a list of at most 8 stylesheets.')

    return {
        **{k: common[k] for k in ('manifest', 'api', 'id', 'name', 'version', 'description',
                                   'author', 'license', 'homepage')},
        'entry': file_field(data, 'entry', files, _SCRIPT_EXT, required=True),
        'styles': [file_field({'styles': s}, 'styles', files, ('.css',), required=True) for s in styles],
        'preview': file_field(data, 'preview', files, _IMAGE_EXT),
        'layout': layout,
        'requires': sorted(set(requires)),
        'i18n': common['i18n'],
    }


KIND = PackageKind(
    label='environment',
    manifest_name=MANIFEST_NAME,
    validate=lambda data, files: validate_manifest(data, files),
    limits=sys.modules[__name__],
    cache_attr='ENVIRONMENTS_CACHE_DIR',
    dev_attr='ENVIRONMENTS_DEV_DIR',
)

read_package = KIND.read_package
extract_package = KIND.extract_package
read_directory = KIND.read_directory
pack_directory = KIND.pack_directory
cache_dir = KIND.cache_dir
ensure_unpacked = KIND.ensure_unpacked
prune_cache = KIND.prune_cache
dev_packages = KIND.dev_packages
