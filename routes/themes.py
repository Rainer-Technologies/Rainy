"""UI theme packages: what is installed, installing and removing them, the
server's default theme, and serving their files (see utils/themes.py).

Anyone signed in can list the enabled themes and pick one. Installing,
enabling, removing and choosing the default are for administrators only: a
theme restyles the app for every user of this server and may carry code.

A theme's files are served without a session, so the sign-in screen can wear
the theme too; only enabled themes are served, and only at the revision
installed.
"""
from flask import Blueprint, jsonify, request

from models.audit import AuditModel
from models.theme import ThemeModel
from routes._packages import install_upload, serve_file
from routes.auth import get_current_user_id, is_sysadmin, require_auth, require_sysadmin, server_error
from utils import themes as packages

themes_bp = Blueprint('themes', __name__)


def _view(manifest, rev, *, enabled=True, dev=False, row=None, admin=False):
    """A theme as the frontend's registry takes it."""
    base = f"/themes/{manifest['id']}/{rev}/"
    out = {
        'id': manifest['id'],
        'name': manifest['name'],
        'version': manifest['version'],
        'api': manifest['api'],
        'rev': rev,
        'description': manifest.get('description', ''),
        'author': manifest.get('author', ''),
        'license': manifest.get('license', ''),
        'homepage': manifest.get('homepage', ''),
        'colorScheme': manifest.get('colorScheme', 'dark'),
        'tokens': manifest.get('tokens', {}),
        'i18n': manifest.get('i18n', {}),
        'base': base,
        'styles': [base + s for s in manifest.get('styles', [])],
        'icons': {name: base + path for name, path in manifest.get('icons', {}).items()},
        'strings': manifest.get('strings', {}),
        'entry': base + manifest['entry'] if manifest.get('entry') else None,
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
    for row in ThemeModel.list_all(include_disabled=admin):
        # A package being worked on stands in for the installed one.
        if row['id'] in dev or not row['manifest'].get('id'):
            continue
        out.append(_view(row['manifest'], packages.revision(row['sha256']),
                         enabled=row['enabled'], row=row, admin=admin))
    out.sort(key=lambda t: (t['name'].lower(), t['id']))
    return out


def _default(listing):
    """The server's default theme, if it is still there and enabled."""
    chosen = ThemeModel.get_default()
    return chosen if any(t['id'] == chosen and t['enabled'] for t in listing) else None


@themes_bp.route('/api/themes', methods=['GET'])
@require_auth
def list_themes():
    try:
        admin = is_sysadmin()
        listing = _listing(admin)
        return jsonify({
            'success': True,
            'themes': listing,
            'default': _default(listing),
            'api_versions': list(packages.API_VERSIONS),
            'can_manage': admin,
            'max_bytes': packages.MAX_ZIP_BYTES,
        })
    except Exception:
        return server_error('list themes')


@themes_bp.route('/api/themes', methods=['POST'])
@require_sysadmin
def install_theme():
    """Install a package (multipart field ``package``), or update the installed one with the same id."""
    return install_upload(packages, ThemeModel, 'theme', lambda row, digest: _view(
        row['manifest'], packages.revision(digest), enabled=row['enabled'], row=row, admin=True))


@themes_bp.route('/api/themes/default', methods=['PUT'])
@require_sysadmin
def set_default_theme():
    """The theme of users who have not picked one: an installed theme's id, or null for Rainy's own."""
    data = request.get_json(silent=True) or {}
    theme_id = data.get('id')
    if theme_id is not None and not isinstance(theme_id, str):
        return jsonify({'error': 'Nothing to change'}), 400
    try:
        if theme_id and theme_id not in {t['id'] for t in _listing(True) if t['enabled']}:
            return jsonify({'error': 'Theme not found'}), 404
        ThemeModel.set_default(theme_id)
        AuditModel.record('theme_default', user_id=get_current_user_id(), ip=request.remote_addr,
                          detail=theme_id or 'rainy')
        return jsonify({'success': True, 'default': theme_id or None})
    except Exception:
        return server_error('set the default theme')


@themes_bp.route('/api/themes/<theme_id>', methods=['PATCH'])
@require_sysadmin
def update_theme(theme_id):
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get('enabled'), bool):
        return jsonify({'error': 'Nothing to change'}), 400
    try:
        if not ThemeModel.get(theme_id):
            return jsonify({'error': 'Theme not found'}), 404
        ThemeModel.set_enabled(theme_id, data['enabled'])
        if not data['enabled'] and ThemeModel.get_default() == theme_id:
            ThemeModel.set_default(None)
        AuditModel.record('theme_enable' if data['enabled'] else 'theme_disable',
                          user_id=get_current_user_id(), ip=request.remote_addr, detail=theme_id)
        row = ThemeModel.get(theme_id)
        return jsonify({'success': True, 'theme': _view(
            row['manifest'], packages.revision(row['sha256']), enabled=row['enabled'], row=row, admin=True)})
    except Exception:
        return server_error('update the theme')


@themes_bp.route('/api/themes/<theme_id>', methods=['DELETE'])
@require_sysadmin
def remove_theme(theme_id):
    try:
        row = ThemeModel.get(theme_id)
        if not row:
            return jsonify({'error': 'Theme not found'}), 404
        ThemeModel.delete(theme_id)
        packages.prune_cache(theme_id)
        if ThemeModel.get_default() == theme_id:
            ThemeModel.set_default(None)
        AuditModel.record('theme_remove', user_id=get_current_user_id(), ip=request.remote_addr,
                          detail=f"{theme_id} {row['version']}")
        return jsonify({'success': True})
    except Exception:
        return server_error('remove the theme')


@themes_bp.route('/themes/<theme_id>/<rev>/<path:filename>', methods=['GET'])
def theme_file(theme_id, rev, filename):
    """A file of a theme package (no session needed: the sign-in screen wears the theme too)."""
    return serve_file(packages, ThemeModel, theme_id, rev, filename)
