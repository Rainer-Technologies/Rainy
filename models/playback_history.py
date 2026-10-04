import time
from datetime import datetime, timezone

from .database import Database, IntegrityError, is_fk_violation

# A play reported by an offline client may be old, but never older than this.
MAX_PLAY_AGE_SECONDS = 30 * 24 * 3600
# A single listen can't plausibly exceed this (guards SUM(duration) against junk).
MAX_LISTEN_SECONDS = 24 * 3600
MAX_PLAY_ID_LEN = 64


class InvalidPlay(ValueError):
    """The payload can never succeed — clients must drop it instead of retrying."""


def _to_epoch_iso(epoch):
    if epoch is None:
        return None
    return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()


def _song_dict(row):
    return {
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
    }


def _num(value, default=0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number or number in (float('inf'), float('-inf')):
        return default
    return number


class PlaybackHistoryModel:
    @staticmethod
    def normalize_play(data):
        """Validate/clean one client play report; raises InvalidPlay."""
        if not isinstance(data, dict) or data.get('song_id') is None:
            raise InvalidPlay('song_id is required')
        try:
            song_id = int(data['song_id'])
        except (TypeError, ValueError):
            raise InvalidPlay('song_id must be an integer')
        if song_id <= 0:
            raise InvalidPlay('song_id must be positive')

        play_id = data.get('play_id')
        if play_id is not None:
            play_id = str(play_id).strip()
            if not play_id or len(play_id) > MAX_PLAY_ID_LEN:
                raise InvalidPlay('invalid play_id')

        client = data.get('client')
        client = str(client)[:16] if client else None

        duration = int(round(min(max(_num(data.get('duration')), 0), MAX_LISTEN_SECONDS)))
        position = int(round(min(max(_num(data.get('position')), 0), MAX_LISTEN_SECONDS)))
        # Legacy clients send no `counted`; every report they made was a
        # qualifying listen.
        counted = 1 if data.get('counted', True) else 0
        # Offline clients report how long ago the play started (relative, so a
        # skewed phone clock can't put plays in the future/past).
        age = min(max(_num(data.get('age_seconds')), 0), MAX_PLAY_AGE_SECONDS)

        return {
            'song_id': song_id,
            'play_id': play_id,
            'client': client,
            'duration': duration,
            'position': position,
            'counted': counted,
            'age': age,
        }

    @staticmethod
    def record_play(user_id, song_id, position=0, duration=0, play_id=None,
                    counted=True, age_seconds=0, client=None):
        """Record (or update) a listen.

        With a ``play_id`` the write is an upsert keyed on (user, play_id): a
        repeat report of the same listen raises its listened-seconds and
        promotes it to ``counted`` but never creates a second row.

        Raises InvalidPlay for unusable input and LookupError when the song
        no longer exists.
        """
        play = PlaybackHistoryModel.normalize_play({
            'song_id': song_id, 'position': position, 'duration': duration,
            'play_id': play_id, 'counted': counted, 'age_seconds': age_seconds,
            'client': client,
        })
        return PlaybackHistoryModel._insert(user_id, play)

    @staticmethod
    def _insert(user_id, play):
        # played_at is computed here and stored via FROM_UNIXTIME so it doesn't
        # depend on the DB session timezone (reads use UNIX_TIMESTAMP).
        played_epoch = int(time.time() - play['age'])
        query = """
            INSERT INTO play_history
                (user_id, song_id, position, duration, played_at, play_id, counted, client)
            VALUES (%s, %s, %s, %s, FROM_UNIXTIME(%s), %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                duration = GREATEST(duration, VALUES(duration)),
                counted = GREATEST(counted, VALUES(counted))
        """
        try:
            return Database.execute_query(query, (
                user_id, play['song_id'], play['position'], play['duration'],
                played_epoch, play['play_id'], play['counted'], play['client'],
            ))
        except IntegrityError as e:
            # FK violation: the song was deleted (or never existed).
            if is_fk_violation(e):
                raise LookupError('song not found')
            raise

    @staticmethod
    def record_plays(user_id, plays):
        """Record a batch (offline-queue flush). Each item is independent.

        Returns (recorded_play_ids_or_indexes, rejected) where ``rejected`` are
        items that can never succeed (bad payload / deleted song) so the client
        can drop them; anything else raises and the whole batch is retried.
        """
        recorded, rejected = [], []
        for idx, raw in enumerate(plays):
            key = raw.get('play_id') if isinstance(raw, dict) else None
            try:
                play = PlaybackHistoryModel.normalize_play(raw)
                PlaybackHistoryModel._insert(user_id, play)
                recorded.append(key if key is not None else idx)
            except (InvalidPlay, LookupError):
                rejected.append(key if key is not None else idx)
        return recorded, rejected

    @staticmethod
    def get_recently_played(user_id, limit=50, offset=0):
        """Recently played songs (one entry per song, newest listen first).

        Includes songs listened to for only a few seconds, so what you just
        started on one device shows up on the others straight away.
        """
        query = """
            SELECT r.song_id, UNIX_TIMESTAMP(r.last_played) AS played_epoch,
                   s.title, s.artist, s.album, s.duration, s.cover_path, s.genre,
                   s.year, s.track_number, s.file_path
            FROM (
                SELECT song_id, MAX(played_at) AS last_played, MAX(id) AS last_id
                FROM play_history
                WHERE user_id = %s
                GROUP BY song_id
                ORDER BY last_played DESC, last_id DESC
                LIMIT %s OFFSET %s
            ) r
            JOIN songs s ON s.id = r.song_id
            ORDER BY r.last_played DESC, r.last_id DESC
        """
        results = Database.execute_query(query, (user_id, limit, offset), fetch_all=True) or []
        songs = []
        for row in results:
            song = _song_dict(row)
            # ISO with explicit UTC offset so browsers/phones parse an absolute
            # instant regardless of their own timezone.
            song['played_at'] = _to_epoch_iso(row['played_epoch'])
            songs.append(song)
        return songs

    @staticmethod
    def get_play_counts(user_id, limit=50):
        """Most played songs (qualifying listens only), ties broken by recency."""
        query = """
            SELECT r.song_id, r.play_count, UNIX_TIMESTAMP(r.last_played) AS played_epoch,
                   s.title, s.artist, s.album, s.duration, s.cover_path, s.genre,
                   s.year, s.track_number, s.file_path
            FROM (
                SELECT song_id, COUNT(*) AS play_count,
                       MAX(played_at) AS last_played, MAX(id) AS last_id
                FROM play_history
                WHERE user_id = %s AND counted = 1
                GROUP BY song_id
                ORDER BY play_count DESC, last_played DESC, last_id DESC
                LIMIT %s
            ) r
            JOIN songs s ON s.id = r.song_id
            ORDER BY r.play_count DESC, r.last_played DESC, r.last_id DESC
        """
        results = Database.execute_query(query, (user_id, limit), fetch_all=True) or []
        songs = []
        for row in results:
            song = _song_dict(row)
            song['play_count'] = int(row['play_count'])
            song['last_played_at'] = _to_epoch_iso(row['played_epoch'])
            songs.append(song)
        return songs

    @staticmethod
    def get_top_artists(user_id, limit=20):
        """Most listened artists by qualifying play count."""
        query = """
            SELECT s.artist, COUNT(*) as play_count, COUNT(DISTINCT s.id) as song_count
            FROM play_history ph
            JOIN songs s ON ph.song_id = s.id
            WHERE ph.user_id = %s AND ph.counted = 1
            GROUP BY s.artist
            ORDER BY play_count DESC, s.artist ASC
            LIMIT %s
        """
        rows = Database.execute_query(query, (user_id, limit), fetch_all=True) or []
        for row in rows:
            row['play_count'] = int(row['play_count'])
            row['song_count'] = int(row['song_count'])
        return rows

    @staticmethod
    def get_top_genres(user_id, limit=10):
        """Most listened genres by qualifying play count."""
        query = """
            SELECT s.genre, COUNT(*) as play_count
            FROM play_history ph
            JOIN songs s ON ph.song_id = s.id
            WHERE ph.user_id = %s AND ph.counted = 1
              AND s.genre IS NOT NULL AND s.genre != ''
            GROUP BY s.genre
            ORDER BY play_count DESC, s.genre ASC
            LIMIT %s
        """
        rows = Database.execute_query(query, (user_id, limit), fetch_all=True) or []
        for row in rows:
            row['play_count'] = int(row['play_count'])
        return rows

    @staticmethod
    def get_listening_stats(user_id):
        """Aggregate listening statistics (qualifying listens only).

        All values are plain ints — SUM() comes back from MySQL as a Decimal
        that Flask serialises as a *string*, which is what used to make the
        listening-time tile read 0 on some clients.
        """
        query = """
            SELECT COUNT(*) as total_plays,
                   COUNT(DISTINCT song_id) as unique_songs,
                   COUNT(DISTINCT DATE(played_at)) as active_days,
                   COALESCE(SUM(duration), 0) as total_seconds
            FROM play_history
            WHERE user_id = %s AND counted = 1
        """
        row = Database.execute_query(query, (user_id,), fetch_one=True) or {}
        return {
            'total_plays': int(row.get('total_plays') or 0),
            'unique_songs': int(row.get('unique_songs') or 0),
            'active_days': int(row.get('active_days') or 0),
            'total_seconds': int(row.get('total_seconds') or 0),
        }

    @staticmethod
    def clear_history(user_id):
        """Clear all play history for a user."""
        query = "DELETE FROM play_history WHERE user_id = %s"
        return Database.execute_query(query, (user_id,))
