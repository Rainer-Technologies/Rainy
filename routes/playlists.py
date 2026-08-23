from flask import Blueprint, jsonify, request, session
from models.playlist import PlaylistModel
from models.playlist_share import PlaylistShareModel
from routes.auth import require_auth, require_sysadmin

playlists_bp = Blueprint('playlists', __name__)

@playlists_bp.route('/', methods=['GET'])
@require_auth
def get_playlists():
    """Get all playlists."""
    user_id = session.get('user_id')
    playlists = PlaylistModel.get_all_playlists_for_user(user_id)
    # Normalize each row so the frontend always gets a cover_path key.
    result = []
    for p in (playlists or []):
        p = dict(p)
        p.setdefault('cover_path', None)
        p['shared'] = bool(p.get('shared'))
        p['owner_username'] = p.get('owner_username')
        p.setdefault('share_role', None)
        result.append(p)
    return jsonify(result)

@playlists_bp.route('/', methods=['POST'])
@require_auth
def create_playlist():
    """Create a new playlist."""
    data = request.get_json()
    if not data or 'name' not in data:
        return jsonify({'error': 'Name is required'}), 400
    
    icon = data.get('icon', 'music-note')
    icon_color = data.get('icon_color', '#888888')
    # Per-account isolation: EVERY playlist belongs to its creator. The
    # 'private' flag is accepted for client back-compat but has no effect —
    # playlists can no longer be created shared/public.
    owner_user_id = session.get('user_id')
    
    try:
        playlist_id = PlaylistModel.create_playlist(data['name'], icon, icon_color, owner_user_id)
        return jsonify({
            'success': True, 
            'id': playlist_id,
            'name': data['name'],
            'icon': icon,
            'icon_color': icon_color,
            'owner_user_id': owner_user_id
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@playlists_bp.route('/<int:playlist_id>', methods=['GET'])
@require_auth
def get_playlist(playlist_id):
    """Get playlist details and songs."""
    playlist = PlaylistModel.get_playlist_by_id(playlist_id)
    if not playlist:
        return jsonify({'error': 'Playlist not found'}), 404
    
    # View check: owner, accepted collaborator, or legacy public playlist.
    if playlist.get('owner_user_id') is not None and \
            not PlaylistShareModel.can_view(session.get('user_id'), playlist_id):
        return jsonify({'error': 'Forbidden'}), 403
        
    raw_songs = PlaylistModel.get_playlist_songs(playlist_id)

    # Per-account isolation: a playlist may reference songs the requesting
    # user has no access to (legacy shared playlists, cross-account entries).
    # Only return the songs the user is actually allowed to see/hear.
    from models.library_access import LibraryAccessModel
    raw_songs = LibraryAccessModel.filter_visible(
        session.get('user_id'), raw_songs or [])

    # Transform songs to match expected frontend format (same as SongModel)
    songs = []
    for row in (raw_songs or []):
        songs.append({
            'id': row['id'],
            'path': row['file_path'],
            'title': row['title'],
            'artist': row['artist'],
            'album': row['album'],
            'duration': row['duration'],
            'track': row['track_number'],
            'year': row['year'],
            'genre': row['genre'],
            'cover_path': row['cover_path']
        })
    
    return jsonify({
        'id': playlist['id'],
        'name': playlist['name'],
        'icon': playlist.get('icon', 'music-note'),
        'icon_color': playlist.get('icon_color', '#fa586a'),
        'cover_path': playlist.get('cover_path'),
        'created_at': playlist['created_at'],
        'owner_user_id': playlist.get('owner_user_id'),
        'role': PlaylistShareModel.user_role(session.get('user_id'), playlist_id),
        'songs': songs
    })

@playlists_bp.route('/<int:playlist_id>', methods=['DELETE'])
@require_auth
def delete_playlist(playlist_id):
    """Delete a playlist — users may delete their OWN playlists; legacy
    ownerless playlists require a sysadmin."""
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404

        owner = playlist.get('owner_user_id')
        user_id = session.get('user_id')
        if owner is None:
            # Legacy shared playlist: only a sysadmin can delete it.
            from models.user import UserModel
            user = UserModel.get_user_by_id(user_id)
            if not user or user['role'] != 'sysadmin':
                return jsonify({'error': 'Forbidden'}), 403
        elif owner != user_id:
            return jsonify({'error': 'Forbidden'}), 403

        PlaylistModel.delete_playlist(playlist_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@playlists_bp.route('/<int:playlist_id>', methods=['PUT'])
@require_auth
def update_playlist(playlist_id):
    """Update a playlist (name, icon, color)."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
        
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        # Ownership check: only owner can modify private playlist
        if playlist.get('owner_user_id') is not None and \
                not PlaylistShareModel.can_edit(session.get('user_id'), playlist_id):
            return jsonify({'error': 'Forbidden'}), 403
        
        # Update name if provided
        if 'name' in data:
            PlaylistModel.update_playlist_name(playlist_id, data['name'])
        
        # Update appearance if provided
        if 'icon' in data or 'icon_color' in data:
            icon = data.get('icon', playlist.get('icon', 'music-note'))
            icon_color = data.get('icon_color', playlist.get('icon_color', '#fa586a'))
            PlaylistModel.update_playlist_appearance(playlist_id, icon, icon_color)
        
        # 'private' is accepted for back-compat but deliberately ignored:
        # with per-account isolation a playlist can never become shared.
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@playlists_bp.route('/<int:playlist_id>/songs', methods=['POST'])
@require_auth
def add_song(playlist_id):
    """Add a song to a playlist."""
    data = request_get_json = request.get_json()
    if not data or 'song_id' not in data:
        return jsonify({'error': 'Song ID is required'}), 400
        
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        if playlist.get('owner_user_id') is not None and \
                not PlaylistShareModel.can_edit(session.get('user_id'), playlist_id):
            return jsonify({'error': 'Forbidden'}), 403
        # Per-account isolation: you can only add songs you can hear.
        from models.library_access import LibraryAccessModel
        if not LibraryAccessModel.has_access(
                session.get('user_id'), data['song_id']):
            return jsonify({'error': 'Forbidden'}), 403
        PlaylistModel.add_song_to_playlist(playlist_id, data['song_id'])
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@playlists_bp.route('/<int:playlist_id>/songs/<int:song_id>', methods=['DELETE'])
@require_auth
def remove_song(playlist_id, song_id):
    """Remove a song from a playlist."""
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        if playlist.get('owner_user_id') is not None and \
                not PlaylistShareModel.can_edit(session.get('user_id'), playlist_id):
            return jsonify({'error': 'Forbidden'}), 403
        PlaylistModel.remove_song_from_playlist(playlist_id, song_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/cover', methods=['POST'])
@require_auth
def generate_cover(playlist_id):
    """Auto-generate (or regenerate) a mosaic cover for a playlist.

    Builds a 2x2 grid from up to four of the playlist's song covers, stores it
    under covers/playlists/, and saves the relative path on the playlist row.
    The cover then stays fixed until this endpoint is called again.
    """
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        # Ownership check
        if playlist.get('owner_user_id') is not None and \
                not PlaylistShareModel.can_edit(session.get('user_id'), playlist_id):
            return jsonify({'error': 'Forbidden'}), 403

        songs = PlaylistModel.get_playlist_songs(playlist_id)
        # Only songs the requesting user can actually hear belong in the
        # generated cover (legacy shared playlists may hold other people's
        # personal imports).
        from models.library_access import LibraryAccessModel
        songs = LibraryAccessModel.filter_visible(
            session.get('user_id'), songs or [])
        if not songs:
            return jsonify({'error': 'Playlist is empty'}), 400

        from models.settings import SettingsModel
        from utils.playlist_cover import generate_playlist_cover
        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400

        cover_path = generate_playlist_cover(
            playlist_id,
            songs,
            music_path,
            icon_color=playlist.get('icon_color', '#888888'),
        )
        if not cover_path:
            return jsonify({'error': 'Could not generate cover'}), 500

        PlaylistModel.update_playlist_cover(playlist_id, cover_path)
        return jsonify({'success': True, 'cover_path': cover_path})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/reorder', methods=['POST'])
@require_auth
def reorder_playlist(playlist_id):
    """Reorder songs in a playlist via drag-and-drop.

    Expects JSON body: {"ordered_track_ids": [3, 1, 2, ...]}
    """
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        if playlist.get('owner_user_id') is not None and \
                not PlaylistShareModel.can_edit(session.get('user_id'), playlist_id):
            return jsonify({'error': 'Forbidden'}), 403

        data = request.get_json() or {}
        ordered = data.get('ordered_track_ids')
        if not isinstance(ordered, list) or not ordered:
            return jsonify({'error': 'ordered_track_ids must be a non-empty list'}), 400

        PlaylistModel.reorder_songs(playlist_id, ordered)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/download', methods=['GET'])
@require_auth
def download_playlist(playlist_id):
    """Download all songs in a playlist as a zip file."""
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        
        # Read check: owner, accepted collaborator, or legacy public.
        if playlist.get('owner_user_id') is not None and \
                not PlaylistShareModel.can_view(session.get('user_id'), playlist_id):
            return jsonify({'error': 'Forbidden'}), 403
            
        songs = PlaylistModel.get_playlist_songs(playlist_id)
        from models.library_access import LibraryAccessModel
        songs = LibraryAccessModel.filter_visible(
            session.get('user_id'), songs or [])
        if not songs:
            return jsonify({'error': 'Playlist is empty'}), 400
            
        from models.settings import SettingsModel
        music_path = SettingsModel.get_music_path()
        if not music_path:
            return jsonify({'error': 'Music path not configured'}), 400
            
        import io
        import zipfile
        import os
        import re
        from flask import send_file
        
        memory_file = io.BytesIO()
        with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            for song in songs:
                relative_path = song['file_path']
                full_path = os.path.normpath(os.path.join(music_path, relative_path))
                if full_path.startswith(os.path.normpath(music_path)) and os.path.isfile(full_path):
                    filename = os.path.basename(full_path)
                    zf.write(full_path, arcname=filename)
                    
        memory_file.seek(0)
        playlist_name = playlist['name']
        safe_name = re.sub(r'[^a-zA-Z0-9_\- ]', '', playlist_name)
        if not safe_name:
            safe_name = f"playlist_{playlist_id}"
        zip_filename = f"{safe_name}.zip"
        
        return send_file(
            memory_file,
            mimetype='application/zip',
            as_attachment=True,
            download_name=zip_filename
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/export', methods=['GET'])
@require_auth
def export_playlist(playlist_id):
    """Export a playlist as M3U or CSV file.

    Query params:
        format: 'm3u' (default) or 'csv'
    """
    try:
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404

        # Read check: owner, accepted collaborator, or legacy public.
        if playlist.get('owner_user_id') is not None and \
                not PlaylistShareModel.can_view(session.get('user_id'), playlist_id):
            return jsonify({'error': 'Forbidden'}), 403

        songs = PlaylistModel.get_playlist_songs(playlist_id)
        from models.library_access import LibraryAccessModel
        songs = LibraryAccessModel.filter_visible(
            session.get('user_id'), songs or [])
        if not songs:
            return jsonify({'error': 'Playlist is empty'}), 400

        from models.settings import SettingsModel
        music_path = SettingsModel.get_music_path()

        export_format = request.args.get('format', 'm3u').lower()
        playlist_name = playlist['name']
        import re
        safe_name = re.sub(r'[^a-zA-Z0-9_\- ]', '', playlist_name)
        if not safe_name:
            safe_name = f"playlist_{playlist_id}"

        if export_format == 'csv':
            import csv
            import io
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(['Title', 'Artist', 'Album', 'Duration', 'Genre', 'Year', 'File Path'])
            for song in songs:
                duration_secs = song.get('duration') or 0
                writer.writerow([
                    song.get('title', ''),
                    song.get('artist', ''),
                    song.get('album', ''),
                    f"{int(duration_secs // 60)}:{int(duration_secs % 60):02d}" if duration_secs else '',
                    song.get('genre', ''),
                    song.get('year', ''),
                    song.get('file_path', '')
                ])
            content = output.getvalue()
            from flask import Response
            return Response(
                content,
                mimetype='text/csv',
                headers={
                    'Content-Disposition': f'attachment; filename="{safe_name}.csv"',
                    'Content-Type': 'text/csv; charset=utf-8'
                }
            )
        else:
            # M3U format (extended M3U with metadata)
            lines = ['#EXTM3U']
            for song in songs:
                duration_secs = int(song.get('duration') or -1)
                artist = song.get('artist', 'Unknown Artist')
                title = song.get('title', 'Unknown Title')
                lines.append(f'#EXTINF:{duration_secs},{artist} - {title}')
                # Use full file path for M3U compatibility
                file_path = song.get('file_path', '')
                if music_path and file_path:
                    import os
                    full_path = os.path.normpath(os.path.join(music_path, file_path))
                    lines.append(full_path)
                else:
                    lines.append(file_path)
            content = '\n'.join(lines) + '\n'
            from flask import Response
            return Response(
                content,
                mimetype='audio/x-mpegurl',
                headers={
                    'Content-Disposition': f'attachment; filename="{safe_name}.m3u"',
                    'Content-Type': 'audio/x-mpegurl; charset=utf-8'
                }
            )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ── Playlist sharing ─────────────────────────────────────────────────


def _require_owner(playlist_id):
    """Return (playlist, error_response). The caller must be the owner."""
    playlist = PlaylistModel.get_playlist_by_id(playlist_id)
    if not playlist:
        return None, (jsonify({'error': 'Playlist not found'}), 404)
    if playlist.get('owner_user_id') is None:
        return None, (jsonify({'error': 'This legacy playlist has no owner to share it'}), 400)
    if playlist.get('owner_user_id') != session.get('user_id'):
        return None, (jsonify({'error': 'Forbidden'}), 403)
    return playlist, None


@playlists_bp.route('/invites', methods=['GET'])
@require_auth
def my_playlist_invites():
    """Playlist invites awaiting the current user's response."""
    try:
        return jsonify({'invites': PlaylistShareModel.pending_for(session['user_id'])})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/invites/<int:share_id>/accept', methods=['POST'])
@require_auth
def accept_playlist_invite(share_id):
    """Accept a playlist invite: the playlist appears in your account and
    you can edit it (role 'editor')."""
    try:
        share = PlaylistShareModel.find_share(share_id)
        if not share or share['user_id'] != session.get('user_id'):
            return jsonify({'error': 'Invite not found'}), 404
        if share['status'] == 'accepted':
            return jsonify({'success': True, 'message': 'Already accepted'})
        PlaylistShareModel.accept(share_id)
        return jsonify({'success': True, 'message': 'Playlist added to your library'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/invites/<int:share_id>/decline', methods=['POST'])
@require_auth
def decline_playlist_invite(share_id):
    """Decline a playlist invite."""
    try:
        share = PlaylistShareModel.find_share(share_id)
        if not share or share['user_id'] != session.get('user_id'):
            return jsonify({'error': 'Invite not found'}), 404
        PlaylistShareModel.decline(share_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/shares', methods=['GET'])
@require_auth
def list_shares(playlist_id):
    """Everyone with a share on this playlist (pending + accepted)."""
    try:
        playlist, err = _require_owner(playlist_id)
        if err:
            return err
        return jsonify({'shares': PlaylistShareModel.by_playlist(playlist_id)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/shares', methods=['POST'])
@require_auth
def invite_to_playlist(playlist_id):
    """Invite a FRIEND to collaborate on this playlist (owner only)."""
    try:
        playlist, err = _require_owner(playlist_id)
        if err:
            return err

        data = request.get_json() or {}
        friend_id = data.get('user_id')
        if not friend_id:
            return jsonify({'error': 'user_id is required'}), 400

        from models.friendship import FriendshipModel
        if not FriendshipModel.are_friends(session['user_id'], friend_id):
            return jsonify({'error': 'You can only invite friends to a playlist'}), 403

        status, row = PlaylistShareModel.invite(playlist_id, friend_id, session['user_id'])
        if row is None:
            return jsonify({'error': 'That friend already has access to this playlist'}), 409

        from models.user import UserModel
        friend = UserModel.get_user_by_id(friend_id)
        if not friend:
            return jsonify({'error': 'User not found'}), 404

        if status == 'already_pending':
            return jsonify({'success': True, 'message': f'Invite to {friend["username"]} is already pending'})
        return jsonify({'success': True, 'message': f'Invited {friend["username"]} to the playlist'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/shares/<int:share_id>', methods=['DELETE'])
@require_auth
def revoke_share(playlist_id, share_id):
    """Owner revokes a collaborator's access (pending or accepted)."""
    try:
        playlist, err = _require_owner(playlist_id)
        if err:
            return err
        share = PlaylistShareModel.find_share(share_id)
        if not share or share['playlist_id'] != playlist_id:
            return jsonify({'error': 'Share not found'}), 404
        if share['user_id'] == session['user_id']:
            return jsonify({'error': 'The owner cannot revoke their own access'}), 400
        PlaylistShareModel.revoke(playlist_id, share['user_id'])
        return jsonify({'success': True, 'message': 'Access revoked'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/shares/<int:share_id>/leave', methods=['POST'])
@require_auth
def leave_playlist(share_id):
    """A collaborator removes the shared playlist from their account.
    The playlist itself (and the owner's other shares) is untouched."""
    try:
        share = PlaylistShareModel.find_share(share_id)
        if not share or share['user_id'] != session.get('user_id'):
            return jsonify({'error': 'Share not found'}), 404
        if share['status'] != 'accepted':
            return jsonify({'error': 'Invite is not accepted yet'}), 400
        PlaylistShareModel.leave(share_id, session['user_id'])
        return jsonify({'success': True, 'message': 'Playlist removed from your library'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@playlists_bp.route('/<int:playlist_id>/leave', methods=['POST'])
@require_auth
def leave_playlist_by_id(playlist_id):
    """"Leave" from the UI: removes YOUR accepted share of this playlist
    (no share id needed). Owner cannot leave their own playlist."""
    try:
        user_id = session['user_id']
        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if not playlist:
            return jsonify({'error': 'Playlist not found'}), 404
        if playlist.get('owner_user_id') == user_id:
            return jsonify({'error': 'You own this playlist'}), 400
        share_id = PlaylistShareModel.leave_playlist(playlist_id, user_id)
        if share_id is None:
            return jsonify({'error': 'This playlist is not shared with you'}), 404
        return jsonify({'success': True, 'message': 'Playlist removed from your library'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
