"""Song radio endpoints (see utils/ytradio.py).

The session lives in the client: it keeps the queue and tells the server
what it already holds, so every call here is stateless.
"""
import re

from flask import Blueprint, jsonify, request

from routes.auth import get_current_user_id, require_auth, server_error

radio_bp = Blueprint('radio', __name__, url_prefix='/api/radio')

_VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
_MODES = ('mix', 'discover')
MAX_PREFETCH = 5


def _ints(values, cap=500):
    return [v for v in (values or []) if isinstance(v, int) and not isinstance(v, bool)][-cap:]


def _video_ids(values, cap=500):
    return [v for v in (values or []) if isinstance(v, str) and _VIDEO_ID.match(v)][-cap:]


def _queue(deep):
    from utils import ytradio

    data = request.get_json(silent=True) or {}
    seed_id = data.get('song_id')
    if not isinstance(seed_id, int) or isinstance(seed_id, bool):
        return jsonify({'error': 'song_id is required'}), 400
    mode = data.get('mode') if data.get('mode') in _MODES else 'mix'
    try:
        limit = max(1, min(int(data.get('limit') or 12), 30))
    except (TypeError, ValueError):
        limit = 12
    skipped = [s for s in (data.get('skipped_artists') or []) if isinstance(s, str)][-50:]
    try:
        queue = ytradio.build_queue(
            get_current_user_id(), seed_id, mode=mode,
            exclude_song_ids=_ints(data.get('exclude_song_ids')),
            exclude_video_ids=_video_ids(data.get('exclude_video_ids')),
            skipped_artists=skipped, limit=limit, deep=deep)
    except Exception:
        return server_error()
    return jsonify({'queue': queue, 'mode': mode})


@radio_bp.route('/start', methods=['POST'])
@require_auth
def start_radio():
    """First batch of a radio for a song. Uses a single fast page of the
    seed's radio so the queue fills in about a second."""
    return _queue(deep=False)


@radio_bp.route('/more', methods=['POST'])
@require_auth
def more_radio():
    """Next batch of a running radio, from the seed's deep radio."""
    return _queue(deep=True)


@radio_bp.route('/prefetch', methods=['POST'])
@require_auth
def prefetch_tracks():
    """Download the upcoming new tracks and report which are ready.

    Body: {tracks: [{videoId, title, artist, album, duration, cover_url}]}.
    The client repeats the call while tracks are pending; ready ones come
    back with the playable song to swap into the queue.
    """
    from utils import ytradio

    data = request.get_json(silent=True) or {}
    tracks = []
    for t in (data.get('tracks') or [])[:MAX_PREFETCH]:
        if not isinstance(t, dict) or not isinstance(t.get('videoId'), str) \
                or not _VIDEO_ID.match(t['videoId']):
            continue
        try:
            duration = int(t.get('duration') or 0)
        except (TypeError, ValueError):
            duration = 0
        tracks.append({
            'videoId': t['videoId'],
            'title': str(t.get('title') or ''),
            'artist': str(t.get('artist') or ''),
            'album': str(t.get('album') or ''),
            'duration': duration,
            'cover_url': str(t.get('cover_url') or ''),
        })
    try:
        return jsonify({'tracks': ytradio.prefetch(get_current_user_id(), tracks)})
    except Exception:
        return server_error()
