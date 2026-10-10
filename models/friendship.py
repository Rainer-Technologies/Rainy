"""Friendship model — the social graph between Rainy accounts.

One directed row per (user_id -> friend_id). status 'pending' is an open
friend request, 'accepted' is a mutual friendship. The reverse direction
may hold its own pending row (both users requested each other); sending a
request to someone who already requested YOU auto-accepts instead.
"""
from .database import Database


class FriendshipModel:
    @staticmethod
    def send_request(requester_id, target_id):
        """Send a friend request. Auto-accepts when the target already
        requested us. Returns (status, row) where status is one of
        'pending', 'accepted', or an error string."""
        if requester_id == target_id:
            return 'self', None

        # Target already requested us -> accepting their open request
        # makes us friends immediately (mutual connect).
        reverse = Database.execute_query(
            "SELECT id FROM friendships WHERE user_id = %s AND friend_id = %s "
            "AND status = 'pending'", (target_id, requester_id), fetch_one=True)
        if reverse:
            Database.execute_query(
                "UPDATE friendships SET status = 'accepted', responded_at = NOW() "
                "WHERE id = %s", (reverse['id'],))
            return 'accepted', reverse

        # Already friends?
        if FriendshipModel.are_friends(requester_id, target_id):
            return 'already_friends', None

        # Same-direction pending request?
        pending = Database.execute_query(
            "SELECT id FROM friendships WHERE user_id = %s AND friend_id = %s "
            "AND status = 'pending'", (requester_id, target_id), fetch_one=True)
        if pending:
            return 'pending', pending

        insert_id = Database.execute_query(
            "INSERT INTO friendships (user_id, friend_id, status) "
            "VALUES (%s, %s, 'pending')", (requester_id, target_id))
        return 'pending', {'id': insert_id}

    @staticmethod
    def are_friends(user_a, user_b):
        row = Database.execute_query(
            "SELECT 1 FROM friendships "
            "WHERE ((user_id = %s AND friend_id = %s) OR "
            "       (user_id = %s AND friend_id = %s)) AND status = 'accepted' "
            "LIMIT 1", (user_a, user_b, user_b, user_a), fetch_one=True)
        return row is not None

    @staticmethod
    def friendship_state(user_a, user_b):
        """Mutual state between two users: 'friends' | 'none' | 'outgoing'
        (a requested b) | 'incoming' (b requested a)."""
        if FriendshipModel.are_friends(user_a, user_b):
            return 'friends'
        row = Database.execute_query(
            "SELECT user_id, friend_id, status FROM friendships "
            "WHERE (user_id = %s AND friend_id = %s) OR "
            "      (user_id = %s AND friend_id = %s) LIMIT 1",
            (user_a, user_b, user_b, user_a), fetch_one=True)
        if not row:
            return 'none'
        if row['user_id'] == user_a:
            return 'outgoing'
        return 'incoming'

    @staticmethod
    def friends_list(user_id):
        """Accepted friends of user_id, with their profile info."""
        query = """
            SELECT u.id, u.username, u.email, f.created_at AS friends_since
            FROM friendships f
            JOIN users u ON u.id = f.friend_id
            WHERE f.user_id = %s AND f.status = 'accepted'
            UNION
            SELECT u.id, u.username, u.email, f.created_at AS friends_since
            FROM friendships f
            JOIN users u ON u.id = f.user_id
            WHERE f.friend_id = %s AND f.status = 'accepted'
            ORDER BY username
        """
        return Database.execute_query(query, (user_id, user_id), fetch_all=True) or []

    @staticmethod
    def incoming(user_id):
        """Pending requests directed at user_id."""
        query = """
            SELECT f.id, f.created_at, u.id AS user_id, u.username, u.email
            FROM friendships f
            JOIN users u ON u.id = f.user_id
            WHERE f.friend_id = %s AND f.status = 'pending'
            ORDER BY f.created_at DESC
        """
        return Database.execute_query(query, (user_id,), fetch_all=True) or []

    @staticmethod
    def outgoing(user_id):
        """Pending requests sent by user_id."""
        query = """
            SELECT f.id, f.created_at, u.id AS user_id, u.username, u.email
            FROM friendships f
            JOIN users u ON u.id = f.friend_id
            WHERE f.user_id = %s AND f.status = 'pending'
            ORDER BY f.created_at DESC
        """
        return Database.execute_query(query, (user_id,), fetch_all=True) or []

    @staticmethod
    def find_request(request_id, user_id):
        """A friendship row involving user_id in either direction."""
        return Database.execute_query(
            "SELECT * FROM friendships WHERE id = %s "
            "AND (user_id = %s OR friend_id = %s)",
            (request_id, user_id, user_id), fetch_one=True)

    @staticmethod
    def accept(request_id, user_id):
        """Accept a pending request. Only the recipient (friend_id) may
        accept; the sender cannot consent on the target's behalf.
        Returns True on success."""
        result = Database.execute_query(
            "UPDATE friendships SET status = 'accepted', responded_at = NOW() "
            "WHERE id = %s AND status = 'pending' AND friend_id = %s",
            (request_id, user_id))
        return bool(result)

    @staticmethod
    def decline(request_id, user_id):
        """Withdraw/decline a pending request involving user_id (either
        direction). Accepted friendships are removed via remove_friend."""
        Database.execute_query(
            "DELETE FROM friendships WHERE id = %s AND status = 'pending' "
            "AND (user_id = %s OR friend_id = %s)",
            (request_id, user_id, user_id))

    @staticmethod
    def remove_friend(user_a, user_b):
        """Remove an accepted friendship (either direction)."""
        Database.execute_query(
            "DELETE FROM friendships "
            "WHERE ((user_id = %s AND friend_id = %s) OR "
            "       (user_id = %s AND friend_id = %s)) AND status = 'accepted'",
            (user_a, user_b, user_b, user_a))

    @staticmethod
    def find_user(identifier):
        """Find a user by email (exact, lowercased) or username (exact)."""
        identifier = (identifier or '').strip()
        if not identifier:
            return None
        row = Database.execute_query(
            "SELECT id, username, email FROM users WHERE email = %s LIMIT 1",
            (identifier.lower(),), fetch_one=True)
        if row:
            return row
        return Database.execute_query(
            "SELECT id, username, email FROM users WHERE username = %s LIMIT 1",
            (identifier,), fetch_one=True)