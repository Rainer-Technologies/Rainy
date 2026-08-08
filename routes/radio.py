"""Seed-anchored radio API — YouTube-style autoplay from a library song.

Async-friendly: `/start` returns immediately (session created, batch
generation runs in a background thread), the client polls `/status` until
'ready', then calls `/next` to collect the batch. No more 2-minute blocking
requests (the old synchronous design left mobile clients stuck on a spinner
when the LLM calls ran long).
"""
from flask import Blueprint, jsonify, request

from routes.auth import get_current_user_id, require_auth

radio_bp = Blueprint('radio', __name__, url_prefix='/api/radio')


@radio_bp.route('/start', methods=['POST'])
@require_auth
def start_radio():
    """Create a radio session. Returns immediately.

    Body: {song_id}  ->  seed-anchored radio
          {} (no song_id)  ->  TASTE radio (seed from your top-played
                                artists/genres — the DJ "for you" mode)
          {fast: true}  ->  first batch skips the LLM (heuristic queries,
                                no curation) so music starts in ~5-10s.
    Returns {session_id, seed, status}. Batch generation continues in the
    background; poll /status then /next.
    """
    from utils import radio
    user_id = get_current_user_id()
    data = request.get_json() or {}
    song_id = data.get('song_id')
    fast = bool(data.get('fast'))

    session, meta = radio.start(user_id, song_id, fast=fast)
    if not session:
        return jsonify(meta or {'error': 'Could not start radio'}), 404

    return jsonify({
        'session_id': session.session_id,
        'seed': session.seed,
        'status': session.status(),
    })


@radio_bp.route('/status', methods=['GET'])
@require_auth
def radio_status():
    """Poll a session's generation status.

    Query: {session_id}  ->  {status: 'ready'|'generating'|'error'|'idle',
                               error?: str}
    """
    from utils import radio
    session_id = request.args.get('session_id')
    session = radio.get_session(session_id) if session_id else None
    if not session:
        return jsonify({'error': 'Radio session not found or expired'}), 404
    resp = {'status': session.status()}
    if session.gen_error:
        resp['error'] = session.gen_error
    return jsonify(resp)


@radio_bp.route('/next', methods=['POST'])
@require_auth
def next_batch():
    """Collect a ready batch (or report current status).

    Body: {session_id, direction?}  ->  {songs: [...], status}
    When status is 'generating', call again in a few seconds. When 'ready',
    this returns the batch and immediately kicks off the NEXT batch's
    generation, so the queue never runs dry. `direction` is an optional
    DJ-provided style hint ("shift toward darker reggaeton") applied to the
    next batch's query generation.
    """
    from utils import radio
    data = request.get_json() or {}
    session_id = data.get('session_id')
    session = radio.get_session(session_id) if session_id else None
    if not session:
        return jsonify({'error': 'Radio session not found or expired'}), 404

    songs, status = radio.take_batch(session)
    # Keep the pipeline fed: as soon as a batch is served, generate the next.
    if status == 'ready':
        radio.generate_batch(session, direction=data.get('direction'))
    return jsonify({'session_id': session.session_id, 'songs': songs,
                    'status': status})


@radio_bp.route('/stop', methods=['POST'])
@require_auth
def stop_radio():
    """End a radio session (frees memory)."""
    from utils import radio
    data = request.get_json() or {}
    session_id = data.get('session_id')
    with radio._sessions_lock:
        radio._sessions.pop(session_id, None)
    return jsonify({'success': True})
