from flask import Blueprint, jsonify, request, session
from routes.auth import require_auth
from models.playlist import PlaylistModel
from models.playlist_sync import PlaylistSyncModel

playlist_syncs_bp = Blueprint('playlist_syncs', __name__, url_prefix='/api/playlist-syncs')


def _serialize(row):
    if not row:
        return None
    # ensure datetime isoformat
    def _ts(v):
        return v.isoformat() if hasattr(v, 'isoformat') else v
    return {
        'id': row['id'],
        'playlist_id': row['playlist_id'],
        'playlist_name': row.get('playlist_name') or row.get('name') or None,
        'source': row['source'],
        'url': row['url'],
        'interval_hours': row['interval_hours'],
        'enabled': bool(row['enabled']),
        'sync_mode': row['sync_mode'],
        'last_synced_at': _ts(row.get('last_synced_at')),
        'next_sync_at': _ts(row.get('next_sync_at')),
        'last_status': row.get('last_status'),
        'last_message': row.get('last_message'),
        'created_at': _ts(row.get('created_at')),
        'updated_at': _ts(row.get('updated_at')),
        'icon': row.get('icon'),
        'icon_color': row.get('icon_color'),
    }


@playlist_syncs_bp.route('', methods=['GET'])
@require_auth
def list_syncs():
    rows = PlaylistSyncModel.list_all() or []
    # filter to playlists visible to user
    user_id = session.get('user_id')
    visible = []
    for r in rows:
        pl = PlaylistModel.get_playlist_by_id(r['playlist_id'])
        if not pl:
            continue
        # private playlist visibility check
        if pl.get('owner_user_id') is not None and pl.get('owner_user_id') != user_id:
            # still show if owner? skip others
            continue
        visible.append(_serialize(r))
    return jsonify({'success': True, 'syncs': visible})


@playlist_syncs_bp.route('', methods=['POST'])
@require_auth
def create_sync():
    data = request.get_json() or {}
    playlist_id = data.get('playlist_id')
    source = (data.get('source') or '').lower()
    url = (data.get('url') or '').strip()
    interval_hours = int(data.get('interval_hours') or 24)
    sync_mode = data.get('sync_mode') or 'mirror'
    enabled = bool(data.get('enabled', True))

    if not playlist_id:
        return jsonify({'error': 'playlist_id is required'}), 400
    if source not in ('youtube','spotify'):
        return jsonify({'error': 'source must be youtube or spotify'}), 400
    if not url:
        return jsonify({'error': 'url is required'}), 400
    if sync_mode not in ('add_only','mirror'):
        return jsonify({'error': 'sync_mode must be add_only or mirror'}), 400

    pl = PlaylistModel.get_playlist_by_id(playlist_id)
    if not pl:
        return jsonify({'error': 'Playlist not found'}), 404
    user_id = session.get('user_id')
    if pl.get('owner_user_id') is not None and pl.get('owner_user_id') != user_id:
        return jsonify({'error': 'Forbidden'}), 403

    existing = PlaylistSyncModel.get_by_playlist(playlist_id)
    if existing:
        return jsonify({'error': 'This playlist already has a sync. Delete the existing one first.'}), 400

    # Basic URL validation
    if source == 'youtube' and 'list=' not in url and 'playlist' not in url.lower():
        return jsonify({'error': 'Invalid YouTube playlist URL (expected list= parameter)'}), 400
    if source == 'spotify':
        from utils.spotify import SpotifyImporter
        if not SpotifyImporter().parse_playlist_id(url):
            return jsonify({'error': 'Invalid Spotify playlist URL'}), 400

    try:
        sync_id = PlaylistSyncModel.create(playlist_id, source, url, interval_hours, sync_mode, enabled)
        row = PlaylistSyncModel.get(sync_id)
        # join playlist name for response
        pl_name = pl.get('name')
        row = dict(row)
        row['playlist_name'] = pl_name
        row['icon'] = pl.get('icon')
        row['icon_color'] = pl.get('icon_color')
        return jsonify({'success': True, 'sync': _serialize(row)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlist_syncs_bp.route('/<int:sync_id>', methods=['PUT'])
@require_auth
def update_sync(sync_id):
    row = PlaylistSyncModel.get(sync_id)
    if not row:
        return jsonify({'error': 'Sync not found'}), 404
    pl = PlaylistModel.get_playlist_by_id(row['playlist_id'])
    user_id = session.get('user_id')
    if pl and pl.get('owner_user_id') is not None and pl.get('owner_user_id') != user_id:
        return jsonify({'error': 'Forbidden'}), 403
    data = request.get_json() or {}
    fields = {}
    if 'interval_hours' in data:
        try:
            ih = int(data['interval_hours'])
            if ih in PlaylistSyncModel.VALID_INTERVALS:
                fields['interval_hours'] = ih
        except: pass
    if 'sync_mode' in data and data['sync_mode'] in ('add_only','mirror'):
        fields['sync_mode'] = data['sync_mode']
    if 'enabled' in data:
        fields['enabled'] = bool(data['enabled'])
    if 'url' in data and data['url'].strip():
        fields['url'] = data['url'].strip()
        # also update source if implied? keep existing
    if 'source' in data and data['source'] in ('youtube','spotify'):
        fields['source'] = data['source']
    if not fields:
        return jsonify({'error': 'No valid fields to update'}), 400
    try:
        PlaylistSyncModel.update(sync_id, **fields)
        updated = PlaylistSyncModel.get(sync_id)
        # attach playlist name
        if pl:
            updated = dict(updated)
            updated['playlist_name'] = pl['name']
            updated['icon'] = pl.get('icon')
            updated['icon_color'] = pl.get('icon_color')
        return jsonify({'success': True, 'sync': _serialize(updated)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlist_syncs_bp.route('/<int:sync_id>', methods=['DELETE'])
@require_auth
def delete_sync(sync_id):
    row = PlaylistSyncModel.get(sync_id)
    if not row:
        return jsonify({'error': 'Sync not found'}), 404
    pl = PlaylistModel.get_playlist_by_id(row['playlist_id'])
    user_id = session.get('user_id')
    if pl and pl.get('owner_user_id') is not None and pl.get('owner_user_id') != user_id:
        return jsonify({'error': 'Forbidden'}), 403
    PlaylistSyncModel.delete(sync_id)
    return jsonify({'success': True})


@playlist_syncs_bp.route('/<int:sync_id>/run', methods=['POST'])
@require_auth
def run_sync_now(sync_id):
    row = PlaylistSyncModel.get(sync_id)
    if not row:
        return jsonify({'error': 'Sync not found'}), 404
    pl = PlaylistModel.get_playlist_by_id(row['playlist_id'])
    user_id = session.get('user_id')
    if pl and pl.get('owner_user_id') is not None and pl.get('owner_user_id') != user_id:
        return jsonify({'error': 'Forbidden'}), 403
    from models.settings import SettingsModel
    music_path = SettingsModel.get_music_path()
    if not music_path:
        return jsonify({'error': 'Music path not configured'}), 400
    # run synchronously (could be slow) — we run in thread? For now sync call directly
    # Mark running then execute
    PlaylistSyncModel.mark_running(sync_id)
    from utils.playlist_sync import sync_playlist
    try:
        result = sync_playlist(
            row['playlist_id'], row['source'], row['url'], music_path,
            sync_mode=row.get('sync_mode') or 'mirror'
        )
        if result.get('success'):
            msg = f"Added {result.get('added',0)}, removed {result.get('removed',0)}, kept {result.get('kept',0)}, failed {result.get('failed',0)}"
            PlaylistSyncModel.mark_completed(sync_id, msg, row.get('interval_hours') or 24)
            return jsonify({'success': True, 'result': result})
        else:
            PlaylistSyncModel.mark_failed(sync_id, result.get('error','failed'), row.get('interval_hours') or 24)
            return jsonify({'success': False, 'error': result.get('error')}), 500
    except Exception as e:
        PlaylistSyncModel.mark_failed(sync_id, str(e), row.get('interval_hours') or 24)
        return jsonify({'error': str(e)}), 500
