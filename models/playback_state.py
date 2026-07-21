import json
from .database import Database


class PlaybackStateModel:
    """Server-side playback state for cross-device sync."""

    @staticmethod
    def save_state(user_id, song_id, position, queue, queue_index, is_playing=False):
        """Save or update the user's playback state."""
        queue_json = json.dumps(queue) if queue else '[]'
        query = """
            INSERT INTO playback_state (user_id, song_id, position, queue, queue_index, is_playing)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                song_id = %s, position = %s, queue = %s,
                queue_index = %s, is_playing = %s,
                updated_at = CURRENT_TIMESTAMP
        """
        return Database.execute_query(query, (
            user_id, song_id, position, queue_json, queue_index, is_playing,
            song_id, position, queue_json, queue_index, is_playing
        ))

    @staticmethod
    def get_state(user_id):
        """Get the user's saved playback state."""
        query = """
            SELECT ps.song_id, ps.position, ps.queue, ps.queue_index,
                   ps.is_playing, ps.updated_at,
                   s.title, s.artist, s.album, s.duration, s.cover_path, s.file_path
            FROM playback_state ps
            LEFT JOIN songs s ON ps.song_id = s.id
            WHERE ps.user_id = %s
        """
        row = Database.execute_query(query, (user_id,), fetch_one=True)
        if not row:
            return None

        queue = []
        try:
            queue = json.loads(row['queue']) if row['queue'] else []
        except (json.JSONDecodeError, TypeError):
            queue = []

        return {
            'song_id': row['song_id'],
            'position': float(row['position']) if row['position'] else 0,
            'queue': queue,
            'queue_index': row['queue_index'] or 0,
            'is_playing': bool(row['is_playing']),
            'updated_at': row['updated_at'].isoformat() if row['updated_at'] else None,
            'song': {
                'id': row['song_id'],
                'path': row['file_path'],
                'title': row['title'],
                'artist': row['artist'],
                'album': row['album'],
                'duration': row['duration'],
                'cover_path': row['cover_path']
            } if row['song_id'] else None
        }

    @staticmethod
    def clear_state(user_id):
        """Clear the user's playback state."""
        query = "DELETE FROM playback_state WHERE user_id = %s"
        return Database.execute_query(query, (user_id,))
