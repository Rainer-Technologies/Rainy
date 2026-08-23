"""Seed-anchored radio engine (YouTube-style autoplay).

Given a library song, generate an endless stream of similar songs that are
NOT in the library. Unlike the discovery feed (which uses the user's overall
taste profile), radio anchors EVERYTHING on the seed song: the LLM gets the
seed's genre, Discogs tags, artist and audio vibe (BPM/energy/key) and writes
queries that find music "like this song". The seed can also drift — each batch
mentions recently played titles so the LLM keeps the vibe but explores.

Pipeline per batch:
  1. LLM generates 5-6 search queries anchored on the seed (+ last played).
  2. ytmusicapi searches each query; results filtered against the library,
     DJ-mix titles, >900s tracks, and previously-served video ids.
  3. LLM curates the top N with a one-line reason each.
  4. Session state (played ids, seen ids) lives in memory with a TTL.

Falls back to heuristic queries (seed genre/year, "similar to artist") when
the LLM is unavailable — radio never hard-fails.
"""
import threading
import time
import uuid

from models.database import Database
from models.settings import SettingsModel
from utils.metadata import MetadataSearcher
from models.duplicates import _norm
from utils.discovery_feed import _is_bad_song_result

BATCH_SIZE = 8
SEARCH_PER_QUERY = 12
MAX_QUERIES = 6
SESSION_TTL = 3600 * 8   # 8 hours, matching the radio session lifetime
_CURATE_CAP = 24


# --------------------------------------------------------------- session

_sessions = {}
_sessions_lock = threading.Lock()


class RadioSession:
    def __init__(self, session_id, user_id, seed_song):
        self.session_id = session_id
        self.user_id = user_id
        self.seed = seed_song
        self.played_ids = []       # videoIds served so far (any batch)
        self.recent_titles = []    # last few titles, for LLM drift context
        self.created_at = time.time()
        self.last_access = time.time()
        # Async batch generation state (populated by the worker thread).
        self.pending_songs = []    # songs ready to serve (next batch)
        self.generating = False    # a batch is being generated right now
        self.gen_error = None      # last generation error (str or None)
        self.generation_started = time.time()

    def to_public(self):
        cover = (self.seed.get('cover_path') or '').replace('\\', '/')
        return {
            'session_id': self.session_id,
            'seed': {
                'id': self.seed.get('id'),
                'title': self.seed.get('title'),
                'artist': self.seed.get('artist'),
                'album': self.seed.get('album'),
                'genre': self.seed.get('genre'),
                'cover_path': cover or None,
                'duration': self.seed.get('duration') or 0,
            },
        }

    def status(self):
        """Server-side status for the client (ready / generating / error)."""
        if self.gen_error:
            return 'error'
        if self.pending_songs:
            return 'ready'
        if self.generating:
            return 'generating'
        return 'idle'


def _expire_sessions():
    now = time.time()
    dead = [k for k, s in _sessions.items() if now - s.last_access > SESSION_TTL]
    for k in dead:
        _sessions.pop(k, None)


def get_session(session_id):
    with _sessions_lock:
        s = _sessions.get(session_id)
        if s:
            s.last_access = time.time()
        return s


def create_session(user_id, seed_song):
    with _sessions_lock:
        _expire_sessions()
        session_id = uuid.uuid4().hex[:16]
        s = RadioSession(session_id, user_id, seed_song)
        _sessions[session_id] = s
        return s


# ------------------------------------------------------------- seed info

def _song_tags_for_llm(song_id):
    """Top Discogs tags as a compact string."""
    rows = Database.execute_query(
        "SELECT tag_name FROM song_tags WHERE song_id = %s AND source = 'discogs-effnet' "
        "ORDER BY weight DESC LIMIT 6",
        (song_id,), fetch_all=True,
    ) or []
    return ', '.join(r['tag_name'] for r in rows) or ''


def _song_vibe(song_id):
    """Audio features as a short human-readable vibe string."""
    f = Database.execute_query(
        "SELECT tempo_bpm, key_name, scale_type, danceability, energy "
        "FROM song_features WHERE song_id = %s",
        (song_id,), fetch_one=True,
    )
    if not f:
        return ''
    parts = []
    if f.get('tempo_bpm'):
        parts.append(f"{f['tempo_bpm']:.0f} BPM")
    if f.get('key_name'):
        parts.append(f"key of {f['key_name']}" + (f" {f['scale_type']}" if f.get('scale_type') else ''))
    if f.get('danceability') is not None:
        d = float(f['danceability'])
        parts.append("very danceable" if d > 1.5 else "moderately danceable" if d > 0.8 else "not very danceable")
    if f.get('energy') is not None:
        parts.append("high energy" if float(f['energy']) > 700000 else "medium energy")
    return '; '.join(parts) or ''


def _seed_context(session):
    """Compact LLM description of the seed + recent radio history."""
    seed = session.seed
    song_id = seed.get('id')
    tags = _song_tags_for_llm(song_id)
    vibe = _song_vibe(song_id)
    lines = [
        f"SEED SONG: {seed.get('title')} — {seed.get('artist')}",
        f"SEED GENRE: {seed.get('genre') or 'unknown'}",
    ]
    if tags:
        lines.append(f"SEED STYLE TAGS: {tags}")
    if vibe:
        lines.append(f"SEED AUDIO VIBE: {vibe}")
    if session.recent_titles:
        lines.append("RECENTLY PLAYED ON THIS RADIO: " + '; '.join(session.recent_titles[-5:]))
    return '\n'.join(lines)


# -------------------------------------------------------------- queries

def _llm_queries(session, direction=None):
    from utils import ai_client
    if not ai_client.is_configured():
        return []
    prompt = f"""You are a music radio director. A user started a radio station from one song.

{_seed_context(session)}
"""
    if direction:
        prompt += f"\nDJ STYLE SHIFT: {direction}\n"
    prompt += f"""
Write {MAX_QUERIES} YouTube Music SEARCH QUERIES that will find songs that FIT THIS
SEED's STYLE — the kind of tracks you'd play next on a radio station built around it.
Mix of: genre/subgenre searches, similar-artist phrasing, mood/style searches derived
from the seed's audio vibe, and (if the seed is from a soundtrack/video game) related
composers or adjacent genres. Avoid the seed's own exact artist as the whole query.
IMPORTANT: queries must return SINGLE SONGS — never include words like "mix",
"mega mix", "compilation", "live", "session", "nonstop", "1 hour", "best of",
"hits" or year-only phrases (e.g. "reggaeton 2025" surfaces auto-generated
compilations). Prefer "song", "songs", "like", "similar", or named-artist
pairings (e.g. "reggaeton like Bad Bunny"). Keep queries under 8 words. Return
ONLY a JSON object: {{"queries": ["...", ...]}}"""
    try:
        out = ai_client.chat_json(
            [{'role': 'user', 'content': prompt}], max_tokens=4096, timeout=120)
        qs = out.get('queries') if isinstance(out, dict) else None
        if not isinstance(qs, list):
            return []
        return [q for q in qs if isinstance(q, str) and q.strip()][:MAX_QUERIES]
    except Exception as e:  # noqa: BLE001
        print(f"[radio] LLM query generation failed: {e}")
        return []


def _heuristic_queries(session):
    seed = session.seed
    genre = (seed.get('genre') or '').strip()
    artist = (seed.get('artist') or '').split(',')[0].strip()
    queries = []
    # Named-artist pairings return real songs; bare "<genre> 2025" queries
    # surface auto-generated mix compilations (fixed Aug 2026).
    if artist and artist != 'Unknown Artist':
        queries.append(f"songs like {artist}")
        queries.append(f"{artist} type songs")
    if genre and genre not in ('Music', 'Gaming', ''):
        queries.append(f"{genre} songs")
        queries.append(f"best {genre} songs ever")
    # Fall back to a multi-genre random-ish pick so the same seed doesn't
    # always produce the same handful of hits.
    return [q for q in queries if q][:MAX_QUERIES] or ['new music this week']


# ---------------------------------------------------------- search/filter

def _musicbrainz_song_queries(genre, artist='', fast=False, session=None):
    """Exact-song-name search queries from the MusicBrainz catalog.

    Returns ["Artist1 Title1", "Artist2 Title2", ...] for REAL songs in the
    seed's genre (and artist, when given). Searching YouTube for these exact
    pairs finds the actual track — raw genre queries are what surface
    auto-generated mix compilations. Rate-limited to ~1 req/s (throttled in
    lastfm.py); returns [] on any failure so callers fall back gracefully.

    Genre resolution chain (the songs.genre column is usually the generic
    "Music", which is useless for catalog search):
      1. seed's top Discogs-EffNet tag (song_tags, source=discogs-effnet)
      2. seed's MusicBrainz genre tags
      3. the songs.genre column if it's a real genre
    When nothing resolves, falls back to the seed ARTIST's own catalog
    (artist:"X" returns that artist's real songs).
    """
    from utils.lastfm import musicbrainz_search_songs
    genre = _resolve_seed_genre(session, genre)
    try:
        if genre:
            # Genre-only search spreads across many artists of that genre
            # (the artist cap in _search_batch then thins to ~2/artist).
            songs = musicbrainz_search_songs(
                genre=genre, artist=None,
                related_to=artist or None, limit=25)
        elif artist:
            # No usable genre — search the seed artist's own catalog.
            songs = musicbrainz_search_songs(
                genre=None, artist=artist,
                related_to=artist, limit=15)
        else:
            return []
    except Exception as e:  # noqa: BLE001
        print(f"[radio] MusicBrainz song search failed: {e}")
        return []
    queries = []
    for s in songs:
        title = (s.get('title') or '').strip()
        art = (s.get('artist') or '').strip()
        if not title or not art:
            continue
        # "Artist Title" — YouTube's exact-song query. Skip feature-length
        # entries (>8 min) that the result filter would reject anyway.
        if (s.get('length') or 0) > 600:
            continue
        primary = art.split(',')[0].strip()
        queries.append(f"{primary} {title}")
    return queries[:10]


def _resolve_seed_genre(session, fallback_genre=''):
    """Best real genre label for the seed song, or '' if unknown.

    Prefers the Discogs-EffNet genre tag (the classifier output), then
    MusicBrainz genre tags, then the songs.genre column if it's a real
    genre rather than the generic 'Music'/'Gaming' placeholder.
    """
    seed = (session.seed if session else None)
    song_id = (seed or {}).get('id') if seed else None
    if song_id:
        rows = Database.execute_query(
            "SELECT tag_name FROM song_tags WHERE song_id = %s "
            "AND source = 'discogs-effnet' ORDER BY weight DESC LIMIT 3",
            (song_id,), fetch_all=True) or []
        for r in rows:
            g = (r.get('tag_name') or '').strip()
            if g and g.lower() not in ('music', 'gaming', 'unknown'):
                return g
        rows = Database.execute_query(
            "SELECT tag_name FROM song_tags WHERE song_id = %s "
            "AND source = 'musicbrainz' ORDER BY weight DESC LIMIT 3",
            (song_id,), fetch_all=True) or []
        for r in rows:
            g = (r.get('tag_name') or '').strip()
            if g and g.lower() not in ('music', 'gaming', 'unknown'):
                return g
    g = (fallback_genre or '').strip()
    if g and g.lower() not in ('music', 'gaming', 'unknown', 'various'):
        return g
    return ''


def _search_batch(session, exclude_video_ids, direction=None, fast=False):
    """Search + filter a fresh batch; returns list of candidate dicts.

    Queries are EXACT SONG NAMES where possible: we first ask MusicBrainz
    (free, no key) for real catalogued tracks in the seed's genre/artist
    neighborhood, then search YouTube for those specific "Artist Title"
    pairs. Raw genre/LLM queries are the fallback — they're what surface
    auto-generated mix compilations (Aug 2026).
    """
    searcher = MetadataSearcher()
    # Only match against songs the session owner can see (in-library flag).
    from models.library_access import LibraryAccessModel
    join_sql, join_params = LibraryAccessModel.access_join(session.user_id)
    lib_rows = Database.execute_query(
        f"""SELECT s.id, s.title, s.artist FROM songs s
            {join_sql}""",
        join_params, fetch_all=True) or []
    lib_index = {}
    for row in lib_rows:
        key = _norm(row.get('title')) + '||' + _norm(row.get('artist'))
        lib_index.setdefault(key, row['id'])

    seed = session.seed
    seed_artist = (seed.get('artist') or '').split(',')[0].strip()
    seed_genre = (seed.get('genre') or '').strip()

    # 1) REAL SONG NAMES from the MusicBrainz catalog — the primary source.
    queries = _musicbrainz_song_queries(seed_genre, seed_artist, fast=fast, session=session)

    # 2) Fall back to LLM/heuristic queries if MB gave us nothing.
    if not queries:
        queries = (_heuristic_queries(session) if fast
                   else _llm_queries(session, direction=direction) or _heuristic_queries(session))
    excluded = set(exclude_video_ids or [])
    seen_vids, seen_keys, results = set(excluded), set(), []
    artist_counts = {}   # diversify: max 2 tracks per artist in one batch

    for q in queries:
        try:
            found = searcher.search(q, limit=SEARCH_PER_QUERY)
        except Exception as e:  # noqa: BLE001
            print(f"[radio] search '{q}' failed: {e}")
            continue
        for s in found:
            vid = s.get('videoId')
            if not vid or vid in seen_vids:
                continue
            title = (s.get('title') or '').strip()
            if _is_bad_song_result(s):
                continue
            key = _norm(title) + '||' + _norm(s.get('artist'))
            if key in seen_keys or key in lib_index:
                continue
            # Artist diversity: "songs like <seed artist>" returns a wall of
            # that same artist — cap at 2 per artist so a batch feels like a
            # radio station, not an artist discography (Aug 2026).
            artist_norm = _norm((s.get('artist') or '').split(',')[0])
            if artist_norm:
                artist_counts[artist_norm] = artist_counts.get(artist_norm, 0) + 1
                if artist_counts[artist_norm] > 2:
                    continue
            seen_vids.add(vid)
            seen_keys.add(key)
            results.append(s)
    return results, queries


def _curate(session, candidates):
    """LLM picks the best BATCH_SIZE candidates for this radio, with reasons."""
    from utils import ai_client
    if not candidates:
        return []
    if not ai_client.is_configured():
        return candidates[:BATCH_SIZE]

    listing = []
    for i, c in enumerate(candidates[:_CURATE_CAP]):
        listing.append(
            f"{i}. {c['title']} — {c['artist']} ({c.get('album') or '?'}, "
            f"{c.get('year') or '?'})")
    listing_str = '\n'.join(listing)

    prompt = f"""You are a radio DJ curating the next tracks for a station built on one seed song.

{_seed_context(session)}

Candidate songs found online (index. title — artist (album, year)):

{listing_str}

Pick the {BATCH_SIZE} tracks that best continue this radio's vibe. Keep it cohesive
with the seed but don't just repeat the same artist. Skip mixes/lives/covers and
anything that sounds like a duplicate. VARY the picks: avoid the most obvious
megahits of the genre (Despacito, Gasolina, Mi Gente and similar) unless they're
the only fit — radio should DISCOVER, not replay the top-10 playlist. Return ONLY
a JSON object: {{"picks": [{{"index": 3, "reason": "why it fits"}}, ...]}}"""
    try:
        out = ai_client.chat_json(
            [{'role': 'user', 'content': prompt}], max_tokens=8192, timeout=180)
        picks = out.get('picks') if isinstance(out, dict) else None
        if not isinstance(picks, list):
            return candidates[:BATCH_SIZE]
        ranked = []
        for p in picks:
            if not isinstance(p, dict):
                continue
            try:
                idx = int(p.get('index'))
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(candidates):
                item = dict(candidates[idx])
                item['reason'] = str(p.get('reason') or '')[:160]
                ranked.append(item)
        if ranked:
            return ranked[:BATCH_SIZE]
    except Exception as e:  # noqa: BLE001
        print(f"[radio] LLM curation failed: {e}")
    return candidates[:BATCH_SIZE]


# ------------------------------------------------------------- public API

def _to_song_dict(c):
    return {
        'videoId': c.get('videoId'),
        'title': c.get('title'),
        'artist': c.get('artist'),
        'album': c.get('album'),
        'year': c.get('year'),
        'duration': c.get('duration'),
        'duration_text': c.get('duration_text'),
        'cover_url': c.get('cover_url'),
        'reason': c.get('reason', ''),
        'in_library': False,
    }


def start(user_id, song_id=None, fast=False):
    """Create a radio session from a library song (fast — no LLM work).

    With `song_id` None, seeds from the user's OWN TASTE (top-played artists
    + genres from play history) — the Spotify-DJ "based on your likes" mode.
    With `fast=True`, the first batch skips the LLM (heuristic queries, no
    curation) so music starts in seconds; later batches are LLM-quality.

    Batch generation happens in the background; poll `status`/`take_batch`.
    """
    if song_id is not None:
        # Isolation: the seed must be in the user's own library.
        from models.library_access import LibraryAccessModel
        if not LibraryAccessModel.has_access(user_id, song_id):
            return None, {'error': 'Song not found'}
        song = Database.execute_query(
            "SELECT id, title, artist, album, genre, cover_path, duration FROM songs WHERE id = %s",
            (song_id,), fetch_one=True,
        )
        if not song:
            return None, {'error': 'Song not found'}
    else:
        song = _taste_seed(user_id)
        if not song:
            return None, {'error': 'No listening history to build a taste seed from'}

    session = create_session(user_id, song)
    generate_batch(session, fast=fast)   # kicks off the background worker
    return session, {}


def _taste_seed(user_id):
    """Build a synthetic seed from the user's taste.

    Priority: play history (top-played) → liked songs → any recently added
    library songs. Returns a dict shaped like a songs row ({id, title,
    artist, album, genre}) with id=None (no library song) — the radio engine
    only uses title/artist/genre for queries.
    """
    rows = Database.execute_query(
        """SELECT s.id, s.title, s.artist, s.album, s.genre, s.cover_path, s.duration, COUNT(ph.id) AS n
          FROM play_history ph
          JOIN songs s ON s.id = ph.song_id
          WHERE ph.user_id = %s
          GROUP BY s.id, s.title, s.artist, s.album, s.genre, s.cover_path, s.duration
          ORDER BY n DESC, MAX(ph.played_at) DESC
          LIMIT 5""",
        (user_id,), fetch_all=True,
    ) or []
    if not rows:
        # Fallback 1: liked songs.
        rows = Database.execute_query(
            """SELECT s.id, s.title, s.artist, s.album, s.genre, s.cover_path, s.duration
              FROM song_ratings sr JOIN songs s ON s.id = sr.song_id
              WHERE sr.user_id = %s AND sr.rating = 'like'
              ORDER BY sr.created_at DESC LIMIT 5""",
            (user_id,), fetch_all=True,
        ) or []
    if not rows:
        # Fallback 2: most recently added library songs.
        rows = Database.execute_query(
            """SELECT id, title, artist, album, genre, cover_path, duration FROM songs
              ORDER BY id DESC LIMIT 5""",
            fetch_all=True,
        ) or []
    if not rows:
        return None
    top = rows[0]
    genre = top.get('genre') or 'unknown'
    genres = [r.get('genre') for r in rows if r.get('genre')]
    if genres:
        from collections import Counter
        genre = Counter(genres).most_common(1)[0][0]
    return {
        'id': top.get('id'),
        'title': top.get('title'),
        'artist': top.get('artist'),
        'album': top.get('album'),
        'genre': genre,
        'cover_path': top.get('cover_path'),
        'duration': top.get('duration') or 0,
        '_taste_seed': True,
    }


def generate_batch(session, direction=None, fast=False):
    """Start (or restart) background generation of the next batch.

    Uses a per-session daemon thread so long LLM calls never block a request
    and the client can poll for readiness instead of hanging on a 2-minute
    synchronous call. Idempotent: won't start a second worker while one runs.
    `direction` (optional) is a DJ-provided style hint ("shift toward darker,
    slower reggaeton") that biases the LLM's query generation.
    `fast=True` skips the LLM entirely (heuristic queries + no curation) so
    the FIRST batch lands in ~5-10s — the DJ station starts playing music
    almost immediately; later batches use the full LLM pipeline for quality.
    """
    if session.generating:
        return False
    session.generating = True
    session.gen_error = None
    session.gen_direction = direction
    session.gen_fast = fast

    def _worker():
        try:
            songs, meta = _generate_once(session)
            session.pending_songs = songs
        except Exception as e:  # noqa: BLE001
            print(f"[radio] batch generation failed: {e}")
            session.gen_error = str(e)
            session.pending_songs = []
        finally:
            session.generating = False

    t = threading.Thread(target=_worker, name=f'radio-{session.session_id}',
                         daemon=True)
    t.start()
    return True


def _generate_once(session):
    """Search + curate one batch; records served ids; returns (songs, meta)."""
    fast = getattr(session, 'gen_fast', False)
    candidates, queries = _search_batch(
        session, exclude_video_ids=session.played_ids,
        direction=getattr(session, 'gen_direction', None),
        fast=fast)
    # Fast mode: no LLM curation — just take the first candidates as-is.
    picked = candidates[:BATCH_SIZE] if fast else _curate(session, candidates)
    songs = [_to_song_dict(c) for c in picked]
    for c in picked:
        if c.get('videoId'):
            session.played_ids.append(c['videoId'])
        title = c.get('title')
        if title:
            session.recent_titles.append(title)
    session.recent_titles = session.recent_titles[-8:]
    return songs, {'queries': queries, 'candidates': len(candidates)}


def take_batch(session):
    """Serve a pending batch if ready. Returns (songs, status)."""
    if session.pending_songs:
        songs = session.pending_songs
        session.pending_songs = []
        return songs, 'ready'
    if session.gen_error:
        return [], 'error'
    if session.generating:
        return [], 'generating'
    return [], 'idle'


def next_batch(session, count=BATCH_SIZE):
    """Legacy synchronous generation (kept for web fallback / tests)."""
    return _generate_once(session)
