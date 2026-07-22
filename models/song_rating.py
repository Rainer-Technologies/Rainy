from .database import Database
from datetime import datetime


class SongRatingModel:
    @staticmethod
    def set_rating(user_id, song_id, rating):
        """
        Insert or update a rating for a song.
        rating: 'like' or 'dislike'
        """
        query = """
            INSERT INTO song_ratings (user_id, song_id, rating)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE rating = %s, created_at = CURRENT_TIMESTAMP
        """
        return Database.execute_query(query, (user_id, song_id, rating, rating))

    @staticmethod
    def remove_rating(user_id, song_id):
        """Remove a rating for a song."""
        query = "DELETE FROM song_ratings WHERE user_id = %s AND song_id = %s"
        return Database.execute_query(query, (user_id, song_id))

    @staticmethod
    def get_rating(user_id, song_id):
        """Get the rating for a specific song."""
        query = """
            SELECT song_id, rating, created_at
            FROM song_ratings
            WHERE user_id = %s AND song_id = %s
        """
        return Database.execute_query(query, (user_id, song_id), fetch_one=True)

    @staticmethod
    def get_user_ratings(user_id, rating_type=None, limit=None, offset=None):
        """
        Get all ratings for a user, optionally filtered by type.
        Returns songs with their rating and timestamp.
        """
        query_parts = ["sr.song_id, sr.rating, sr.created_at, s.title, s.artist, s.album, s.duration, s.cover_path"]
        from_parts = ["FROM song_ratings sr", "JOIN songs s ON sr.song_id = s.id"]
        where_parts = ["WHERE sr.user_id = %s"]
        params = [user_id]
        
        if rating_type:
            where_parts.append("AND sr.rating = %s")
            params.append(rating_type)
        
        query = "SELECT " + ", ".join(query_parts) + " " + " ".join(from_parts) + " " + " ".join(where_parts)
        
        query += " ORDER BY sr.created_at DESC"
        
        if limit is not None:
            query += " LIMIT %s"
            params.append(limit)
            if offset is not None:
                query += " OFFSET %s"
                params.append(offset)
        
        return Database.execute_query(query, tuple(params), fetch_all=True)

    @staticmethod
    def get_ratings_for_songs(user_id, song_ids):
        """
        Get ratings for a list of songs.
        Returns dict mapping song_id -> {rating, created_at}
        """
        if not song_ids:
            return {}
        
        query = """
            SELECT song_id, rating, created_at
            FROM song_ratings
            WHERE user_id = %s AND song_id IN ({})
        """.format(', '.join(['%s'] * len(song_ids)))
        
        results = Database.execute_query(query, (user_id,) + tuple(song_ids), fetch_all=True)
        
        return {row['song_id']: {'rating': row['rating'], 'created_at': row['created_at']} 
                for row in results}

    @staticmethod
    def get_liked_song_ids(user_id):
        """Get list of song IDs that user has liked."""
        query = """
            SELECT song_id FROM song_ratings
            WHERE user_id = %s AND rating = 'like'
        """
        results = Database.execute_query(query, (user_id,), fetch_all=True)
        return [row['song_id'] for row in results]

    @staticmethod
    def get_disliked_song_ids(user_id):
        """Get list of song IDs that user has disliked."""
        query = """
            SELECT song_id FROM song_ratings
            WHERE user_id = %s AND rating = 'dislike'
        """
        results = Database.execute_query(query, (user_id,), fetch_all=True)
        return [row['song_id'] for row in results]

    @staticmethod
    def migrate_from_playlist(user_id, playlist_id):
        """
        Migrate likes from Liked Music playlist to song_ratings table.
        Returns the number of ratings migrated.
        """
        # Get all songs from the playlist with their added_at timestamp
        query = """
            SELECT s.id as song_id, ps.added_at
            FROM songs s
            JOIN playlist_entries ps ON s.id = ps.track_id
            WHERE ps.playlist_id = %s
        """
        results = Database.execute_query(query, (playlist_id,), fetch_all=True)
        
        migrated_count = 0
        for row in results:
            try:
                # Use INSERT IGNORE to skip duplicates
                insert_batch_query = """
                    INSERT IGNORE INTO song_ratings (user_id, song_id, rating, created_at)
                    VALUES (%s, %s, 'like', %s)
                """
                Database.execute_query(insert_batch_query, (user_id, row['song_id'], row['added_at']))
                migrated_count += 1
            except Exception as e:
                # Skip if duplicate or other error
                pass
        
        return migrated_count

    @staticmethod
    def delete_all_for_user(user_id):
        """Delete all ratings for a user (for cleanup/testing)."""
        query = "DELETE FROM song_ratings WHERE user_id = %s"
        return Database.execute_query(query, (user_id,))
