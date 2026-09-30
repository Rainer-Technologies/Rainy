"""Short-lived, media-only tokens for devices that can't send our cookie
(Chromecast fetching stream/cover URLs itself).

Replaces embedding the raw session cookie in ``?session=`` URLs: a leaked media
token only opens audio/cover endpoints and expires on its own.
"""
from flask import current_app
from itsdangerous import BadSignature, URLSafeTimedSerializer

MEDIA_TOKEN_TTL = 6 * 3600
# Endpoints a media token may authenticate (Flask endpoint names).
MEDIA_ENDPOINTS = {'music.stream_song', 'music.serve_cover'}


def _serializer():
    return URLSafeTimedSerializer(current_app.secret_key, salt='rainy-media-v1')


def issue(user_id):
    return _serializer().dumps({'u': int(user_id)})


def verify(token):
    """Return the user_id inside a valid, unexpired token, else None."""
    if not token or not isinstance(token, str):
        return None
    try:
        data = _serializer().loads(token, max_age=MEDIA_TOKEN_TTL)
        return int(data['u'])
    except (BadSignature, KeyError, TypeError, ValueError):
        return None
