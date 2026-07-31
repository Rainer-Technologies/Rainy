"""Plugin / extension shop registry.

Plugins are declarative JSON manifests stored under ``Rainy/plugins/``. Each
manifest describes a set of *actions* (forms + HTTP endpoints) that the mobile
client renders dynamically. This keeps the plugin system safe (no arbitrary
code execution on the client) while still letting new extensions ship without
an app update — just drop a new ``.json`` file here.
"""
from flask import Blueprint, jsonify, send_file
from routes.auth import require_auth
import json
import os

plugins_bp = Blueprint('plugins', __name__)

PLUGINS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'plugins')


def _load_manifest(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"[plugins] failed to load {path}: {e}")
        return None


def _list_manifests():
    manifests = []
    if not os.path.isdir(PLUGINS_DIR):
        return manifests
    for fname in sorted(os.listdir(PLUGINS_DIR)):
        if not fname.endswith('.json'):
            continue
        manifest = _load_manifest(os.path.join(PLUGINS_DIR, fname))
        if manifest and manifest.get('id'):
            manifests.append(manifest)
    return manifests


@plugins_bp.route('/', methods=['GET'])
@require_auth
def list_plugins():
    """Return the catalog of available plugins (full manifests)."""
    return jsonify({'plugins': _list_manifests()})


@plugins_bp.route('/<plugin_id>', methods=['GET'])
@require_auth
def get_plugin(plugin_id):
    """Return a single plugin manifest by id."""
    for manifest in _list_manifests():
        if manifest.get('id') == plugin_id:
            return jsonify({'plugin': manifest})
    return jsonify({'error': 'Plugin not found'}), 404


@plugins_bp.route('/<plugin_id>/icon', methods=['GET'])
@require_auth
def plugin_icon(plugin_id):
    """Optional custom icon (png/svg) shipped alongside a manifest."""
    for ext in ('png', 'svg', 'jpg', 'webp'):
        candidate = os.path.join(PLUGINS_DIR, f'{plugin_id}.{ext}')
        if os.path.isfile(candidate):
            return send_file(candidate)
    return jsonify({'error': 'No icon'}), 404
