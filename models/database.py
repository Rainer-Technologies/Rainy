import mysql.connector
from mysql.connector import pooling
from config import Config

class Database:
    _pool = None
    
    @classmethod
    def get_pool(cls):
        if cls._pool is None:
            cls._pool = pooling.MySQLConnectionPool(
                pool_name="rainy_pool",
                pool_size=5,
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
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
                file_size BIGINT,
                file_modified DATETIME,
                scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_artist (artist),
                INDEX idx_album (album)
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
        
        conn.commit()
        cursor.close()
        conn.close()
    
    @classmethod
    def execute_query(cls, query, params=None, fetch_one=False, fetch_all=False):
        """Execute a query and return results."""
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
            conn.close()
