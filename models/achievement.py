"""
Achievement system for Rainy.

Achievements are defined in code (not DB) and evaluated against existing
tracking data (play_history, song_ratings, playlists). Unlocked achievements
are persisted per-user so both web and mobile see the same state.

Evaluation is triggered:
  - After each play recording (lightweight: play-count achievements only)
  - On explicit request (full re-evaluation of all categories)
"""

from models.database import Database

# ─── Achievement Definitions ─────────────────────────────────────────────────
# Each achievement: id, name, description, icon (emoji), category, metric, threshold
# metric is a key returned by _compute_metrics()

ACHIEVEMENTS = [
    # ── Listening milestones ──
    {"id": "first_play", "name": "First Play", "description": "Play your first song", "icon": "🎵", "category": "listening", "metric": "total_plays", "threshold": 1},
    {"id": "plays_10", "name": "Getting Started", "description": "Play 10 songs", "icon": "🎶", "category": "listening", "metric": "total_plays", "threshold": 10},
    {"id": "plays_100", "name": "Music Lover", "description": "Play 100 songs", "icon": "🎧", "category": "listening", "metric": "total_plays", "threshold": 100},
    {"id": "plays_500", "name": "Addicted", "description": "Play 500 songs", "icon": "🔥", "category": "listening", "metric": "total_plays", "threshold": 500},
    {"id": "plays_1000", "name": "Obsessed", "description": "Play 1,000 songs", "icon": "⚡", "category": "listening", "metric": "total_plays", "threshold": 1000},
    {"id": "plays_5000", "name": "Legend", "description": "Play 5,000 songs", "icon": "👑", "category": "listening", "metric": "total_plays", "threshold": 5000},

    # ── Discovery ──
    {"id": "songs_10", "name": "Explorer", "description": "Listen to 10 unique songs", "icon": "🔍", "category": "discovery", "metric": "unique_songs", "threshold": 10},
    {"id": "songs_50", "name": "Curious", "description": "Listen to 50 unique songs", "icon": "🧭", "category": "discovery", "metric": "unique_songs", "threshold": 50},
    {"id": "songs_200", "name": "Adventurer", "description": "Listen to 200 unique songs", "icon": "🗺️", "category": "discovery", "metric": "unique_songs", "threshold": 200},
    {"id": "songs_500", "name": "Collector", "description": "Listen to 500 unique songs", "icon": "💎", "category": "discovery", "metric": "unique_songs", "threshold": 500},
    {"id": "artists_5", "name": "Artist Fan", "description": "Listen to 5 unique artists", "icon": "🎤", "category": "discovery", "metric": "unique_artists", "threshold": 5},
    {"id": "artists_20", "name": "Musicologist", "description": "Listen to 20 unique artists", "icon": "🎼", "category": "discovery", "metric": "unique_artists", "threshold": 20},
    {"id": "artists_50", "name": "A&R Scout", "description": "Listen to 50 unique artists", "icon": "🌟", "category": "discovery", "metric": "unique_artists", "threshold": 50},
    {"id": "genres_5", "name": "Genre Hopper", "description": "Listen to 5 unique genres", "icon": "🎨", "category": "discovery", "metric": "unique_genres", "threshold": 5},
    {"id": "genres_10", "name": "Eclectic", "description": "Listen to 10 unique genres", "icon": "🌈", "category": "discovery", "metric": "unique_genres", "threshold": 10},

    # ── Engagement ──
    {"id": "first_like", "name": "First Like", "description": "Like your first song", "icon": "❤️", "category": "engagement", "metric": "total_likes", "threshold": 1},
    {"id": "likes_10", "name": "Curator", "description": "Like 10 songs", "icon": "💕", "category": "engagement", "metric": "total_likes", "threshold": 10},
    {"id": "likes_50", "name": "Tastemaker", "description": "Like 50 songs", "icon": "🏆", "category": "engagement", "metric": "total_likes", "threshold": 50},
    {"id": "likes_200", "name": "Connoisseur", "description": "Like 200 songs", "icon": "🎖️", "category": "engagement", "metric": "total_likes", "threshold": 200},
    {"id": "playlist_1", "name": "Playlist Maker", "description": "Create your first playlist", "icon": "📋", "category": "engagement", "metric": "playlists_created", "threshold": 1},
    {"id": "playlist_5", "name": "Organizer", "description": "Create 5 playlists", "icon": "📚", "category": "engagement", "metric": "playlists_created", "threshold": 5},

    # ── Dedication ──
    {"id": "time_1h", "name": "Hour One", "description": "Listen for 1 hour total", "icon": "⏱️", "category": "dedication", "metric": "total_hours", "threshold": 1},
    {"id": "time_24h", "name": "Day Dreamer", "description": "Listen for 24 hours total", "icon": "🌙", "category": "dedication", "metric": "total_hours", "threshold": 24},
    {"id": "time_168h", "name": "Week Warrior", "description": "Listen for 1 week total", "icon": "📅", "category": "dedication", "metric": "total_hours", "threshold": 168},
    {"id": "days_7", "name": "Regular", "description": "Be active for 7 days", "icon": "📆", "category": "dedication", "metric": "active_days", "threshold": 7},
    {"id": "days_30", "name": "Devoted", "description": "Be active for 30 days", "icon": "🗓️", "category": "dedication", "metric": "active_days", "threshold": 30},
    {"id": "days_100", "name": "Veteran", "description": "Be active for 100 days", "icon": "🏅", "category": "dedication", "metric": "active_days", "threshold": 100},
]

# Fast lookup
_ACHIEVEMENT_MAP = {a["id"]: a for a in ACHIEVEMENTS}

# Achievements that only depend on play count (checked after every play)
_PLAY_COUNT_ACHIEVEMENTS = [a for a in ACHIEVEMENTS if a["metric"] == "total_plays"]


class AchievementModel:
    """Manages achievement state per user."""

    @staticmethod
    def init_table():
        """Create the user_achievements table if it doesn't exist."""
        Database.execute_query("""
            CREATE TABLE IF NOT EXISTS user_achievements (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                achievement_id VARCHAR(64) NOT NULL,
                unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_user_achievement (user_id, achievement_id),
                INDEX idx_user (user_id)
            )
        """)

    @staticmethod
    def _compute_metrics(user_id):
        """Compute all achievement metrics from existing tracking data."""
        metrics = {}

        # Total plays
        row = Database.execute_query(
            "SELECT COUNT(*) as cnt FROM play_history WHERE user_id = %s",
            (user_id,), fetch_one=True
        )
        metrics["total_plays"] = row["cnt"] if row else 0

        # Unique songs
        row = Database.execute_query(
            "SELECT COUNT(DISTINCT song_id) as cnt FROM play_history WHERE user_id = %s",
            (user_id,), fetch_one=True
        )
        metrics["unique_songs"] = row["cnt"] if row else 0

        # Unique artists
        row = Database.execute_query(
            """SELECT COUNT(DISTINCT s.artist) as cnt
               FROM play_history ph JOIN songs s ON ph.song_id = s.id
               WHERE ph.user_id = %s""",
            (user_id,), fetch_one=True
        )
        metrics["unique_artists"] = row["cnt"] if row else 0

        # Unique genres
        row = Database.execute_query(
            """SELECT COUNT(DISTINCT s.genre) as cnt
               FROM play_history ph JOIN songs s ON ph.song_id = s.id
               WHERE ph.user_id = %s AND s.genre IS NOT NULL AND s.genre != ''""",
            (user_id,), fetch_one=True
        )
        metrics["unique_genres"] = row["cnt"] if row else 0

        # Total likes
        row = Database.execute_query(
            "SELECT COUNT(*) as cnt FROM song_ratings WHERE user_id = %s AND rating = 'like'",
            (user_id,), fetch_one=True
        )
        metrics["total_likes"] = row["cnt"] if row else 0

        # Playlists created
        row = Database.execute_query(
            "SELECT COUNT(*) as cnt FROM playlists WHERE owner_user_id = %s",
            (user_id,), fetch_one=True
        )
        metrics["playlists_created"] = row["cnt"] if row else 0

        # Total listening hours (sum of duration from play_history)
        row = Database.execute_query(
            "SELECT COALESCE(SUM(duration), 0) as total_sec FROM play_history WHERE user_id = %s",
            (user_id,), fetch_one=True
        )
        metrics["total_hours"] = round((row["total_sec"] if row else 0) / 3600, 2)

        # Active days
        row = Database.execute_query(
            "SELECT COUNT(DISTINCT DATE(played_at)) as cnt FROM play_history WHERE user_id = %s",
            (user_id,), fetch_one=True
        )
        metrics["active_days"] = row["cnt"] if row else 0

        return metrics

    @staticmethod
    def get_unlocked_ids(user_id):
        """Get set of achievement IDs already unlocked for this user."""
        rows = Database.execute_query(
            "SELECT achievement_id FROM user_achievements WHERE user_id = %s",
            (user_id,), fetch_all=True
        )
        return {r["achievement_id"] for r in rows} if rows else set()

    @staticmethod
    def unlock(user_id, achievement_id):
        """Record an achievement unlock. Ignores duplicates."""
        Database.execute_query(
            "INSERT IGNORE INTO user_achievements (user_id, achievement_id) VALUES (%s, %s)",
            (user_id, achievement_id)
        )

    @staticmethod
    def evaluate(user_id, achievements=None):
        """
        Evaluate achievements against current metrics.
        Returns list of NEWLY unlocked achievement IDs.
        If achievements is None, evaluates all. Otherwise only the given list.
        """
        to_check = achievements if achievements else ACHIEVEMENTS
        if not to_check:
            return []

        metrics = AchievementModel._compute_metrics(user_id)
        unlocked = AchievementModel.get_unlocked_ids(user_id)
        newly = []

        for ach in to_check:
            if ach["id"] in unlocked:
                continue
            value = metrics.get(ach["metric"], 0)
            if value >= ach["threshold"]:
                AchievementModel.unlock(user_id, ach["id"])
                newly.append(ach["id"])

        return newly

    @staticmethod
    def evaluate_play_count(user_id):
        """Lightweight check: only play-count achievements (called after each play)."""
        return AchievementModel.evaluate(user_id, _PLAY_COUNT_ACHIEVEMENTS)

    @staticmethod
    def get_all_with_progress(user_id):
        """
        Return all achievements with unlock status and progress for the user.
        Used by the achievements page.
        """
        metrics = AchievementModel._compute_metrics(user_id)
        unlocked = AchievementModel.get_unlocked_ids(user_id)

        # Get unlock timestamps
        rows = Database.execute_query(
            "SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = %s",
            (user_id,), fetch_all=True
        )
        unlock_times = {r["achievement_id"]: str(r["unlocked_at"]) for r in rows} if rows else {}

        result = []
        for ach in ACHIEVEMENTS:
            value = metrics.get(ach["metric"], 0)
            is_unlocked = ach["id"] in unlocked
            progress = min(value / ach["threshold"], 1.0) if ach["threshold"] > 0 else 1.0
            result.append({
                "id": ach["id"],
                "name": ach["name"],
                "description": ach["description"],
                "icon": ach["icon"],
                "category": ach["category"],
                "threshold": ach["threshold"],
                "progress": round(progress, 4),
                "current": value,
                "unlocked": is_unlocked,
                "unlocked_at": unlock_times.get(ach["id"]),
            })

        return result

    @staticmethod
    def get_summary(user_id):
        """Quick summary: total unlocked / total available."""
        unlocked = AchievementModel.get_unlocked_ids(user_id)
        return {
            "unlocked": len(unlocked),
            "total": len(ACHIEVEMENTS),
            "unlocked_ids": list(unlocked),
        }
