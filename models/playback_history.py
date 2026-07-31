from datetime import timezone

from .database import Database


class PlaybackHistoryModel:
    @staticmethod
    def record_play(user_id, song_id, position=0, duration=0):
        """Record a song play event."""
        query = """
            INSERT INTO play_history (user_id, song_id, position, duration)
            VALUES (%s, %s, %s, %s)
        """
        return Database.execute_query(query, (user_id, song_id, position, duration))

    @staticmethod
    def get_recently_played(user_id, limit=50, offset=0):
        """Get recently played songs with play timestamps, deduplicated by song."""
        query = """
            SELECT ph.song_id, ph.played_at, ph.position, ph.duration as play_duration,
                   s.title, s.artist, s.album, s.duration, s.cover_path, s.genre, s.year,
                   s.track_number, s.file_path
            FROM play_history ph
            JOIN songs s ON ph.song_id = s.id
            WHERE ph.user_id = %s
              AND ph.id = (
                  SELECT MAX(ph2.id) FROM play_history ph2
                  WHERE ph2.user_id = ph.user_id AND ph2.song_id = ph.song_id
              )
            ORDER BY ph.played_at DESC
            LIMIT %s OFFSET %s
        """
        results = Database.execute_query(query, (user_id, limit, offset), fetch_all=True)
        songs = []
        for row in results:
            songs.append({
                'id': row['song_id'],
                'path': row['file_path'],
                'title': row['title'],
                'artist': row['artist'],
                'album': row['album'],
                'duration': row['duration'],
                'track': row['track_number'],
                'year': row['year'],
                'genre': row['genre'],
                'cover_path': row['cover_path'],
                # The DB stores UTC (container tz). Tag it as UTC so the
                # browser parses it as an absolute instant instead of misreading
                # a naive ISO string as local time (which made every song look
                # a fixed tz-offset old, e.g. always "2h ago" in CEST).
                'played_at': row['played_at'].replace(tzinfo=timezone.utc).isoformat() if row['played_at'] else None
            })
        return songs

    @staticmethod
    def get_play_counts(user_id, limit=50):
        """Get most played songs with play counts."""
        query = """
            SELECT ph.song_id, COUNT(*) as play_count,
                   s.title, s.artist, s.album, s.duration, s.cover_path,
                   s.genre, s.year, s.track_number, s.file_path
            FROM play_history ph
            JOIN songs s ON ph.song_id = s.id
            WHERE ph.user_id = %s
            GROUP BY ph.song_id
            ORDER BY play_count DESC
            LIMIT %s
        """
        results = Database.execute_query(query, (user_id, limit), fetch_all=True)
        songs = []
        for row in results:
            songs.append({
                'id': row['song_id'],
                'path': row['file_path'],
                'title': row['title'],
                'artist': row['artist'],
                'album': row['album'],
                'duration': row['duration'],
                'track': row['track_number'],
                'year': row['year'],
                'genre': row['genre'],
                'cover_path': row['cover_path'],
                'play_count': row['play_count']
            })
        return songs

    @staticmethod
    def get_top_artists(user_id, limit=20):
        """Get most listened artists by play count."""
        query = """
            SELECT s.artist, COUNT(*) as play_count, COUNT(DISTINCT s.id) as song_count
            FROM play_history ph
            JOIN songs s ON ph.song_id = s.id
            WHERE ph.user_id = %s
            GROUP BY s.artist
            ORDER BY play_count DESC
            LIMIT %s
        """
        return Database.execute_query(query, (user_id, limit), fetch_all=True)

    @staticmethod
    def get_top_genres(user_id, limit=10):
        """Get most listened genres by play count."""
        query = """
            SELECT s.genre, COUNT(*) as play_count
            FROM play_history ph
            JOIN songs s ON ph.song_id = s.id
            WHERE ph.user_id = %s AND s.genre IS NOT NULL AND s.genre != ''
            GROUP BY s.genre
            ORDER BY play_count DESC
            LIMIT %s
        """
        return Database.execute_query(query, (user_id, limit), fetch_all=True)

    @staticmethod
    def get_listening_stats(user_id):
        """Get aggregate listening statistics."""
        query = """
            SELECT COUNT(*) as total_plays,
                   COUNT(DISTINCT song_id) as unique_songs,
                   COUNT(DISTINCT DATE(played_at)) as active_days,
                   SUM(duration) as total_seconds
            FROM play_history
            WHERE user_id = %s
        """
        return Database.execute_query(query, (user_id,), fetch_one=True)

    @staticmethod
    def clear_history(user_id):
        """Clear all play history for a user."""
        query = "DELETE FROM play_history WHERE user_id = %s"
        return Database.execute_query(query, (user_id,))
