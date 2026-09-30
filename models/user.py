import bcrypt
from .database import Database

# bcrypt only uses the first 72 bytes (and bcrypt>=5 raises beyond that).
MAX_PASSWORD_BYTES = 72
# Applies to new/changed passwords only; existing accounts keep logging in.
MIN_PASSWORD_LENGTH = 8
_DUMMY_HASH = bcrypt.hashpw(b'rainy-dummy', bcrypt.gensalt())

class UserModel:
    @staticmethod
    def create_user(username, email, password, role='user', full_library=0):
        """Create a new user with hashed password."""
        password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        query = """
            INSERT INTO users (username, email, password_hash, role, full_library)
            VALUES (%s, %s, %s, %s, %s)
        """
        return Database.execute_query(
            query, (username, email, password_hash, role, 1 if full_library else 0))
    
    @staticmethod
    def get_user_by_email(email):
        """Get user by email address."""
        query = "SELECT * FROM users WHERE email = %s"
        return Database.execute_query(query, (email,), fetch_one=True)
    
    @staticmethod
    def get_user_by_id(user_id):
        """Get user by ID."""
        query = "SELECT id, username, email, role, preferences, full_library, created_at FROM users WHERE id = %s"
        return Database.execute_query(query, (user_id,), fetch_one=True)
    
    @staticmethod
    def update_password(user_id, password):
        """Update user password."""
        password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        query = "UPDATE users SET password_hash = %s WHERE id = %s"
        return Database.execute_query(query, (password_hash, user_id))

    @staticmethod
    def update_preferences(user_id, preferences):
        """Update user preferences."""
        query = "UPDATE users SET preferences = %s WHERE id = %s"
        return Database.execute_query(query, (preferences, user_id))
    
    @staticmethod
    def verify_password(email, password):
        """Verify user password."""
        user = UserModel.get_user_by_email(email)
        if not user:
            # Burn the same bcrypt time so unknown emails aren't distinguishable
            # from wrong passwords by response time.
            bcrypt.checkpw(b'x', _DUMMY_HASH)
            return None

        try:
            ok = bcrypt.checkpw(password.encode('utf-8')[:72], user['password_hash'].encode('utf-8'))
        except ValueError:
            ok = False
        if ok:
            return user
        return None

    @staticmethod
    def validate_password(password):
        """Return an error message if the password is unacceptable, else None."""
        if not isinstance(password, str):
            return 'Password must be a string'
        if len(password) < MIN_PASSWORD_LENGTH:
            return f'Password must be at least {MIN_PASSWORD_LENGTH} characters'
        if len(password.encode('utf-8')) > MAX_PASSWORD_BYTES:
            return f'Password must be at most {MAX_PASSWORD_BYTES} bytes'
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

    @staticmethod
    def get_all_users():
        """Get all users (without password hashes)."""
        query = "SELECT id, username, email, role, full_library, created_at FROM users ORDER BY created_at ASC"
        return Database.execute_query(query, fetch_all=True)

    @staticmethod
    def update_role(user_id, role):
        """Update a user's role."""
        query = "UPDATE users SET role = %s WHERE id = %s"
        return Database.execute_query(query, (role, user_id))

    @staticmethod
    def update_full_library(user_id, flag):
        """Grant/revoke full-system-library visibility for a user."""
        query = "UPDATE users SET full_library = %s WHERE id = %s"
        return Database.execute_query(query, (1 if flag else 0, user_id))

    @staticmethod
    def delete_user(user_id):
        """Delete a user by ID."""
        query = "DELETE FROM users WHERE id = %s"
        return Database.execute_query(query, (user_id,))

    @staticmethod
    def get_sysadmin_count():
        """Get the number of sysadmin users."""
        query = "SELECT COUNT(*) as count FROM users WHERE role = 'sysadmin'"
        result = Database.execute_query(query, fetch_one=True)
        return result['count']
