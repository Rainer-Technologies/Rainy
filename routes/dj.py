"""AI DJ API — spoken lines between songs (Spotify-DJ style)."""
import os

from flask import Blueprint, jsonify, request, send_file

from routes.auth import require_auth

dj_bp = Blueprint('dj', __name__, url_prefix='/api/dj')

AUDIO_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dj_audio')


@dj_bp.route('/line', methods=['POST'])
@require_auth
def dj_line():
    """Generate + synthesize a DJ line.

    Body: {line_type: 'intro'|'transition'|'stop'|'chat',
           song: {title, artist, genre}?,   // next/current song
           played: [titles]?,               // recent radio history
           seed: {title, artist}?,          // radio seed
           question: str?}                  // for chat
    Returns: {text, audio_url, line_type} (audio_url may be null).
    """
    from utils import dj
    data = request.get_json() or {}
    line_type = data.get('line_type', 'transition')
    if line_type not in ('intro', 'transition', 'stop', 'chat'):
        line_type = 'transition'
    result = dj.get_dj_line(
        line_type=line_type,
        song=data.get('song'),
        played=data.get('played'),
        seed=data.get('seed'),
        question=data.get('question'),
    )
    if not result:
        return jsonify({'error': 'DJ unavailable (AI key or TTS not configured)'}), 503
    return jsonify(result)


@dj_bp.route('/prefetch', methods=['POST'])
@require_auth
def dj_prefetch():
    """Pre-generate DJ lines for upcoming songs (background).

    Body: {seed: {title, artist}?, songs: [{title, artist, genre}, ...],
           include_intro: bool, line_type?: 'transition'|'stop'}
    Returns: {queued: N}
    """
    from utils import dj
    data = request.get_json() or {}
    queued = dj.prefetch_lines(
        seed=data.get('seed'),
        songs=data.get('songs') or [],
        include_intro=bool(data.get('include_intro', True)),
        line_type=data.get('line_type', 'transition'),
    )
    return jsonify({'queued': queued})


@dj_bp.route('/cached', methods=['POST'])
@require_auth
def dj_cached():
    """Return a pre-generated line for a song (instant), or null.

    Body: {song: {title, artist}}
    """
    from utils import dj
    data = request.get_json() or {}
    line = dj.cached_line(data.get('song') or {})
    return jsonify({'line': line})


@dj_bp.route('/audio/<filename>', methods=['GET'])
@require_auth
def dj_audio(filename):
    """Serve a synthesized DJ clip."""
    safe = os.path.basename(filename)
    path = os.path.join(AUDIO_DIR, safe)
    if not safe.startswith('dj_') or not safe.endswith('.wav') or not os.path.isfile(path):
        return jsonify({'error': 'Not found'}), 404
    return send_file(path, mimetype='audio/wav')
