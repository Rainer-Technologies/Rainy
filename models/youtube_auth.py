"""YouTube OAuth token storage model.

Stores per-user YouTube Music OAuth tokens (device flow) so authenticated
features like private playlists and library tracks become available.

Token blobs are obfuscated (base64 + HMAC) at rest. For production, replace
with Fernet (cryptography library) encryption.
"""

import base64
import hashlib
import hmac
import json

from config import Config
from .database import Database


def _obfuscate(data: str) -> str:
    """Base64-encode with an HMAC integrity tag derived from the secret key."""
    key = Config.FLASK_SECRET_KEY.encode()
    tag = hmac.new(key, data.encode(), hashlib.sha256).hexdigest()[:16]
    payload = json.dumps({"t": tag, "d": data})
    return base64.urlsafe_b64encode(payload.encode()).decode()


def _deobfuscate(blob: str) -> str:
    """Reverse _obfuscate. Returns the original string or raises ValueError."""
    key = Config.FLASK_SECRET_KEY.encode()
    payload = json.loads(base64.urlsafe_b64decode(blob.encode()))
    data = payload["d"]
    expected = hmac.new(key, data.encode(), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(payload["t"], expected):
        raise ValueError("Token integrity check failed")
    return data


class YouTubeAuthModel:
    @staticmethod
    def save_pending(user_id: int, device_code: str):
        """Store an in-progress device code (token_blob stays NULL)."""
        Database.execute_query(
            """INSERT INTO youtube_auth (user_id, pending_device_code)
               VALUES (%s, %s)
               ON DUPLICATE KEY UPDATE pending_device_code = VALUES(pending_device_code),
                                       updated_at = CURRENT_TIMESTAMP""",
            (user_id, device_code),
        )

    @staticmethod
    def get_pending(user_id: int):
        """Return the pending device code, or None."""
        row = Database.execute_query(
            "SELECT pending_device_code FROM youtube_auth WHERE user_id = %s",
            (user_id,),
            fetch_one=True,
        )
        return row["pending_device_code"] if row else None

    @staticmethod
    def save_token(user_id: int, token_json: str, account_name: str = ""):
        """Store the completed OAuth token and clear any pending code."""
        blob = _obfuscate(token_json)
        Database.execute_query(
            """INSERT INTO youtube_auth (user_id, token_blob, account_name)
               VALUES (%s, %s, %s)
               ON DUPLICATE KEY UPDATE token_blob = VALUES(token_blob),
                                       account_name = VALUES(account_name),
                                       pending_device_code = NULL,
                                       updated_at = CURRENT_TIMESTAMP""",
            (user_id, blob, account_name),
        )

    @staticmethod
    def get_token(user_id: int):
        """Return the deobfuscated token JSON string, or None."""
        row = Database.execute_query(
            "SELECT token_blob FROM youtube_auth WHERE user_id = %s",
            (user_id,),
            fetch_one=True,
        )
        if not row or not row["token_blob"]:
            return None
        try:
            return _deobfuscate(row["token_blob"])
        except Exception:
            return None

    @staticmethod
    def get_status(user_id: int):
        """Return connection status dict for the frontend."""
        row = Database.execute_query(
            "SELECT account_name, token_blob, updated_at FROM youtube_auth WHERE user_id = %s",
            (user_id,),
            fetch_one=True,
        )
        if not row or not row["token_blob"]:
            return {"connected": False}
        return {
            "connected": True,
            "account_name": row["account_name"] or "YouTube Account",
            "connected_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        }

    @staticmethod
    def delete_token(user_id: int):
        """Remove the stored token and any pending code (disconnect)."""
        Database.execute_query(
            "DELETE FROM youtube_auth WHERE user_id = %s", (user_id,)
        )
