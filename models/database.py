import mysql.connector
from mysql.connector import errorcode, pooling
from flask import g, has_app_context
from config import Config

class Database:
    _pool = None
    
    @classmethod
    def get_pool(cls):
        if cls._pool is None:
            cls._pool = pooling.MySQLConnectionPool(
                pool_name="rainy_pool",
                pool_size=20,
                host=Config.MYSQL_HOST,
                port=Config.MYSQL_PORT,
                user=Config.MYSQL_USER,
                password=Config.MYSQL_PASSWORD,
                database=Config.MYSQL_DATABASE
            )
        return cls._pool
    
    @classmethod
    def get_connection(cls):
        return cls.get_pool().get_connection()
    
    @classmethod
    def init_db(cls):
        """Initialize the database and create tables if they don't exist."""
        # First connect without database to create it if needed
        try:
            conn = mysql.connector.connect(
                host=Config.MYSQL_HOST,
                port=Config.MYSQL_PORT,
                user=Config.MYSQL_USER,
                password=Config.MYSQL_PASSWORD
            )
            cursor = conn.cursor()
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS {Config.MYSQL_DATABASE}")
            cursor.close()
            conn.close()
        except mysql.connector.Error as err:
            # Docker Compose creates the application database before this
            # service starts, but its non-root application user cannot create
            # databases. It can still create and migrate tables within the
            # pre-created database, so continue in that case.
            if err.errno == errorcode.ER_DBACCESS_DENIED_ERROR:
                print(f"Database already provisioned; skipping creation: {err}")
            else:
                print(f"Error creating database: {err}")
                raise
        
        # Now connect to the database and create tables
        conn = cls.get_connection()
        cursor = conn.cursor()
        
        # Users table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) NOT NULL UNIQUE,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL DEFAULT 'user',
                preferences TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Migration: Add preferences column if it doesn't exist
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns 
            WHERE table_schema = %s AND table_name = 'users' AND column_name = 'preferences'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE users ADD COLUMN preferences TEXT")

        # Migration: full_library permission — grants the user visibility of
        # EVERY song on the system (incl. other accounts' personal imports).
        # Deliberately NOT defaulted for anyone, admins included: the admin
        # must flip it on at account creation (or later via the users panel).
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns 
            WHERE table_schema = %s AND table_name = 'users' AND column_name = 'full_library'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE users ADD COLUMN full_library TINYINT(1) NOT NULL DEFAULT 0")
        
        # Settings table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                setting_key VARCHAR(100) PRIMARY KEY,
                setting_value TEXT NOT NULL
            )
        """)
        
        # Songs table - stores scanned music files
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS songs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                file_path VARCHAR(768) NOT NULL UNIQUE,
                title VARCHAR(255) NOT NULL,
                artist VARCHAR(255) DEFAULT 'Unknown Artist',
                album VARCHAR(255) DEFAULT 'Unknown Album',
                duration INT DEFAULT 0,
                track_number INT DEFAULT 0,
                year VARCHAR(20),
                genre VARCHAR(100),
                cover_path VARCHAR(768),
                file_size BIGINT,
                file_modified DATETIME,
                scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_artist (artist),
                INDEX idx_album (album)
            )
        """)
        
        # Migration: Add cover_path column if it doesn't exist
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns 
            WHERE table_schema = %s AND table_name = 'songs' AND column_name = 'cover_path'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE songs ADD COLUMN cover_path VARCHAR(768)")
            
        # Playlists table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS playlists (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                icon VARCHAR(50) DEFAULT 'music-note',
                icon_color VARCHAR(7) DEFAULT '#888888',
                owner_user_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # Migration: Add icon column if it doesn't exist
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns 
            WHERE table_schema = %s AND table_name = 'playlists' AND column_name = 'icon'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE playlists ADD COLUMN icon VARCHAR(50) DEFAULT 'music-note'")
        
        # Migration: Add icon_color column if it doesn't exist
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns 
            WHERE table_schema = %s AND table_name = 'playlists' AND column_name = 'icon_color'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE playlists ADD COLUMN icon_color VARCHAR(7) DEFAULT '#888888'")
        
        # Migration: Add owner_user_id column if it doesn't exist
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns 
            WHERE table_schema = %s AND table_name = 'playlists' AND column_name = 'owner_user_id'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE playlists ADD COLUMN owner_user_id INT NULL")
            # Optional: add foreign key constraint if users table exists
            try:
                cursor.execute("""
                    ALTER TABLE playlists 
                    ADD CONSTRAINT fk_playlists_owner 
                    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
                """)
            except mysql.connector.Error:
                pass

        # Migration: Add cover_path column (auto-generated playlist cover) if missing
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns
            WHERE table_schema = %s AND table_name = 'playlists' AND column_name = 'cover_path'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE playlists ADD COLUMN cover_path VARCHAR(768) NULL")

        # ── Per-account library isolation ─────────────────────────────
        # A song row stays global (one file on disk = one row). Visibility
        # is granted per user via library_access:
        #   - No row for (user_id, song_id) → the song is NOT in that
        #     user's library.
        #   - Row present → visible. origin 'scan' rows are "public":
        #     every NEW user automatically gets a copy at first login
        #     (backfill), while origin 'import' rows stay personal until
        #     a sysadmin publishes them.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS library_access (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                song_id INT NOT NULL,
                origin ENUM('scan', 'import') NOT NULL DEFAULT 'import',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_user_song (user_id, song_id),
                INDEX idx_user_origin (user_id, origin),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        """)

        # Migration: grant existing users access to the whole current
        # library (pre-isolation songs were shared by definition). Admin-only
        # by policy since Aug 2026 — scans of the shared folder are visible
        # to administrators; regular accounts only get published songs.
        cursor.execute("""
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT u.id, s.id, 'scan'
            FROM users u
            CROSS JOIN songs s
            WHERE u.role = 'sysadmin'
            AND NOT EXISTS (
                SELECT 1 FROM library_access la
                WHERE la.user_id = u.id AND la.song_id = s.id
            )
        """)

        
        # Playlist Songs table (linking table)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS playlist_entries (
                id INT AUTO_INCREMENT PRIMARY KEY,
                playlist_id INT NOT NULL,
                track_id INT NOT NULL,
                order_num INT NOT NULL DEFAULT 0,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                FOREIGN KEY (track_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        """)
        
        # Scan history table - tracks scan operations
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS scan_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                scan_type ENUM('quick', 'full') NOT NULL,
                status ENUM('running', 'completed', 'failed') DEFAULT 'running',
                files_found INT DEFAULT 0,
                files_added INT DEFAULT 0,
                files_updated INT DEFAULT 0,
                files_removed INT DEFAULT 0,
                error_message TEXT,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP NULL
            )
        """)
        
        # Song ratings table - stores user likes/dislikes with timestamps
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS song_ratings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                song_id INT NOT NULL,
                rating ENUM('like', 'dislike') NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_user_song (user_id, song_id),
                INDEX idx_user_rating (user_id, rating),
                INDEX idx_created_at (created_at)
            )
        """)
        
        # Artist metadata table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS artists_metadata (
                id INT AUTO_INCREMENT PRIMARY KEY,
                artist_name VARCHAR(255) NOT NULL UNIQUE,
                description TEXT NULL,
                image_url TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        """)

        # Pregenerated light show data (one JSON blob per song)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS song_lightshows (
                song_id INT PRIMARY KEY,
                data MEDIUMTEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        """)

        # Cached lyrics per song (synced LRC parsed to JSON + plain fallback)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS song_lyrics (
                song_id INT PRIMARY KEY,
                found TINYINT(1) NOT NULL DEFAULT 0,
                synced MEDIUMTEXT NULL,
                plain MEDIUMTEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        """)

        # Forced-alignment word timestamps per song (JSON: per-line word start times)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS song_lyrics_words (
                song_id INT PRIMARY KEY,
                data MEDIUMTEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        """)

        # Playback history — records every play event per user
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS play_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                song_id INT NOT NULL,
                position INT DEFAULT 0,
                duration INT DEFAULT 0,
                played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
                INDEX idx_user_played (user_id, played_at),
                INDEX idx_user_song (user_id, song_id)
            )
        """)

        # Playback state — cross-device sync (one row per user)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS playback_state (
                user_id INT PRIMARY KEY,
                song_id INT NULL,
                position DOUBLE DEFAULT 0,
                queue MEDIUMTEXT NULL,
                queue_index INT DEFAULT 0,
                is_playing TINYINT(1) DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE SET NULL
            )
        """)

        # Import jobs — background queue for YouTube/Spotify imports.
        # Each row is one import request; a single background worker drains
        # the queue one job at a time, streaming progress into `progress`/
        # `message` and the final outcome into `result`/`error_message`.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS import_jobs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                source ENUM('youtube', 'spotify') NOT NULL,
                kind ENUM('song', 'playlist') NOT NULL,
                url TEXT NOT NULL,
                conflict_mode VARCHAR(16) NULL,
                status ENUM('queued', 'running', 'completed', 'failed', 'cancelled') DEFAULT 'queued',
                progress INT DEFAULT 0,
                message VARCHAR(500) NULL,
                result MEDIUMTEXT NULL,
                error_message TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP NULL,
                completed_at TIMESTAMP NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_status (status),
                INDEX idx_created (created_at)
            )
        """)

        # Migration: how a playlist import resolves a name collision
        # ('add' | 'override' | 'new'). NULL lets the handler use its default.
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns
            WHERE table_schema = %s AND table_name = 'import_jobs' AND column_name = 'conflict_mode'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE import_jobs ADD COLUMN conflict_mode VARCHAR(16) NULL")

        # Song audio features — objective signal analysis from librosa.
        # One row per song, computed locally from the audio file itself so it
        # works for any file regardless of where it came from. These numeric
        # descriptors power content-based similarity and the future AI DJ.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS song_features (
                song_id INT PRIMARY KEY,
                tempo_bpm FLOAT NULL,
                tempo_confidence FLOAT NULL,
                key_name VARCHAR(20) NULL,
                scale_type VARCHAR(20) NULL,
                key_strength FLOAT NULL,
                danceability FLOAT NULL,
                loudness_db FLOAT NULL,
                energy FLOAT NULL,
                spectral_centroid FLOAT NULL,
                spectral_rolloff FLOAT NULL,
                spectral_complexity FLOAT NULL,
                zero_crossing_rate FLOAT NULL,
                mfccs JSON NULL,
                analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        """)

        # Song audio fingerprinting — dupe detection across sources.
        # sha256 catches byte-identical copies; fingerprint is a chromaprint
        # (fpcalc) raw uint32 stream for matching the same song re-encoded /
        # re-sourced (lyric video vs official, bitrate changes). Computed by
        # utils/dedupe.py on import/upload and by scripts/backfill_fingerprints.py.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS song_fingerprints (
                song_id INT PRIMARY KEY,
                sha256 CHAR(64) NULL,
                fingerprint TEXT NULL,
                fp_duration DOUBLE NULL,
                computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        """)

        # Song tags — crowd-sourced genre/mood/style labels from Last.fm and
        # MusicBrainz, keyed on artist + title so they work for any source.
        # weight is 0-100 (Last.fm normalises its own top tag to 100).
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS song_tags (
                id INT AUTO_INCREMENT PRIMARY KEY,
                song_id INT NOT NULL,
                tag_name VARCHAR(100) NOT NULL,
                weight INT DEFAULT 0,
                source ENUM('lastfm', 'musicbrainz') NOT NULL DEFAULT 'lastfm',
                UNIQUE KEY uniq_song_tag_source (song_id, tag_name, source),
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
                INDEX idx_tag_name (tag_name)
            )
        """)

        # Artist relations — similarity graph from Last.fm's collaborative
        # data. Cached per artist so we only fetch once per unique artist.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS artist_relations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                artist_name VARCHAR(255) NOT NULL,
                related_artist VARCHAR(255) NOT NULL,
                similarity FLOAT DEFAULT 0,
                source ENUM('lastfm') NOT NULL DEFAULT 'lastfm',
                UNIQUE KEY uniq_artist_pair (artist_name, related_artist),
                INDEX idx_artist_name (artist_name)
            )
        """)

        # Migration: add musicbrainz_id to songs (universal recording ID,
        # the open-standard key that links a track across free databases).
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns
            WHERE table_schema = %s AND table_name = 'songs' AND column_name = 'musicbrainz_id'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE songs ADD COLUMN musicbrainz_id VARCHAR(36) NULL")

        # Migration: track when a song last went through metadata enrichment so
        # the "analyse unanalysed songs" job can skip already-processed tracks.
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns
            WHERE table_schema = %s AND table_name = 'songs' AND column_name = 'enriched_at'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE songs ADD COLUMN enriched_at TIMESTAMP NULL")

        # Enrichment jobs — background queue for metadata enrichment
        # (librosa audio analysis + Last.fm tags + MusicBrainz IDs).
        # Mirrors the import_jobs pattern but is kept separate so enrichment
        # progress never clutters the import queue UI.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS enrichment_jobs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                song_id INT NULL,
                scope ENUM('song', 'backfill') NOT NULL DEFAULT 'song',
                status ENUM('queued', 'running', 'completed', 'failed') DEFAULT 'queued',
                progress INT DEFAULT 0,
                message VARCHAR(500) NULL,
                result MEDIUMTEXT NULL,
                error_message TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP NULL,
                completed_at TIMESTAMP NULL,
                INDEX idx_status (status)
            )
        """)

        # Migration: flag a job as a forced full re-analysis (redo audio
        # analysis + external metadata even for already-enriched songs).
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.columns
            WHERE table_schema = %s AND table_name = 'enrichment_jobs' AND column_name = 'force_full'
        """, (Config.MYSQL_DATABASE,))
        result = cursor.fetchone()
        if result and result[0] == 0:
            cursor.execute("ALTER TABLE enrichment_jobs ADD COLUMN force_full TINYINT(1) NOT NULL DEFAULT 0")

        # Rainy Connect — active player device sessions (Spotify-Connect-style).
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS connect_sessions (
                device_id VARCHAR(64) PRIMARY KEY,
                user_id INT NOT NULL,
                device_name VARCHAR(128) NOT NULL,
                device_type VARCHAR(32) NOT NULL DEFAULT 'web',
                song_id INT NULL,
                song_title VARCHAR(255) NULL,
                song_artist VARCHAR(255) NULL,
                song_album VARCHAR(255) NULL,
                cover_path VARCHAR(500) NULL,
                position DOUBLE DEFAULT 0,
                duration DOUBLE DEFAULT 0,
                is_playing TINYINT DEFAULT 0,
                volume INT DEFAULT 100,
                is_shuffled TINYINT DEFAULT 0,
                repeat_mode VARCHAR(16) DEFAULT 'off',
                queue MEDIUMTEXT NULL,
                queue_index INT DEFAULT 0,
                last_seen DOUBLE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_last_seen (last_seen)
            )
        """)

        # Migrate: add queue columns to existing connect_sessions tables.
        cursor.execute("""
            SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = %s AND table_name = 'connect_sessions' AND column_name = 'queue'
        """, (Config.MYSQL_DATABASE,))
        if cursor.fetchone()[0] == 0:
            cursor.execute("ALTER TABLE connect_sessions ADD COLUMN queue MEDIUMTEXT NULL")
            cursor.execute("ALTER TABLE connect_sessions ADD COLUMN queue_index INT DEFAULT 0")

        # Rainy Connect — remote-control command queue (polled by target device).
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS connect_commands (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                device_id VARCHAR(64) NOT NULL,
                command VARCHAR(32) NOT NULL,
                args TEXT NULL,
                created_at DOUBLE NOT NULL,
                INDEX idx_device (user_id, device_id)
            )
        """)

        # Migration: extend song_tags.source with the local genre classifier.
        # The source enum started as ('lastfm','musicbrainz'); Discogs-EffNet
        # (local, no API key) adds a third origin for genre/style labels.
        cursor.execute("""
            SELECT column_type FROM information_schema.columns
            WHERE table_schema = %s AND table_name = 'song_tags'
              AND column_name = 'source'
        """, (Config.MYSQL_DATABASE,))
        row = cursor.fetchone()
        if row and 'discogs-effnet' not in (row[0] or ''):
            cursor.execute(
                "ALTER TABLE song_tags MODIFY COLUMN source "
                "ENUM('lastfm', 'musicbrainz', 'discogs-effnet') "
                "NOT NULL DEFAULT 'lastfm'"
            )

        # Playlist sync — periodic mirroring of remote Spotify / YouTube playlists.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS playlist_syncs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                playlist_id INT NOT NULL,
                source ENUM('youtube', 'spotify') NOT NULL,
                url TEXT NOT NULL,
                interval_hours INT NOT NULL DEFAULT 24,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                sync_mode ENUM('add_only', 'mirror') NOT NULL DEFAULT 'mirror',
                last_synced_at DATETIME NULL,
                next_sync_at DATETIME NULL,
                last_status VARCHAR(20) NULL,
                last_message TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                UNIQUE KEY uniq_playlist (playlist_id),
                INDEX idx_next_sync (enabled, next_sync_at)
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS playlist_sync_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sync_id INT NOT NULL,
                playlist_id INT NOT NULL,
                ran_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                added_count INT DEFAULT 0,
                removed_count INT DEFAULT 0,
                kept_count INT DEFAULT 0,
                failed_count INT DEFAULT 0,
                total_remote INT DEFAULT 0,
                status VARCHAR(20) NOT NULL DEFAULT 'success',
                message TEXT NULL,
                details_json MEDIUMTEXT NULL,
                FOREIGN KEY (sync_id) REFERENCES playlist_syncs(id) ON DELETE CASCADE,
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                INDEX idx_sync_ran (sync_id, ran_at),
                INDEX idx_playlist_ran (playlist_id, ran_at)
            )
        """)

        conn.commit()
        cursor.close()
        conn.close()
    
    @classmethod
    def execute_query(cls, query, params=None, fetch_one=False, fetch_all=False):
        """Execute a query and return results."""
        conn = None
        should_close = True

        if has_app_context():
            if 'db_conn' not in g:
                g.db_conn = cls.get_connection()
            conn = g.db_conn
            should_close = False
        else:
            conn = cls.get_connection()

        cursor = conn.cursor(dictionary=True)
        
        try:
            cursor.execute(query, params or ())

            if fetch_one:
                result = cursor.fetchone()
            elif fetch_all:
                result = cursor.fetchall()
            else:
                conn.commit()
                result = cursor.lastrowid

            return result
        except Exception:
            # A failed write must not leave the connection's transaction
            # half-open — subsequent statements on it would silently no-op.
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            cursor.close()
            if should_close:
                conn.close()

    @classmethod
    def close_db(cls, e=None):
        conn = g.pop('db_conn', None)
        if conn is not None:
            conn.close()
