import bcrypt
from .database import Database

class UserModel:
    @staticmethod
    def create_user(username, email, password, role='user'):
        """Create a new user with hashed password."""
        password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        query = """
            INSERT INTO users (username, email, password_hash, role)
            VALUES (%s, %s, %s, %s)
        """
        return Database.execute_query(query, (username, email, password_hash, role))
    
    @staticmethod
    def get_user_by_email(email):
        """Get user by email address."""
        query = "SELECT * FROM users WHERE email = %s"
        return Database.execute_query(query, (email,), fetch_one=True)
    
    @staticmethod
    def get_user_by_id(user_id):
        """Get user by ID."""
        query = "SELECT id, username, email, role, created_at FROM users WHERE id = %s"
        return Database.execute_query(query, (user_id,), fetch_one=True)
    
    @staticmethod
    def verify_password(email, password):
        """Verify user password."""
        user = UserModel.get_user_by_email(email)
        if not user:
            return None
        
        if bcrypt.checkpw(password.encode('utf-8'), user['password_hash'].encode('utf-8')):
            return user
        return None
    
    @staticmethod
    def is_first_run():
        """Check if this is the first run (no users exist)."""
        query = "SELECT COUNT(*) as count FROM users"
        result = Database.execute_query(query, fetch_one=True)
        return result['count'] == 0
    
    @staticmethod
    def get_user_count():
        """Get total number of users."""
        query = "SELECT COUNT(*) as count FROM users"
        result = Database.execute_query(query, fetch_one=True)
        return result['count']
