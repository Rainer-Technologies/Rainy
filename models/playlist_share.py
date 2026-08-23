"""Playlist sharing model — invites that let friends collaborate on a
playlist. role is the collaborator tier ('editor' today; 'viewer' and
others can be added later without schema changes). status pending ->
accepted: a playlist only appears in the invitee's account once they
accept.
"""
from .database import Database


class PlaylistShareModel:
    @staticmethod
    def invite(playlist_id, user_id, invited_by):
        """Invite a user to a playlist. Returns (status, row):
        'pending' new invite, 'already_pending', or (None, None) if the
        user already has an accepted share."""
        existing = Database.execute_query(
            "SELECT * FROM playlist_shares "
            "WHERE playlist_id = %s AND user_id = %s",
            (playlist_id, user_id), fetch_one=True)
        if existing:
            if existing['status'] == 'accepted':
                return None, None
            return 'already_pending', existing

        insert_id = Database.execute_query(
            "INSERT INTO playlist_shares (playlist_id, user_id, invited_by, role) "
            "VALUES (%s, %s, %s, 'editor')", (playlist_id, user_id, invited_by))
        return 'pending', {'id': insert_id}

    @staticmethod
    def can_view(user_id, playlist_id):
        """Owner or accepted collaborator can open the playlist."""
        if PlaylistShareModel.is_owner(user_id, playlist_id):
            return True
        row = Database.execute_query(
            "SELECT 1 FROM playlist_shares "
            "WHERE playlist_id = %s AND user_id = %s AND status = 'accepted' "
            "LIMIT 1", (playlist_id, user_id), fetch_one=True)
        return row is not None

    @staticmethod
    def can_edit(user_id, playlist_id):
        """Only the owner or an accepted collaborator can modify. (The
        legacy ownerless playlists were editable by everyone pre-isolation;
        the routes keep that legacy behaviour and skip this check when
        there is no owner.)"""
        if PlaylistShareModel.is_owner(user_id, playlist_id):
            return True
        row = Database.execute_query(
            "SELECT 1 FROM playlist_shares "
            "WHERE playlist_id = %s AND user_id = %s AND status = 'accepted' "
            "AND role IN ('editor') LIMIT 1", (playlist_id, user_id), fetch_one=True)
        return row is not None

    @staticmethod
    def is_owner(user_id, playlist_id):
        row = Database.execute_query(
            "SELECT owner_user_id FROM playlists WHERE id = %s",
            (playlist_id,), fetch_one=True)
        return bool(row and row.get('owner_user_id') == user_id)

    @staticmethod
    def user_role(user_id, playlist_id):
        """The requesting user's relationship to a playlist:
        'owner' | 'editor' | 'viewer' | None."""
        if PlaylistShareModel.is_owner(user_id, playlist_id):
            return 'owner'
        row = Database.execute_query(
            "SELECT role FROM playlist_shares "
            "WHERE playlist_id = %s AND user_id = %s AND status = 'accepted' "
            "LIMIT 1", (playlist_id, user_id), fetch_one=True)
        if row:
            return row['role']
        return None

    @staticmethod
    def by_playlist(playlist_id):
        """All shares of a playlist with invitee profile info."""
        query = """
            SELECT ps.id, ps.user_id, ps.role, ps.status, ps.created_at,
                   u.username, u.email
            FROM playlist_shares ps
            JOIN users u ON u.id = ps.user_id
            WHERE ps.playlist_id = %s
            ORDER BY ps.status, ps.created_at
        """
        return Database.execute_query(query, (playlist_id,), fetch_all=True) or []

    @staticmethod
    def pending_for(user_id):
        """Playlist invites awaiting user_id's response, with playlist
        + inviter info."""
        query = """
            SELECT ps.id, ps.playlist_id, ps.invited_by, ps.status, ps.created_at,
                   p.name AS playlist_name, p.icon, p.icon_color,
                   u.username AS invited_by_username, u.email AS invited_by_email
            FROM playlist_shares ps
            JOIN playlists p ON p.id = ps.playlist_id
            JOIN users u ON u.id = ps.invited_by
            WHERE ps.user_id = %s AND ps.status = 'pending'
            ORDER BY ps.created_at DESC
        """
        return Database.execute_query(query, (user_id,), fetch_all=True) or []

    @staticmethod
    def find_share(share_id):
        return Database.execute_query(
            "SELECT * FROM playlist_shares WHERE id = %s",
            (share_id,), fetch_one=True)

    @staticmethod
    def accept(share_id):
        return Database.execute_query(
            "UPDATE playlist_shares SET status = 'accepted', responded_at = NOW() "
            "WHERE id = %s", (share_id,))

    @staticmethod
    def decline(share_id):
        return Database.execute_query(
            "DELETE FROM playlist_shares WHERE id = %s", (share_id,))

    @staticmethod
    def revoke(playlist_id, user_id):
        """Owner removes a collaborator (any status)."""
        return Database.execute_query(
            "DELETE FROM playlist_shares WHERE playlist_id = %s AND user_id = %s",
            (playlist_id, user_id))

    @staticmethod
    def leave(share_id, user_id):
        """Collaborator removes themselves from a playlist."""
        return Database.execute_query(
            "DELETE FROM playlist_shares WHERE id = %s AND user_id = %s AND "
            "status = 'accepted'", (share_id, user_id))

    @staticmethod
    def leave_playlist(playlist_id, user_id):
        """Collaborator removes themselves from a playlist (by playlist id,
        no share id needed). Returns the deleted share's id or None."""
        row = Database.execute_query(
            "SELECT id FROM playlist_shares "
            "WHERE playlist_id = %s AND user_id = %s AND status = 'accepted' "
            "LIMIT 1", (playlist_id, user_id), fetch_one=True)
        if not row:
            return None
        Database.execute_query(
            "DELETE FROM playlist_shares WHERE id = %s", (row['id'],))
        return row['id']