from flask import Blueprint, jsonify, request
from routes.auth import get_current_user_id, is_sysadmin, require_auth, server_error
from models.playlist import PlaylistModel
from models.playlist_sync import PlaylistSyncModel

playlist_syncs_bp = Blueprint('playlist_syncs', __name__, url_prefix='/api/playlist-syncs')


def _can_manage(pl):
    """Owners manage their playlist's sync. A legacy ownerless playlist is
    shared by every account (and an orphaned sync has none), so only a
    sysadmin may manage those."""
    if not pl or pl.get('owner_user_id') is None:
        return is_sysadmin()
    return pl['owner_user_id'] == get_current_user_id()


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
    visible = []
    for r in rows:
        pl = PlaylistModel.get_playlist_by_id(r['playlist_id'])
        if not pl:
            continue
        # Only syncs the caller can manage.
        if not _can_manage(pl):
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
    if not _can_manage(pl):
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
    except Exception:
        return server_error()


@playlist_syncs_bp.route('/<int:sync_id>', methods=['PUT'])
@require_auth
def update_sync(sync_id):
    row = PlaylistSyncModel.get(sync_id)
    if not row:
        return jsonify({'error': 'Sync not found'}), 404
    pl = PlaylistModel.get_playlist_by_id(row['playlist_id'])
    if not _can_manage(pl):
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
    except Exception:
        return server_error()


@playlist_syncs_bp.route('/<int:sync_id>', methods=['DELETE'])
@require_auth
def delete_sync(sync_id):
    row = PlaylistSyncModel.get(sync_id)
    if not row:
        return jsonify({'error': 'Sync not found'}), 404
    pl = PlaylistModel.get_playlist_by_id(row['playlist_id'])
    if not _can_manage(pl):
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
    if not _can_manage(pl):
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
            sync_mode=row.get('sync_mode') or 'mirror',
            user_id=get_current_user_id()
        )
        if result.get('success'):
            msg = f"Added {result.get('added',0)}, removed {result.get('removed',0)}, kept {result.get('kept',0)}, failed {result.get('failed',0)}"
            PlaylistSyncModel.mark_completed(sync_id, msg, row.get('interval_hours') or 24)
            try:
                PlaylistSyncModel.add_history(
                    sync_id, row['playlist_id'],
                    added=result.get('added',0), removed=result.get('removed',0),
                    kept=result.get('kept',0), failed=result.get('failed',0),
                    total_remote=result.get('total_remote',0),
                    status='success', message=msg,
                    details={'added': result.get('added_details') or [], 'removed': result.get('removed_details') or []}
                )
            except Exception:
                pass
            return jsonify({'success': True, 'result': result})
        else:
            PlaylistSyncModel.mark_failed(sync_id, result.get('error','failed'), row.get('interval_hours') or 24)
            try:
                PlaylistSyncModel.add_history(sync_id, row['playlist_id'], status='failed', message=str(result.get('error','failed')))
            except Exception:
                pass
            return jsonify({'success': False, 'error': result.get('error')}), 500
    except Exception as e:
        PlaylistSyncModel.mark_failed(sync_id, str(e), row.get('interval_hours') or 24)
        try:
            PlaylistSyncModel.add_history(sync_id, row['playlist_id'], status='failed', message=str(e))
        except Exception:
            pass
        return server_error()


@playlist_syncs_bp.route('/<int:sync_id>/history', methods=['GET'])
@require_auth
def get_sync_history(sync_id):
    row = PlaylistSyncModel.get(sync_id)
    if not row:
        return jsonify({'error': 'Sync not found'}), 404
    pl = PlaylistModel.get_playlist_by_id(row['playlist_id'])
    if not _can_manage(pl):
        return jsonify({'error': 'Forbidden'}), 403
    try:
        limit = int(request.args.get('limit', '20'))
        limit = max(1, min(limit, 100))
    except:
        limit = 20
    rows = PlaylistSyncModel.get_history(sync_id, limit) or []
    import json as _json
    out = []
    for r in rows:
        details = None
        try:
            details = _json.loads(r.get('details_json')) if r.get('details_json') else None
        except:
            details = None
        out.append({
            'id': r['id'],
            'sync_id': r['sync_id'],
            'playlist_id': r['playlist_id'],
            'ran_at': r['ran_at'].isoformat() if hasattr(r['ran_at'], 'isoformat') else r['ran_at'],
            'added_count': r['added_count'],
            'removed_count': r['removed_count'],
            'kept_count': r['kept_count'],
            'failed_count': r['failed_count'],
            'total_remote': r['total_remote'],
            'status': r['status'],
            'message': r['message'],
            'details': details,
        })
    return jsonify({'success': True, 'history': out})


@playlist_syncs_bp.route('/history', methods=['GET'])
@require_auth
def get_all_sync_history():
    try:
        limit = int(request.args.get('limit', '30'))
        limit = max(1, min(limit, 100))
    except:
        limit = 30
    rows = PlaylistSyncModel.get_all_history(limit) or []
    import json as _json
    out = []
    for r in rows:
        # Only history of syncs the caller can manage.
        pl = PlaylistModel.get_playlist_by_id(r['playlist_id'])
        if not _can_manage(pl):
            continue
        details = None
        try:
            details = _json.loads(r.get('details_json')) if r.get('details_json') else None
        except:
            details = None
        out.append({
            'id': r['id'],
            'sync_id': r['sync_id'],
            'playlist_id': r['playlist_id'],
            'playlist_name': r.get('playlist_name'),
            'ran_at': r['ran_at'].isoformat() if hasattr(r['ran_at'], 'isoformat') else r['ran_at'],
            'added_count': r['added_count'],
            'removed_count': r['removed_count'],
            'kept_count': r['kept_count'],
            'failed_count': r['failed_count'],
            'total_remote': r['total_remote'],
            'status': r['status'],
            'message': r['message'],
            'details': details,
        })
    return jsonify({'success': True, 'history': out})
