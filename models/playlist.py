from .database import Database

class PlaylistModel:
    @staticmethod
    def create_playlist(name, icon='music-note', icon_color='#888888'):
        """Create a new playlist with optional icon and color."""
        query = "INSERT INTO playlists (name, icon, icon_color) VALUES (%s, %s, %s)"
        return Database.execute_query(query, (name, icon, icon_color))
    
    @staticmethod
    def get_all_playlists():
        """Get all playlists ordered by name."""
        query = "SELECT * FROM playlists ORDER BY name"
        return Database.execute_query(query, fetch_all=True)
    
    @staticmethod
    def get_playlist_by_id(playlist_id):
        """Get a specific playlist by ID."""
        query = "SELECT * FROM playlists WHERE id = %s"
        return Database.execute_query(query, (playlist_id,), fetch_one=True)
    
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
    def add_song_to_playlist(playlist_id, track_id):
        """Add a song to a playlist. Automatically sets order_num to be last."""
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
