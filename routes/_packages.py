"""What the routes of every kind of package share: installing an upload and
serving a package's files (see utils/packages.py).

``kind`` is the kind's module (utils.environments, utils.themes): its
read_package, extract_package, cache_dir, prune_cache, ensure_unpacked,
dev_packages, revision, mime_type, MIME_TYPES and MAX_ZIP_BYTES. ``model`` is
its PackageStore.
"""
import os

from flask import jsonify, request, send_from_directory
from werkzeug.exceptions import NotFound

from models.audit import AuditModel
from routes.auth import get_current_user_id, server_error

_YEAR = 365 * 24 * 3600


def install_upload(kind, model, label, view):
    """Install the package in the multipart field ``package``, or update the installed one with its id.

    ``view(row, digest)`` is how the kind shows an installed package; ``label``
    names the kind in the audit log and in errors.
    """
    upload = request.files.get('package')
    if not upload:
        return jsonify({'error': 'No package provided'}), 400
    if request.content_length and request.content_length > kind.MAX_ZIP_BYTES + 64 * 1024:
        return jsonify({'error': f'The package is larger than {kind.MAX_ZIP_BYTES // (1024 * 1024)} MB.'}), 413
    data = upload.read(kind.MAX_ZIP_BYTES + 1)
    warnings = []
    try:
        manifest = kind.read_package(data, warnings=warnings)
    except kind.PackageError as e:
        return jsonify({'error': str(e)}), 400
    try:
        previous = model.get(manifest['id'])
        digest = kind.package_digest(data)
        row = model.save(manifest, data, digest, get_current_user_id())
        kind.extract_package(data, kind.cache_dir(manifest['id'], digest))
        kind.prune_cache(manifest['id'], keep=digest)
        AuditModel.record(f'{label}_install', user_id=get_current_user_id(), ip=request.remote_addr,
                          detail=f"{manifest['id']} {manifest['version']} sha256:{digest[:16]}")
        return jsonify({
            'success': True,
            label: view(row, digest),
            'updated': bool(previous),
            'previous_version': previous['version'] if previous else None,
            'warnings': warnings,
        })
    except Exception:
        return server_error(f'install the {label}')


def serve_file(kind, model, pkg_id, rev, filename):
    """A file of a package. The revision in the address changes with the package's
    contents, so what is served under one never changes."""
    directory, immutable = None, True
    if rev.startswith('dev-'):
        # A folder being worked on is served as it is now, whatever edit the address names.
        found = kind.dev_packages().get(pkg_id)
        if found:
            directory, immutable = found[1], False
    else:
        row = model.get(pkg_id)
        # Disabled or replaced: its files stop being served.
        if row and row['enabled'] and kind.revision(row['sha256']) == rev:
            directory = kind.ensure_unpacked(pkg_id, row['sha256'], lambda: model.get_package(pkg_id))
    name = os.path.basename(filename)
    if not directory or name.startswith('.') or os.path.splitext(name)[1].lower() not in kind.MIME_TYPES:
        raise NotFound()
    response = send_from_directory(directory, filename, mimetype=kind.mime_type(filename),
                                   max_age=_YEAR if immutable else 0)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    if immutable:
        response.headers['Cache-Control'] = f'private, max-age={_YEAR}, immutable'
    else:
        response.headers['Cache-Control'] = 'no-store'
    return response
