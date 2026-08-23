from .database import Database

class PlaylistModel:
    @staticmethod
    def create_playlist(name, icon='music-note', icon_color='#888888', owner_user_id=None):
        """Create a new playlist with optional icon, color, and owner."""
        if owner_user_id is None:
            query = "INSERT INTO playlists (name, icon, icon_color) VALUES (%s, %s, %s)"
            return Database.execute_query(query, (name, icon, icon_color))
        else:
            query = "INSERT INTO playlists (name, icon, icon_color, owner_user_id) VALUES (%s, %s, %s, %s)"
            return Database.execute_query(query, (name, icon, icon_color, owner_user_id))
    
    @staticmethod
    def get_all_playlists_for_user(user_id):
        """Get playlists visible to a user: public, owned, or shared with
        them (accepted shares). Marks shared ones and their role so the UI
        can group them, and includes the owner's username.

        Includes a song_count so clients can show the number of tracks
        without fetching every playlist's full song list.
        """
        query = """
            SELECT p.*,
                   (SELECT COUNT(*) FROM playlist_entries pe
                    WHERE pe.playlist_id = p.id) AS song_count,
                   CASE WHEN ps.user_id IS NOT NULL THEN 1 ELSE 0 END AS shared,
                   ps.role AS share_role,
                   owner.username AS owner_username
            FROM playlists p
            LEFT JOIN playlist_shares ps
                   ON ps.playlist_id = p.id AND ps.user_id = %s AND ps.status = 'accepted'
            LEFT JOIN users owner ON owner.id = p.owner_user_id
            WHERE p.owner_user_id IS NULL OR p.owner_user_id = %s
               OR ps.user_id IS NOT NULL
            ORDER BY p.name
        """
        return Database.execute_query(query, (user_id, user_id), fetch_all=True)
    
    @staticmethod
    def get_playlist_by_id(playlist_id):
        """Get a specific playlist by ID."""
        query = "SELECT * FROM playlists WHERE id = %s"
        return Database.execute_query(query, (playlist_id,), fetch_one=True)

    @staticmethod
    def get_playlist_by_name(name, owner_user_id=None):
        """Find an existing playlist by exact (case-insensitive) name.

        With owner_user_id: only that user's OWN playlists match (per-account
        isolation — another account's same-named playlist must never be
        reused/merged). Without: any playlist (legacy global lookup).
        """
        if owner_user_id is not None:
            query = ("SELECT * FROM playlists WHERE LOWER(name) = LOWER(%s)"
                     " AND owner_user_id = %s LIMIT 1")
            return Database.execute_query(
                query, (name, owner_user_id), fetch_one=True)
        query = "SELECT * FROM playlists WHERE LOWER(name) = LOWER(%s) LIMIT 1"
        return Database.execute_query(query, (name,), fetch_one=True)

    @staticmethod
    def clear_playlist_entries(playlist_id):
        """Remove every song from a playlist (used by override imports)."""
        query = "DELETE FROM playlist_entries WHERE playlist_id = %s"
        return Database.execute_query(query, (playlist_id,))
    
    @staticmethod
    def delete_playlist(playlist_id):
        """Delete a playlist."""
        query = "DELETE FROM playlists WHERE id = %s"
        return Database.execute_query(query, (playlist_id,))
    
    @staticmethod
    def update_playlist_name(playlist_id, new_name):
        """Rename a playlist."""
        query = "UPDATE playlists SET name = %s WHERE id = %s"
        return Database.execute_query(query, (new_name, playlist_id))
    
    @staticmethod
    def update_playlist_appearance(playlist_id, icon, icon_color):
        """Update a playlist's icon and color."""
        query = "UPDATE playlists SET icon = %s, icon_color = %s WHERE id = %s"
        return Database.execute_query(query, (icon, icon_color, playlist_id))

    @staticmethod
    def update_playlist_cover(playlist_id, cover_path):
        """Set the auto-generated cover image path (relative to music_path)."""
        query = "UPDATE playlists SET cover_path = %s WHERE id = %s"
        return Database.execute_query(query, (cover_path, playlist_id))
    
    @staticmethod
    def update_playlist_privacy(playlist_id, owner_user_id):
        """Set playlist owner; if None, make public, else private to owner."""
        if owner_user_id is None:
            query = "UPDATE playlists SET owner_user_id = NULL WHERE id = %s"
            return Database.execute_query(query, (playlist_id,))
        else:
            query = "UPDATE playlists SET owner_user_id = %s WHERE id = %s"
            return Database.execute_query(query, (owner_user_id, playlist_id))
    
    @staticmethod
    def remove_duplicate_entries(playlist_id):
        """
        Remove duplicate songs from a playlist, keeping only the first occurrence.
        Returns the number of duplicates removed.
        """
        # Find duplicates: keep the entry with the lowest id for each track_id
        query = """
            DELETE pe1 FROM playlist_entries pe1
            INNER JOIN playlist_entries pe2
            WHERE pe1.playlist_id = %s
            AND pe1.track_id = pe2.track_id
            AND pe1.playlist_id = pe2.playlist_id
            AND pe1.id > pe2.id
        """
        conn = Database.get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute(query, (playlist_id,))
            conn.commit()
            deleted_count = cursor.rowcount
            cursor.close()
            return deleted_count
        finally:
            conn.close()
    
    @staticmethod
    def add_song_to_playlist(playlist_id, track_id):
        # Check if song already exists in playlist first
        check_query = "SELECT id FROM playlist_entries WHERE playlist_id = %s AND track_id = %s"
        existing = Database.execute_query(check_query, (playlist_id, track_id), fetch_one=True)
        if existing:
            return  # Skip if already in playlist
        
        # Get next order number
        order_query = "SELECT MAX(order_num) as max_order FROM playlist_entries WHERE playlist_id = %s"
        result = Database.execute_query(order_query, (playlist_id,), fetch_one=True)
        next_order = (result['max_order'] + 1) if result and result['max_order'] is not None else 1
        
        # Explicit query construction
        query = "INSERT INTO playlist_entries (playlist_id, track_id, order_num) VALUES (%s, %s, %s)"
        print(f"DEBUG: Executing insert: {query} with params {playlist_id}, {track_id}, {next_order}")
        return Database.execute_query(query, (playlist_id, track_id, next_order))
    
    @staticmethod
    def remove_song_from_playlist(playlist_id, track_id):
        """Remove a song from a playlist."""
        # For now, remove all instances of this song from the playlist
        # If we supported duplicate songs, we'd need the linking instance ID
        query = "DELETE FROM playlist_entries WHERE playlist_id = %s AND track_id = %s"
        return Database.execute_query(query, (playlist_id, track_id))

    @staticmethod
    def get_playlist_songs(playlist_id):
        """Get all songs in a playlist with their details."""
        query = """
            SELECT s.*, ps.order_num, ps.added_at 
            FROM songs s
            JOIN playlist_entries ps ON s.id = ps.track_id
            WHERE ps.playlist_id = %s
            ORDER BY ps.order_num ASC
        """
        return Database.execute_query(query, (playlist_id,), fetch_all=True)

    @staticmethod
    def reorder_songs(playlist_id, ordered_track_ids):
        """Reorder playlist songs by assigning sequential order_num values.

        Args:
            playlist_id: The playlist to reorder.
            ordered_track_ids: List of track IDs in the desired order.
        """
        conn = Database.get_connection()
        try:
            cursor = conn.cursor()
            for index, track_id in enumerate(ordered_track_ids):
                cursor.execute(
                    "UPDATE playlist_entries SET order_num = %s WHERE playlist_id = %s AND track_id = %s",
                    (index + 1, playlist_id, track_id)
                )
            conn.commit()
            cursor.close()
            return True
        finally:
            conn.close()
