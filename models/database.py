import mysql.connector
from mysql.connector import pooling
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
        finally:
            cursor.close()
            if should_close:
                conn.close()

    @classmethod
    def close_db(cls, e=None):
        conn = g.pop('db_conn', None)
        if conn is not None:
            conn.close()
