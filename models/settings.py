from .database import Database

class SettingsModel:
    @staticmethod
    def set_setting(key, value):
        """Set a system setting (insert or update)."""
        query = """
            INSERT INTO settings (setting_key, setting_value)
            VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE setting_value = %s
        """
        return Database.execute_query(query, (key, value, value))
    
    @staticmethod
    def get_setting(key, default=None):
        """Get a system setting by key."""
        query = "SELECT setting_value FROM settings WHERE setting_key = %s"
        result = Database.execute_query(query, (key,), fetch_one=True)
        return result['setting_value'] if result else default
    
    @staticmethod
    def get_music_path():
        """Get the configured music directory path."""
        return SettingsModel.get_setting('music_path')
    
    @staticmethod
    def set_music_path(path):
        """Set the music directory path."""
        return SettingsModel.set_setting('music_path', path)
    
    @staticmethod
    def get_all_settings():
        """Get all system settings."""
        query = "SELECT setting_key, setting_value FROM settings"
        return Database.execute_query(query, fetch_all=True)
