"""Static hosting for the external extensions repository.

The repository (index.json + extension manifests) lives OUTSIDE this codebase,
at a directory configured via EXT_REPO_DIR (default: /opt/data/rainy-extensions).
Clients that have the repository link configured fetch the JSON manifests from
here — this server only serves the files and never interprets them, so the
capabilities an extension provides are defined entirely by the repository
content, not by this application.
"""
import os

from flask import Blueprint, abort, send_from_directory

ext_repo_bp = Blueprint('ext_repo', __name__)

REPO_DIR = os.environ.get('EXT_REPO_DIR', '/opt/data/rainy-extensions')


@ext_repo_bp.route('/')
def repo_index():
    """Serve the repository index."""
    return send_from_directory(REPO_DIR, 'index.json')


@ext_repo_bp.route('/<path:filename>')
def repo_file(filename):
    """Serve one repository file (manifests, icons)."""
    if '..' in filename.split('/'):
        abort(404)
    if not os.path.isfile(os.path.join(REPO_DIR, filename)):
        abort(404)
    return send_from_directory(REPO_DIR, filename)
