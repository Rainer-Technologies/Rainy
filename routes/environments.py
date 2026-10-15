"""Light show environment packages: what is installed, installing and removing
them, and serving their files to the browser (see utils/environments.py).

Anyone signed in can list and load the enabled environments. Installing,
enabling and removing are for administrators only: a package is code that
runs in the page of every user of this server.
"""
from flask import Blueprint, jsonify, request

from models.audit import AuditModel
from models.environment import EnvironmentModel
from routes._packages import install_upload, serve_file
from routes.auth import get_current_user_id, is_sysadmin, require_auth, require_sysadmin, server_error
from utils import environments as packages

environments_bp = Blueprint('environments', __name__)


def _view(manifest, rev, *, enabled=True, dev=False, row=None, admin=False):
    """An environment as the frontend's registry takes it."""
    base = f"/environments/{manifest['id']}/{rev}/"
    out = {
        'id': manifest['id'],
        'name': manifest['name'],
        'version': manifest['version'],
        'api': manifest['api'],
        'description': manifest.get('description', ''),
        'author': manifest.get('author', ''),
        'license': manifest.get('license', ''),
        'homepage': manifest.get('homepage', ''),
        'layout': manifest.get('layout', 'stage'),
        'requires': manifest.get('requires', []),
        'i18n': manifest.get('i18n', {}),
        'base': base,
        'entry': base + manifest['entry'],
        'styles': [base + s for s in manifest.get('styles', [])],
        'preview': base + manifest['preview'] if manifest.get('preview') else None,
        'enabled': bool(enabled),
        'dev': bool(dev),
    }
    if admin and row:
        out['size'] = row['size']
        out['sha256'] = row['sha256']
        installed = row.get('updated_at') or row.get('installed_at')
        out['installed_at'] = installed.isoformat() if hasattr(installed, 'isoformat') else installed
    return out


def _listing(admin):
    dev = packages.dev_packages()
    out = [_view(manifest, rev, dev=True) for manifest, _dir, rev in dev.values()]
    for row in EnvironmentModel.list_all(include_disabled=admin):
        # A package being worked on stands in for the installed one.
        if row['id'] in dev or not row['manifest'].get('entry'):
            continue
        out.append(_view(row['manifest'], packages.revision(row['sha256']),
                         enabled=row['enabled'], row=row, admin=admin))
    out.sort(key=lambda e: (e['name'].lower(), e['id']))
    return out


@environments_bp.route('/api/environments', methods=['GET'])
@require_auth
def list_environments():
    try:
        admin = is_sysadmin()
        return jsonify({
            'success': True,
            'environments': _listing(admin),
            'api_versions': list(packages.API_VERSIONS),
            'can_manage': admin,
            'max_bytes': packages.MAX_ZIP_BYTES,
        })
    except Exception:
        return server_error('list environments')


@environments_bp.route('/api/environments', methods=['POST'])
@require_sysadmin
def install_environment():
    """Install a package (multipart field ``package``), or update the installed one with the same id."""
    return install_upload(packages, EnvironmentModel, 'environment', lambda row, digest: _view(
        row['manifest'], packages.revision(digest), enabled=row['enabled'], row=row, admin=True))


@environments_bp.route('/api/environments/<env_id>', methods=['PATCH'])
@require_sysadmin
def update_environment(env_id):
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get('enabled'), bool):
        return jsonify({'error': 'Nothing to change'}), 400
    try:
        if not EnvironmentModel.get(env_id):
            return jsonify({'error': 'Environment not found'}), 404
        EnvironmentModel.set_enabled(env_id, data['enabled'])
        AuditModel.record('environment_enable' if data['enabled'] else 'environment_disable',
                          user_id=get_current_user_id(), ip=request.remote_addr, detail=env_id)
        row = EnvironmentModel.get(env_id)
        return jsonify({'success': True, 'environment': _view(
            row['manifest'], packages.revision(row['sha256']), enabled=row['enabled'], row=row, admin=True)})
    except Exception:
        return server_error('update the environment')


@environments_bp.route('/api/environments/<env_id>', methods=['DELETE'])
@require_sysadmin
def remove_environment(env_id):
    try:
        row = EnvironmentModel.get(env_id)
        if not row:
            return jsonify({'error': 'Environment not found'}), 404
        EnvironmentModel.delete(env_id)
        packages.prune_cache(env_id)
        AuditModel.record('environment_remove', user_id=get_current_user_id(), ip=request.remote_addr,
                          detail=f"{env_id} {row['version']}")
        return jsonify({'success': True})
    except Exception:
        return server_error('remove the environment')


@environments_bp.route('/environments/<env_id>/<rev>/<path:filename>', methods=['GET'])
@require_auth
def environment_file(env_id, rev, filename):
    """A file of an environment package. The revision in the address changes with the
    package's contents, so what is served under one never changes."""
    return serve_file(packages, EnvironmentModel, env_id, rev, filename)
