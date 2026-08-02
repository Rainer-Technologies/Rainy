"""YouTube Music OAuth (device flow) + authenticated library endpoints.

Uses ytmusicapi's OAuthCredentials for the RFC 8628 device authorization
grant. Requires a Google OAuth client (client_id + client_secret) configured
via environment variables — ytmusicapi 1.12+ no longer ships a default.

    YT_OAUTH_CLIENT_ID=...
    YT_OAUTH_CLIENT_SECRET=...
"""

import json
import os

from flask import Blueprint, jsonify, request
from functools import wraps

from models.youtube_auth import YouTubeAuthModel
from routes.auth import get_current_user_id

youtube_bp = Blueprint("youtube", __name__, url_prefix="/api/youtube")

CLIENT_ID = os.getenv("YT_OAUTH_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("YT_OAUTH_CLIENT_SECRET", "")


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({"error": "Authentication required"}), 401
        return f(user_id, *args, **kwargs)
    return decorated


def _credentials():
    """Build OAuthCredentials, or raise if client creds are not configured."""
    if not CLIENT_ID or not CLIENT_SECRET:
        raise RuntimeError(
            "YouTube OAuth client not configured. Set YT_OAUTH_CLIENT_ID and "
            "YT_OAUTH_CLIENT_SECRET in your environment."
        )
    from ytmusicapi import OAuthCredentials
    return OAuthCredentials(CLIENT_ID, CLIENT_SECRET)


def _authed_client(user_id):
    """Return an authenticated YTMusic instance for the user, or None."""
    token_json = YouTubeAuthModel.get_token(user_id)
    if not token_json:
        return None
    from ytmusicapi import YTMusic
    token = json.loads(token_json)
    return YTMusic(auth=token, oauth_credentials=_credentials())


@youtube_bp.route("/status", methods=["GET"])
@login_required
def status(user_id):
    """Return whether the user has a connected YouTube account."""
    configured = bool(CLIENT_ID and CLIENT_SECRET)
    result = YouTubeAuthModel.get_status(user_id)
    result["configured"] = configured
    return jsonify(result)


@youtube_bp.route("/start", methods=["POST"])
@login_required
def start(user_id):
    """Begin the device authorization flow. Returns the URL + user code."""
    try:
        creds = _credentials()
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503

    try:
        code = creds.get_code()
        YouTubeAuthModel.save_pending(user_id, code["device_code"])
        return jsonify({
            "verification_url": code["verification_url"],
            "user_code": code["user_code"],
            "expires_in": code.get("expires_in", 1800),
            "interval": code.get("interval", 5),
        })
    except Exception as e:
        return jsonify({"error": f"Failed to start OAuth flow: {e}"}), 502


@youtube_bp.route("/poll", methods=["POST"])
@login_required
def poll(user_id):
    """Exchange the pending device code for a token once the user approves."""
    device_code = YouTubeAuthModel.get_pending(user_id)
    if not device_code:
        return jsonify({"error": "No pending authorization. Call /start first."}), 400

    try:
        creds = _credentials()
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503

    from ytmusicapi.auth.oauth.exceptions import BadOAuthClient

    try:
        raw = creds.token_from_code(device_code)
    except BadOAuthClient:
        # User hasn't approved yet, or code expired.
        return jsonify({"status": "pending"}), 200
    except Exception as e:
        return jsonify({"error": f"Token exchange failed: {e}"}), 502

    # Build the token dict ytmusicapi expects for persistence.
    token = {
        "access_token": raw["access_token"],
        "refresh_token": raw["refresh_token"],
        "scope": raw.get("scope", "https://www.googleapis.com/auth/youtube"),
        "token_type": raw.get("token_type", "Bearer"),
        "expires_at": 0,
        "expires_in": raw.get("expires_in", 0),
    }

    # Resolve the account name for display.
    account_name = "YouTube Account"
    try:
        from ytmusicapi import YTMusic
        client = YTMusic(auth=token, oauth_credentials=creds)
        info = client.get_account_info()
        account_name = info.get("accountName") or account_name
    except Exception:
        pass

    YouTubeAuthModel.save_token(user_id, json.dumps(token), account_name)
    return jsonify({"status": "connected", "account_name": account_name})


@youtube_bp.route("/disconnect", methods=["POST"])
@login_required
def disconnect(user_id):
    """Remove the stored token."""
    YouTubeAuthModel.delete_token(user_id)
    return jsonify({"success": True})


@youtube_bp.route("/playlists", methods=["GET"])
@login_required
def playlists(user_id):
    """List the user's YouTube Music library playlists (incl. private)."""
    client = _authed_client(user_id)
    if not client:
        return jsonify({"error": "YouTube account not connected"}), 401
    try:
        limit = request.args.get("limit", type=int, default=50)
        result = client.get_library_playlists(limit=limit)
        return jsonify({"playlists": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@youtube_bp.route("/playlist/<playlist_id>", methods=["GET"])
@login_required
def playlist(user_id, playlist_id):
    """Get tracks from a specific YouTube Music playlist."""
    client = _authed_client(user_id)
    if not client:
        return jsonify({"error": "YouTube account not connected"}), 401
    try:
        limit = request.args.get("limit", type=int, default=100)
        result = client.get_playlist(playlist_id, limit=limit)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 502
