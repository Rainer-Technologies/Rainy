"""Discovery endpoints: search playlists by name + preview their tracks.

GET  /api/discovery/playlists?q=<name>&source=all|youtube|spotify&limit=8
GET  /api/discovery/preview?url=<playlist-url>

Import itself reuses the existing queue:
POST /api/music/import-playlist-precheck  (name + conflict check)
POST /api/music/import-jobs               (enqueue download)
"""
from flask import Blueprint, jsonify, request

from routes.auth import require_auth
from utils import discovery

discovery_bp = Blueprint('discovery', __name__, url_prefix='/api/discovery')

_MAX_LIMIT = 15


@discovery_bp.route('/playlists', methods=['GET'])
@require_auth
def search_playlists():
    q = (request.args.get('q') or '').strip()
    if len(q) < 2:
        return jsonify({'success': False,
                        'error': 'Query must be at least 2 characters'}), 400
    source = (request.args.get('source') or 'all').lower()
    if source not in ('all', 'youtube', 'spotify'):
        return jsonify({'success': False, 'error': 'Invalid source'}), 400
    try:
        limit = min(max(int(request.args.get('limit', 8)), 1), _MAX_LIMIT)
    except ValueError:
        limit = 8

    try:
        outcome = discovery.search_playlists(q, source=source, limit=limit)
    except Exception as e:  # noqa: BLE001
        print(f"[discovery] search error: {e}")
        return jsonify({'success': False, 'error': f'Search failed: {e}'}), 502
    # A rate-limited backend is a partial success, not an error: the other
    # source's results still arrive, with a notice explaining the gap.
    return jsonify({'success': True, 'query': q, 'source': source,
                    'results': outcome['results'],
                    'notices': outcome['notices']})


@discovery_bp.route('/preview', methods=['GET'])
@require_auth
def preview_playlist():
    url = (request.args.get('url') or '').strip()
    if not url:
        return jsonify({'success': False, 'error': 'No URL provided'}), 400
    if discovery.detect_source(url) is None:
        return jsonify({'success': False,
                        'error': 'Not a recognized YouTube or Spotify playlist URL'}), 400
    try:
        data = discovery.preview_playlist(url)
    except Exception as e:  # noqa: BLE001
        print(f"[discovery] preview error: {e}")
        return jsonify({'success': False, 'error': f'Preview failed: {e}'}), 502
    status = 200 if data.get('success') else 422
    return jsonify(data), status
