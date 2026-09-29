"""Audio-feature music discovery engine.

Content-based recommendation built on the enrichment data already collected
per song (essentia audio features + Discogs-EffNet genre tags):

  - `radio(seed_id)`     : "songs that sound like this one" — weighted cosine
                           similarity over a normalized feature vector, with
                           genre + tag overlap bonuses.
  - `discovery(user_id)` : "music you'd like that you haven't heard" — a taste
                           profile built from the user's play history
                           (play-count-weighted feature average) is compared
                           against UNPLAYED songs. Genre affinity from the
                           user's history adds a bonus.

Everything runs locally — no external APIs, no training.

Feature vector layout (22 dims):
  [0:13]  MFCC timbre fingerprint        (w 1.0)
  [13]    tempo_bpm                      (w 1.2, log-scaled)
  [14]    danceability                   (w 0.8, log-scaled)
  [15]    energy                         (w 0.8, log-scaled)
  [16]    loudness_db                    (w 0.5)
  [17:21] spectral centroid/rolloff/complexity/zcr (w 0.4 each)
  [21:23] key as circle-of-fifths sin/cos (w 0.6)

Missing dims are masked so a song with an incomplete fingerprint still
participates (cosine runs over the intersection of valid dims).
"""
import json
import math
import threading
import time

import numpy as np

from models.database import Database

# Dimension weights (aligned with the vector layout above).
_DIM_W = np.array(
    [1.0] * 13 + [1.2, 0.8, 0.8, 0.5] + [0.4] * 4 + [0.6, 0.6],
    dtype=np.float64,
)

# Circle-of-fifths tonic positions (C=0, G=1, ..., F=11). Key names like
# 'Ab' / 'C#' map to a position; unknown keys get a neutral (0,0) pair.
_KEYS = {
    'C': 0, 'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5,
    'F#': 6, 'Gb': 6, 'C#': 7, 'Db': 7, 'G#': 8, 'Ab': 8,
    'D#': 9, 'Eb': 9, 'A#': 10, 'Bb': 10, 'F': 11,
}

_RADIO_GENRE_BONUS = 0.12      # same top-level genre as the seed
_RADIO_TAG_BONUS = 0.015       # per shared Discogs tag, capped below
_RADIO_TAG_CAP = 0.08
_DISCOVERY_TOP3_GENRE_BONUS = 0.10
_DISCOVERY_TOP6_GENRE_BONUS = 0.05
_EXPLORE_NOISE = 0.03          # random jitter so repeated runs vary a little
_RADIO_ARTIST_CAP = 3          # max songs per artist in a radio queue
_DISCOVERY_ARTIST_CAP = 2

_cache = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 60.0


# ------------------------------------------------------------- vector build

def _key_angle(key_name):
    pos = _KEYS.get((key_name or '').strip().split()[0])
    if pos is None:
        return (0.0, 0.0)
    a = pos / 12.0 * 2.0 * math.pi
    return (math.sin(a), math.cos(a))


def _song_vector(row):
    """Build the 23-dim vector + validity mask from a song_features row."""
    mfccs = row.get('mfccs')
    try:
        mfccs = json.loads(mfccs) if isinstance(mfccs, str) else mfccs
    except (ValueError, TypeError):
        mfccs = None
    if not isinstance(mfccs, list) or len(mfccs) < 13:
        mfccs = None

    v = np.zeros(23, dtype=np.float64)
    mask = np.zeros(23, dtype=bool)

    if mfccs is not None:
        for i in range(13):
            try:
                v[i] = float(mfccs[i])
                mask[i] = True
            except (TypeError, ValueError, IndexError):
                pass

    def add(idx, val, log_scale=False, min_val=1e-9):
        try:
            val = float(val)
        except (TypeError, ValueError):
            return
        if val is None or (isinstance(val, float) and math.isnan(val)):
            return
        if log_scale:
            val = math.log1p(max(0.0, val) + min_val)
        v[idx] = val
        mask[idx] = True

    add(13, row.get('tempo_bpm'), log_scale=True)
    add(14, row.get('danceability'), log_scale=True)
    add(15, row.get('energy'), log_scale=True)
    add(16, row.get('loudness_db'))
    add(17, row.get('spectral_centroid'), log_scale=True)
    add(18, row.get('spectral_rolloff'), log_scale=True)
    add(19, row.get('spectral_complexity'), log_scale=True)
    add(20, row.get('zero_crossing_rate'))
    ka, kb = _key_angle(row.get('key_name'))
    v[21], v[22] = ka, kb
    mask[21] = mask[22] = True
    return v, mask


def _load_features(force=False):
    """Load + normalize all song feature vectors (cached 60s).

    Transient DB blips (the MySQL server is remote) could return zero rows;
    retry once before giving up so a one-off network hiccup doesn't blank
    every recommendation call.
    """
    global _cache
    with _cache_lock:
        if not force and _cache.get('ts') and time.time() - _cache['ts'] < _CACHE_TTL:
            return _cache['data']
    rows = Database.execute_query(
        "SELECT song_id, mfccs, tempo_bpm, danceability, energy, loudness_db, "
        "spectral_centroid, spectral_rolloff, spectral_complexity, "
        "zero_crossing_rate, key_name FROM song_features",
        fetch_all=True,
    ) or []
    if not rows:
        time.sleep(0.5)
        rows = Database.execute_query(
            "SELECT song_id, mfccs, tempo_bpm, danceability, energy, loudness_db, "
            "spectral_centroid, spectral_rolloff, spectral_complexity, "
            "zero_crossing_rate, key_name FROM song_features",
            fetch_all=True,
        ) or []

    vecs, masks, ids = [], [], []
    for r in rows:
        v, m = _song_vector(r)
        if v is not None:
            vecs.append(v)
            masks.append(m)
            ids.append(r['song_id'])

    if not vecs:
        return {'ids': [], 'vecs': np.zeros((0, 23)), 'masks': np.zeros((0, 23), bool)}

    V = np.stack(vecs)
    M = np.stack(masks)
    # Per-dim z-score over the songs that have that dim (clip outliers).
    # Compute sums manually over the masked entries so dims that NO song has
    # (e.g. spectral_complexity) stay neutral (mu=0, sd=1) without NaN warnings.
    counts = M.sum(axis=0)
    mu = np.zeros(V.shape[1])
    sd = np.ones(V.shape[1])
    valid = counts > 0
    if valid.any():
        mu[valid] = (V * M).sum(axis=0)[valid] / counts[valid]
        dev = (V - mu) * M
        sd[valid] = np.sqrt((dev * dev).sum(axis=0)[valid] / counts[valid])
    sd = np.where(sd < 1e-9, 1.0, sd)
    V = (V - mu) / sd
    V = np.clip(V, -3, 3)
    data = {'ids': ids, 'vecs': V, 'masks': M, 'mu': mu, 'sd': sd}
    with _cache_lock:
        _cache = {'ts': time.time(), 'data': data}
    return data


def _weighted_cosine(a, ma, b, mb):
    """Cosine similarity over the intersection of valid dims, dim-weighted."""
    w = _DIM_W
    both = ma & mb
    if not both.any():
        return 0.0
    wa = a * w
    wb = b * w
    num = float(np.sum(wa[both] * wb[both]))
    den = math.sqrt(float(np.sum(wa[both] ** 2))) * math.sqrt(float(np.sum(wb[both] ** 2)))
    return num / den if den > 1e-12 else 0.0


# --------------------------------------------------------------- metadata

def _songs_by_id():
    rows = Database.execute_query(
        "SELECT id, title, artist, album, genre, cover_path, duration, "
        "file_path FROM songs",
        fetch_all=True,
    ) or []
    out = {}
    for r in rows:
        r['primary_artist'] = (r.get('artist') or '').split(',')[0].strip()
        out[r['id']] = r
    return out


def _primary_genre(song_id):
    row = Database.execute_query(
        "SELECT genre FROM songs WHERE id = %s", (song_id,), fetch_one=True)
    return (row or {}).get('genre') or ''


def _discogs_tags(song_id):
    rows = Database.execute_query(
        "SELECT tag_name FROM song_tags WHERE song_id = %s AND source = 'discogs-effnet'",
        (song_id,), fetch_all=True,
    ) or []
    return {r['tag_name'] for r in rows}


def _artist_count_cap(artist, chosen_artists, cap):
    return chosen_artists.get(artist, 0) >= cap


# -------------------------------------------------------------- public API

def _rank_candidates(seed_vec, seed_mask, candidate_ids, songs, weights=None,
                     genre_bonus=0.0, seed_tags=None, artist_cap=99,
                     tag_bonus=0.0, tag_cap=0.0, exclude_ids=None):
    """Score + greedily pick candidates with per-artist diversity."""
    data = _load_features()
    vec_by_id = {sid: (v, m) for sid, v, m in zip(data['ids'], data['vecs'], data['masks'])}
    exclude = set(exclude_ids or ())
    seed_tags = seed_tags or set()

    scored = []
    for sid in candidate_ids:
        if sid in exclude:
            continue
        item = vec_by_id.get(sid)
        if not item:
            continue
        sim = _weighted_cosine(seed_vec, seed_mask, item[0], item[1])
        # Optional per-candidate genre boost (for discovery: affinity).
        gb = genre_bonus(sid) if callable(genre_bonus) else genre_bonus
        score = sim + gb + np.random.uniform(0, _EXPLORE_NOISE)
        if tag_bonus and seed_tags:
            overlap = len(seed_tags & _discogs_tags(sid))
            score += min(overlap * tag_bonus, tag_cap)
        scored.append((score, sid))

    scored.sort(key=lambda x: -x[0])
    chosen, artist_counts = [], {}
    for score, sid in scored:
        if len(chosen) >= (weights or {}).get('limit', 30):
            break
        artist = songs.get(sid, {}).get('primary_artist', '')
        if artist and _artist_count_cap(artist, artist_counts, artist_cap):
            continue
        chosen.append(sid)
        artist_counts[artist] = artist_counts.get(artist, 0) + 1
    return chosen


def radio(seed_id, limit=30, user_id=None):
    """Songs that sound like the seed, ranked by audio similarity."""
    data = _load_features()
    if seed_id not in data['ids']:
        return []
    idx = data['ids'].index(seed_id)
    seed_vec, seed_mask = data['vecs'][idx], data['masks'][idx]

    songs = _songs_by_id()
    seed_genre = _primary_genre(seed_id)
    seed_tags = _discogs_tags(seed_id)
    if not seed_tags:
        # Fall back to top-level genre string as a pseudo-tag
        seed_tags = {seed_genre} if seed_genre else set()

    disliked = set()
    if user_id is not None:
        from models.song_rating import SongRatingModel
        disliked = set(SongRatingModel.get_disliked_song_ids(user_id))

    def genre_bonus(sid):
        g = _primary_genre(sid)
        if g and g == seed_genre:
            return _RADIO_GENRE_BONUS
        return 0.0

    chosen = _rank_candidates(
        seed_vec, seed_mask, data['ids'], songs,
        weights={'limit': limit},
        genre_bonus=genre_bonus,
        seed_tags=seed_tags,
        tag_bonus=_RADIO_TAG_BONUS, tag_cap=_RADIO_TAG_CAP,
        artist_cap=_RADIO_ARTIST_CAP,
        exclude_ids=disliked | {seed_id},
    )
    return chosen


def discovery(user_id, limit=30):
    """Unplayed songs ranked by similarity to the user's taste profile."""
    data = _load_features()
    if not data['ids']:
        return []
    vec_by_id = {sid: (v, m) for sid, v, m in zip(data['ids'], data['vecs'], data['masks'])}

    # Taste profile: play-count-weighted average of played songs' vectors.
    plays = Database.execute_query(
        "SELECT song_id, COUNT(*) c FROM play_history WHERE user_id = %s AND counted = 1 "
        "GROUP BY song_id", (user_id,), fetch_all=True,
    ) or []
    played_ids = [p['song_id'] for p in plays]
    played_set = set(played_ids)

    # Genre affinity from the user's listening history.
    genre_counts = {}
    if played_ids:
        ph = ', '.join(['%s'] * len(played_ids))
        rows = Database.execute_query(
            f"SELECT genre, COUNT(*) c FROM songs WHERE id IN ({ph}) "
            "AND genre IS NOT NULL AND genre != '' GROUP BY genre",
            tuple(played_ids), fetch_all=True,
        ) or []
        genre_counts = {r['genre']: r['c'] for r in rows}
    top_genres = sorted(genre_counts, key=genre_counts.get, reverse=True)
    top3, top6 = set(top_genres[:3]), set(top_genres[:6])

    wsum = np.zeros(23)
    wmask = np.zeros(23, bool)
    wtotal = 0.0
    for p in plays:
        item = vec_by_id.get(p['song_id'])
        if not item:
            continue
        w = math.log1p(p['c'])  # diminishing weight for heavy repeat plays
        wsum += item[0] * w
        wmask |= item[1]
        wtotal += w
    if wtotal <= 0:
        return []
    taste = wsum / wtotal

    disliked = set()
    try:
        from models.song_rating import SongRatingModel
        disliked = set(SongRatingModel.get_disliked_song_ids(user_id))
    except Exception:  # noqa: BLE001
        pass

    songs = _songs_by_id()

    def genre_bonus(sid):
        g = _primary_genre(sid)
        if g in top3:
            return _DISCOVERY_TOP3_GENRE_BONUS
        if g in top6:
            return _DISCOVERY_TOP6_GENRE_BONUS
        return 0.0

    unplayed = [sid for sid in data['ids'] if sid not in played_set]

    # Per-account isolation: only rank songs the user actually has.
    try:
        from models.library_access import LibraryAccessModel
        visible = LibraryAccessModel.visible_song_ids(user_id)
        if visible:
            unplayed = [sid for sid in unplayed if sid in visible]
    except Exception:  # noqa: BLE001
        pass

    return _rank_candidates(
        taste, wmask, unplayed, songs,
        weights={'limit': limit},
        genre_bonus=genre_bonus,
        artist_cap=_DISCOVERY_ARTIST_CAP,
        exclude_ids=disliked,
    )
