from .database import Database
from datetime import datetime


class SongModel:
    @staticmethod
    def add_song(song_data):
        """Insert a new song into the database."""
        # Deduplicate artist string before insert
        raw_artist = song_data.get('artist', 'Unknown Artist')
        if raw_artist and isinstance(raw_artist, str):
            seen = set()
            deduped = []
            for part in raw_artist.split(','):
                name = part.strip()
                if not name:
                    continue
                key = name.lower()
                if key not in seen:
                    seen.add(key)
                    deduped.append(name)
            if deduped:
                raw_artist = ', '.join(deduped)
        query = """
            INSERT INTO songs (file_path, title, artist, album, duration, 
                             track_number, year, genre, cover_path, file_size, file_modified)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        return Database.execute_query(query, (
            song_data['path'],
            song_data['title'],
            raw_artist,
            song_data.get('album', 'Unknown Album'),
            song_data.get('duration', 0),
            song_data.get('track', 0),
            song_data.get('year'),
            song_data.get('genre'),
            song_data.get('cover_path'),
            song_data.get('file_size'),
            song_data.get('file_modified')
        ))
    
    @staticmethod
    def update_song(file_path, song_data):
        """Update an existing song in the database."""
        raw_artist = song_data.get('artist', 'Unknown Artist')
        if raw_artist and isinstance(raw_artist, str):
            seen = set()
            deduped = []
            for part in raw_artist.split(','):
                name = part.strip()
                if not name:
                    continue
                key = name.lower()
                if key not in seen:
                    seen.add(key)
                    deduped.append(name)
            if deduped:
                raw_artist = ', '.join(deduped)
        query = """
            UPDATE songs 
            SET title = %s, artist = %s, album = %s, duration = %s,
                track_number = %s, year = %s, genre = %s, cover_path = %s,
                file_size = %s, file_modified = %s
            WHERE file_path = %s
        """
        return Database.execute_query(query, (
            song_data['title'],
            raw_artist,
            song_data.get('album', 'Unknown Album'),
            song_data.get('duration', 0),
            song_data.get('track', 0),
            song_data.get('year'),
            song_data.get('genre'),
            song_data.get('cover_path'),
            song_data.get('file_size'),
            song_data.get('file_modified'),
            file_path
        ))
    
    @staticmethod
    def update_song_metadata(file_path, metadata):
        """Update only specific metadata fields for a song."""
        # Normalize artist to remove duplicate names (e.g. "A, A, A" -> "A")
        if 'artist' in metadata and metadata['artist'] is not None:
            raw = str(metadata['artist']).strip()
            seen = set()
            deduped = []
            for part in raw.split(','):
                name = part.strip()
                if not name:
                    continue
                key = name.lower()
                if key not in seen:
                    seen.add(key)
                    deduped.append(name)
            if deduped:
                metadata = dict(metadata)
                metadata['artist'] = ', '.join(deduped)

        # Build dynamic query based on provided fields
        fields = []
        values = []
        
        field_mapping = {
            'title': 'title',
            'artist': 'artist',
            'album': 'album',
            'year': 'year',
            'genre': 'genre',
            'cover_path': 'cover_path'
        }
        
        for key, column in field_mapping.items():
            if key in metadata and metadata[key] is not None:
                fields.append(f"{column} = %s")
                values.append(metadata[key])
        
        if not fields:
            return None
        
        values.append(file_path)
        query = f"UPDATE songs SET {', '.join(fields)} WHERE file_path = %s"
        return Database.execute_query(query, tuple(values))
    
    @staticmethod
    def get_song_by_path(file_path):
        """Find a song by its file path."""
        query = "SELECT * FROM songs WHERE file_path = %s"
        return Database.execute_query(query, (file_path,), fetch_one=True)
    
    @staticmethod
    def get_song_by_id(song_id):
        """Find a song by its database ID."""
        query = "SELECT * FROM songs WHERE id = %s"
        return Database.execute_query(query, (song_id,), fetch_one=True)
    
    @staticmethod
    def delete_song_by_id(song_id):
        """Remove a song by its database ID."""
        query = "DELETE FROM songs WHERE id = %s"
        return Database.execute_query(query, (song_id,))
    
    @staticmethod
    def get_all_songs():
        """Get all songs from the database, sorted by artist/album/track."""
        query = """
            SELECT id, file_path, title, artist, album, duration, 
                   track_number, year, genre, cover_path, file_size, file_modified
            FROM songs 
            ORDER BY artist, album, track_number
        """
        results = Database.execute_query(query, fetch_all=True)
        
        # Transform to match the expected format for the API
        songs = []
        for row in results:
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
        return songs
    
    @staticmethod
    def get_recently_added(limit=20):
        """Get recently added songs, ordered by scan date (newest first)."""
        query = """
            SELECT id, file_path, title, artist, album, duration, 
                   track_number, year, genre, cover_path, scanned_at
            FROM songs 
            ORDER BY scanned_at DESC
            LIMIT %s
        """
        results = Database.execute_query(query, (limit,), fetch_all=True)
        
        songs = []
        for row in results:
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
        return songs
    
    @staticmethod
    def delete_song(file_path):
        """Remove a song from the database."""
        query = "DELETE FROM songs WHERE file_path = %s"
        return Database.execute_query(query, (file_path,))
    
    @staticmethod
    def delete_all_songs():
        """Clear all songs from the database (for full rescan)."""
        query = "DELETE FROM songs"
        return Database.execute_query(query)
    
    @staticmethod
    def get_existing_paths():
        """Get a set of all file paths currently in the database."""
        query = "SELECT file_path FROM songs"
        results = Database.execute_query(query, fetch_all=True)
        return {row['file_path'] for row in results}
    
    @staticmethod
    def get_songs_with_file_info():
        """Get songs with file modification info for incremental scan."""
        query = "SELECT file_path, file_modified, file_size FROM songs"
        results = Database.execute_query(query, fetch_all=True)
        return {row['file_path']: row for row in results}
    
    @staticmethod
    def get_song_count():
        """Get total number of songs in the library."""
        query = "SELECT COUNT(*) as count FROM songs"
        result = Database.execute_query(query, fetch_one=True)
        return result['count'] if result else 0

    @staticmethod
    def _dedupe_artist_string(raw):
        """Deduplicate a comma-separated artist string, case-insensitive."""
        if not raw or not str(raw).strip():
            return raw
        seen = set()
        out = []
        for part in str(raw).split(','):
            name = part.strip()
            if not name:
                continue
            key = name.lower()
            if key not in seen:
                seen.add(key)
                out.append(name)
        return ', '.join(out) if out else raw

    @staticmethod
    def fix_artist_duplicates():
        """Fix existing songs where artist contains duplicate comma-separated names.

        Returns number of songs fixed.
        """
        rows = Database.execute_query("SELECT id, artist FROM songs", fetch_all=True) or []
        fixed = 0
        for row in rows:
            raw = row.get('artist') or ''
            deduped = SongModel._dedupe_artist_string(raw)
            if deduped != raw:
                Database.execute_query("UPDATE songs SET artist = %s WHERE id = %s", (deduped, row['id']))
                fixed += 1
        return fixed


class ScanHistoryModel:
    @staticmethod
    def start_scan(scan_type):
        """Create a new scan history entry and return its ID."""
        query = """
            INSERT INTO scan_history (scan_type, status)
            VALUES (%s, 'running')
        """
        return Database.execute_query(query, (scan_type,))
    
    @staticmethod
    def complete_scan(scan_id, files_found, files_added, files_updated, files_removed):
        """Mark a scan as completed with statistics."""
        query = """
            UPDATE scan_history 
            SET status = 'completed', files_found = %s, files_added = %s,
                files_updated = %s, files_removed = %s, completed_at = NOW()
            WHERE id = %s
        """
        return Database.execute_query(query, (
            files_found, files_added, files_updated, files_removed, scan_id
        ))
    
    @staticmethod
    def fail_scan(scan_id, error_message):
        """Mark a scan as failed with an error message."""
        query = """
            UPDATE scan_history 
            SET status = 'failed', error_message = %s, completed_at = NOW()
            WHERE id = %s
        """
        return Database.execute_query(query, (error_message, scan_id))
    
    @staticmethod
    def get_latest_scan():
        """Get the most recent scan history entry."""
        query = """
            SELECT * FROM scan_history 
            ORDER BY started_at DESC 
            LIMIT 1
        """
        return Database.execute_query(query, fetch_one=True)
    
    @staticmethod
    def is_scan_running():
        """Check if a scan is currently in progress."""
        query = "SELECT id FROM scan_history WHERE status = 'running' LIMIT 1"
        result = Database.execute_query(query, fetch_one=True)
        return result is not None
