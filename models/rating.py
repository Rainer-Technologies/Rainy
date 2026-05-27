from .database import Database

class RatingModel:
    @staticmethod
    def set_rating(user_id, song_id, rating):
        """Add or update a rating (like/dislike) for a song."""
        query = """
            INSERT INTO song_ratings (user_id, song_id, rating)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE rating = %s
        """
        return Database.execute_query(query, (user_id, song_id, rating, rating))
    
    @staticmethod
    def remove_rating(user_id, song_id):
        """Remove a rating for a song."""
        query = "DELETE FROM song_ratings WHERE user_id = %s AND song_id = %s"
        return Database.execute_query(query, (user_id, song_id))
    
    @staticmethod
    def get_user_ratings(user_id):
        """Get all ratings for a user."""
        query = "SELECT song_id, rating, created_at FROM song_ratings WHERE user_id = %s"
        return Database.execute_query(query, (user_id,), fetch_all=True)
    
    @staticmethod
    def get_song_rating(user_id, song_id):
        """Get specific rating for a user and song."""
        query = "SELECT rating FROM song_ratings WHERE user_id = %s AND song_id = %s"
        result = Database.execute_query(query, (user_id, song_id), fetch_one=True)
        return result['rating'] if result else None

    @staticmethod
    def get_liked_songs(user_id):
        """Get all liked songs for a user with details."""
        query = """
            SELECT s.*, sr.created_at as liked_at
            FROM songs s
            JOIN song_ratings sr ON s.id = sr.song_id
            WHERE sr.user_id = %s AND sr.rating = 'like'
            ORDER BY sr.created_at DESC
        """
        return Database.execute_query(query, (user_id,), fetch_all=True)
