"""AI DJ mode — spoken interjections between radio/library songs.

Spotify-DJ-style: an LLM writes short, personality-driven lines (intro,
song transitions, every-N-songs "stops", on-demand chat), and a persistent
local Kokoro TTS daemon turns them into WAV audio (~2s latency after warmup).
The daemon is spawned on first use and kept alive; audio files are cached on
disk so a repeated line never re-synthesizes.

Line types:
  - 'intro'    : when radio/DJ mode starts
  - 'transition': short line before/at the next song ("Next up...")
  - 'stop'     : every N songs — a longer chatty segment (like Spotify DJ)
  - 'chat'     : on-demand, e.g. "why this song?"
"""
import json
import os
import subprocess
import threading
import time
import uuid

from models.database import Database

TTS_DAEMON = '/opt/data/.tts/kokoro_daemon.py'
TTS_PYTHON = '/opt/data/whisper-env/bin/python'
DJ_VOICE = os.environ.get('DJ_VOICE', 'am_fenrir')
AUDIO_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dj_audio')

_daemon = None
_daemon_lock = threading.Lock()
_daemon_ready = False

STOP_EVERY = 4          # a "stop" (longer talk) every N songs

# Pre-generated line cache: key = normalized "title||artist",
# value = {'text': ..., 'audio_url': ...}. Filled by prefetch_lines() so
# song-change lookups are instant (LLM calls take ~60s).
_line_cache = {}
_line_cache_lock = threading.Lock()


def _line_key(title, artist):
    return f"{(title or '').strip().lower()}||{(artist or '').strip().lower()}"


def cached_line(song, line_type=None):
    """Return a pre-generated line for a song, or None.

    `line_type` (if given) must match — a cached 'transition' line must
    never be served for a 'stop' request (they say completely different
    things; serving the wrong one made the DJ sound confused — it talked
    about a song as if introducing it when the user asked for a recap).
    """
    key = _line_key((song or {}).get('title'), (song or {}).get('artist'))
    with _line_cache_lock:
        entry = _line_cache.get(key)
        if entry and (line_type is None or entry.get('line_type') == line_type):
            return entry
        return None


def prefetch_lines(seed, songs, include_intro=True, line_type='transition', voice=DJ_VOICE):
    """Generate + synthesize DJ lines for upcoming songs in a background thread.

    The LLM calls are slow (~60s each), so prefetching happens while the
    current song plays. Returns immediately with the number of lines queued.
    `line_type` controls what kind of line to generate ('transition' for
    song intros, 'stop' for the every-N-songs chatty segment — the client
    prefetches the next stop line while the current song still plays, so
    the talk is READY when the stop moment arrives instead of arriving
    60-90s late with short radio previews).
    """
    if not songs:
        return 0
    jobs = []
    if include_intro and seed:
        jobs.append(('intro', seed))
    for s in songs:
        jobs.append((line_type, s))

    def _worker():
        for line_type_i, song in jobs:
            key = _line_key(song.get('title'), song.get('artist'))
            with _line_cache_lock:
                if key in _line_cache:
                    continue
            try:
                line = _llm_line(line_type_i, _context_for(song, seed=seed))
                if not line:
                    continue
                path = _synth(line, voice=voice)
                audio_url = f"/api/dj/audio/{os.path.basename(path)}" if path else None
                with _line_cache_lock:
                    _line_cache[key] = {'text': line, 'audio_url': audio_url,
                                        'line_type': line_type_i}
            except Exception as e:  # noqa: BLE001
                print(f"[dj] prefetch failed for {song.get('title')}: {e}")

    t = threading.Thread(target=_worker, name='dj-prefetch', daemon=True)
    t.start()
    return len(jobs)


def _ensure_audio_dir():
    os.makedirs(AUDIO_DIR, exist_ok=True)


def _daemon_alive():
    global _daemon
    return _daemon is not None and _daemon.poll() is None


def _start_daemon():
    """Spawn (or reuse) the persistent TTS daemon. Returns True when ready."""
    global _daemon, _daemon_ready
    with _daemon_lock:
        if _daemon_alive() and _daemon_ready:
            return True
        _ensure_audio_dir()
        try:
            _daemon = subprocess.Popen(
                [TTS_PYTHON, TTS_DAEMON],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, bufsize=1,
            )
            # Wait for the READY banner (model load takes ~60-80s first time)
            ready = _daemon.stdout.readline().strip()
            _daemon_ready = ready == 'READY'
            if not _daemon_ready:
                print(f"[dj] TTS daemon failed to start: {ready}")
                _daemon.kill()
                _daemon = None
                return False
            print("[dj] TTS daemon ready")
            return True
        except Exception as e:  # noqa: BLE001
            print(f"[dj] TTS daemon spawn failed: {e}")
            _daemon = None
            return False


def _warm_daemon_async():
    """Spawn the TTS daemon in a background thread (non-blocking).

    Called from a request thread so the ~80s cold model load overlaps with
    whatever else is happening (LLM line generation, radio batch building).
    The caller should NOT wait on this; _synth will block on _start_daemon()
    anyway if it isn't ready by then.
    """

    def _warm():
        try:
            _start_daemon()
        except Exception as e:  # noqa: BLE001
            print(f"[dj] daemon warm failed: {e}")

    t = threading.Thread(target=_warm, name='tts-warm', daemon=True)
    t.start()


def _synth(text, voice=DJ_VOICE, speed=1.0):
    """Synthesize text -> wav path. Returns path or None."""
    if not text:
        return None
    if not _start_daemon():
        return None
    out_path = os.path.join(AUDIO_DIR, f"dj_{uuid.uuid4().hex[:10]}.wav")
    try:
        _daemon.stdin.write(json.dumps({
            'text': text, 'out': out_path, 'voice': voice, 'speed': speed,
        }) + '\n')
        _daemon.stdin.flush()
        resp = _daemon.stdout.readline().strip()
        if resp == 'OK' and os.path.isfile(out_path):
            return out_path
        print(f"[dj] TTS error: {resp}")
        return None
    except Exception as e:  # noqa: BLE001
        print(f"[dj] TTS call failed: {e}")
        return None


def _llm_line(line_type, context):
    """Generate a DJ line with the LLM. Returns text or ''."""
    from utils import ai_client
    if not ai_client.is_configured():
        return ''
    lines = {
        'intro': "Write a short, warm, confident DJ intro (max 40 words) welcoming "
                 "the listener to their personal radio station. Mention the vibe "
                 "they're starting with. No emojis, no hashtags.",
        'transition': "Write a SHORT DJ transition line (max 25 words) introducing "
                      "the next song. One or two sentences, conversational, like a "
                      "real radio DJ. No emojis.",
        'stop': "Write a casual, fun DJ segment (max 60 words) chatting about " \
                "the songs that actually played on this session (see PLAYED " \
                "SO FAR below). Talk about the flow and vibe of those songs. " \
                "Only mention songs from the played list. A light " \
                "recommendation is fine. No emojis, no JSON, plain text only.",
        'chat': "Answer the listener's question as a friendly, knowledgeable DJ "
                "(max 50 words). No emojis.",
    }
    prompt = lines.get(line_type, lines['transition'])
    if context:
        prompt += f"\n\nContext:\n{context}"

    try:
        # Reasoning models burn token budget thinking — max_tokens must be
        # generous (512 caused empty replies on the verbose stop prompt;
        # also NO JSON demands: asking for JSON made it spend everything
        # thinking and return '' — verified Aug 2026).
        return ai_client.chat(
            [{'role': 'user', 'content': prompt}],
            max_tokens=768, timeout=90,
        ).strip()
    except Exception as e:  # noqa: BLE001
        print(f"[dj] LLM line failed: {e}")
        return ''


def _context_for(song, played=None, seed=None, question=None):
    parts = []
    if song:
        parts.append(f"NOW/NEXT SONG: {song.get('title')} — {song.get('artist')} "
                     f"({song.get('genre') or 'genre unknown'})")
    if seed:
        parts.append(f"RADIO SEED: {seed.get('title')} — {seed.get('artist')}")
    if played:
        parts.append("PLAYED SO FAR: " + '; '.join(played[-8:]))
    if question:
        parts.append(f"LISTENER ASKED: {question}")
    return '\n'.join(parts)


def get_dj_line(line_type='transition', song=None, played=None, seed=None,
                question=None, voice=DJ_VOICE):
    """Generate + synthesize a DJ line. Returns {text, audio_url} or None.

    audio_url is a relative path the client can fetch; None if TTS unavailable
    (the UI can still show the text). Checks the prefetch cache first so
    song-change lookups are instant. 'stop' lines also return a
    `next_direction` style hint the radio uses to rotate its vibe.
    """
    if song:
        cached = cached_line(song, line_type=line_type)
        if cached:
            return cached
    # Start the TTS daemon FIRST, in the background (it takes ~60-80s to
    # load the model on a cold start). The LLM line generation takes ~60s
    # too — running them in parallel turns a ~140s first request into ~80s,
    # and more importantly warms the daemon before _synth needs it so the
    # first line ever doesn't 503 (hit live: first /api/dj/line after a
    # server restart failed with "DJ unavailable" while the daemon was still
    # loading — _start_daemon() blocks on READY, so it must NOT run inline
    # before the LLM call; it runs in a warm-up thread instead).
    _warm_daemon_async()
    text = _llm_line(line_type, _context_for(song, played, seed, question))
    if not text:
        return None
    # Stop lines may carry a JSON {text, next_direction} payload.
    next_direction = None
    if line_type == 'stop':
        try:
            import json as _json
            parsed = _json.loads(text)
            if isinstance(parsed, dict) and parsed.get('text'):
                text = parsed['text'].strip()
                next_direction = parsed.get('next_direction')
        except Exception:  # noqa: BLE001 — plain text fallback
            pass
    audio_path = _synth(text, voice=voice)
    audio_url = None
    if audio_path:
        audio_url = f"/api/dj/audio/{os.path.basename(audio_path)}"
    result = {'text': text, 'audio_url': audio_url, 'line_type': line_type}
    if next_direction:
        result['next_direction'] = next_direction
    return result
