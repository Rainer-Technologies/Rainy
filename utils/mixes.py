"""Personalised mixes, YouTube-Music style.

Turns the listening data Rainy already has (play history, likes, audio
features, genres, artist relations, scan dates) into a shelf of ready-made
mixes:

  Made for you   Supermix, My Mix 1..N (taste groups over your analysed songs)
  Fresh & known  Discover, Replay, Right Now, Rediscover, New Arrivals, Liked
  Because you    "<Artist> Mix" for the artists you listen to most
  Moods          Energize, Chill, Focus, Workout, Party, Sleep

Picking has two parts (see `_pick`): a fixed core of the best-scoring songs
and a seeded tail, so a refresh rotates the tail and keeps the core. Flow then
orders the songs deterministically, starting from the core, so the core keeps
its order across refreshes too.

Songs without audio features ("unanalysed") are judged differently by kind:
  - feature-driven mixes (supermix, discover, moods, My Mix, endless play)
    judge songs by sound: at most `_UNANALYSED_MAX` unanalysed songs, and moods
    leave them out altogether;
  - history-driven mixes (liked, replay, right now, new, rediscover, artist
    mixes) are about what the listener did: unanalysed songs stay in, spread
    evenly through the order, since sound is not what they describe.

A mix kind never vanishes silently. A short mix is topped up from a documented
fallback; if it still cannot reach `_MIN_MIX`, it is left out and the reason is
recorded in `build_mixes(..., notes=...)` and logged.

`extend()` powers endless playback: it keeps picking songs that sound like
whatever is playing now, so a mix never just stops.

Pure logic lives in functions that take a `Ctx` so it can be unit-tested
without a database; `load_context()` is the only place that touches MySQL.
"""
import math
import re
import time
from datetime import datetime, timedelta

import numpy as np

from models.database import Database

MIX_SIZE = 30

_ARTIST_CAP = 3          # max songs per artist in a normal mix
_OWN_ARTIST_CAP = 4      # max songs by the artist an artist mix is about
_MIN_FEATURED = 25       # analysed songs needed before mood mixes appear
_MIN_MIX = 8             # a mix below this is topped up, or left out with a reason
_CORE_SHARE = 0.8        # share of each mix fixed by score; the rest rotates
_TAIL_TEMP = 0.5         # tail draw sharpness, in z-score units of the candidates
_UNANALYSED_MAX = 2      # songs without audio features allowed in a feature-driven mix
_MOOD_CUT_PCT = 67       # a mood's coherence bar: its top third by audio fit
_GENRE_LABEL = 0.5       # mood credit when only the top-level genre names it
_CLUSTER_SEED = 0        # base seed of My Mix clustering: the library decides, not the refresh
_CLUSTER_RESTARTS = 4    # fixed-seed k-means runs per taste split; the best is kept
_MY_MIX_MAX = 5          # at most this many My Mixes
_MY_MIX_FLOOR = 3        # keep this many My Mixes whenever the taste holds that many groups
_MY_MIN_MEMBERS = 5      # cluster-size floor: a taste group needs this many analysed songs
_MY_MIN_PROFILE = 12     # analysed listened songs before any My Mix appears
_MY_MAX_OVERLAP = 0.6    # My Mixes sharing more than this share of songs are one mix
# Mood score = audio fit blended with what the listener and the crowd say.
_W_AUDIO, _W_LABEL, _W_AFF, _W_TASTE = 0.60, 0.25, 0.10, 0.05

# Dimension weights, aligned with utils.recommender's 23-dim vector.
_DIM_W = np.array([1.0] * 13 + [1.2, 0.8, 0.8, 0.5] + [0.4] * 4 + [0.6, 0.6],
                  dtype=np.float64)


# ------------------------------------------------------------------ context

class FeatureIndex:
    """Unit-normalised, dim-weighted feature rows for the visible songs."""

    def __init__(self, ids=None, U=None):
        self.ids = list(ids or [])
        self.pos = {sid: i for i, sid in enumerate(self.ids)}
        self.U = U if U is not None else np.zeros((0, len(_DIM_W)))

    def __bool__(self):
        return len(self.ids) > 0

    @classmethod
    def build(cls, data, visible):
        """`data` is utils.recommender._load_features() output."""
        ids, rows = [], []
        for sid, vec, mask in zip(data.get('ids', []), data.get('vecs', []),
                                  data.get('masks', [])):
            if sid not in visible:
                continue
            a = np.where(mask, vec, 0.0) * _DIM_W
            n = float(np.linalg.norm(a))
            if n < 1e-9:
                continue
            ids.append(sid)
            rows.append(a / n)
        if not ids:
            return cls()
        return cls(ids, np.stack(rows))

    def sims_to(self, centroid):
        """Cosine similarity of every indexed song to a unit centroid."""
        if centroid is None or not self.ids:
            return None
        return self.U @ centroid

    def centroid(self, weighted):
        """Unit centroid of {song_id: weight}; None when nothing indexed."""
        idx, w = [], []
        for sid, wt in weighted.items():
            i = self.pos.get(sid)
            if i is not None and wt > 0:
                idx.append(i)
                w.append(wt)
        if not idx:
            return None
        c = (self.U[idx] * np.array(w)[:, None]).sum(axis=0)
        n = float(np.linalg.norm(c))
        return c / n if n > 1e-9 else None


class Ctx:
    """Everything the mix builders need, gathered once per request."""

    def __init__(self, songs, liked=(), disliked=(), plays=None, hour_plays=None,
                 hour=12, fi=None, mood_pct=None, related=None, now=None, tags=None):
        self.songs = songs                    # id -> row (visible only)
        self._blocked = None                  # lazy: artists the listener rejects
        self.liked = liked                    # property: visible ids only
        self.disliked = disliked              # property: song ids
        self.plays = plays or {}              # id -> {'c','last','c60'}
        self.hour_plays = hour_plays or {}    # id -> plays around this hour
        self.hour = hour
        self.fi = fi or FeatureIndex()
        self.mood_pct = mood_pct or {}        # id -> percentile dict (analysed only)
        self.tags = tags or {}                # id -> [(tag_name, weight)]
        self.related = related or (lambda artist: [])
        self.now = now or datetime.now()
        # Analysed = has the audio features the engine can actually hear.
        self._featured = {s for s in songs if s in self.fi.pos and s in self.mood_pct}
        self._aff = {}
        for sid in songs:
            c = (self.plays.get(sid) or {}).get('c', 0)
            a = 0.55 * (1.0 if sid in self.liked else 0.0) \
                + 0.45 * min(1.0, math.log1p(c) / math.log1p(12))
            if a > 0:
                self._aff[sid] = min(1.0, a)
        self._taste = False   # lazy: (centroid, sims) | None
        self._top_genres = None

    @property
    def liked(self):
        return self._liked

    @liked.setter
    def liked(self, value):
        self._liked = set(value) & set(self.songs)
        self._blocked = None

    @property
    def disliked(self):
        return self._disliked

    @disliked.setter
    def disliked(self, value):
        self._disliked = set(value)
        self._blocked = None

    def aff(self, sid):
        return self._aff.get(sid, 0.0)

    def played(self, sid):
        return (self.plays.get(sid) or {}).get('c', 0) > 0

    def artist(self, sid):
        return (self.songs.get(sid) or {}).get('primary_artist', '')

    def featured(self, sid):
        """True when the engine has the audio features to judge this song."""
        return sid in self._featured

    def featured_ids(self):
        return self._featured

    def unanalysed_in(self, sids):
        return sum(1 for s in sids if not self.featured(s))

    def blocked(self, sid):
        """Rejected by the listener: disliked, or by a disliked artist.

        An artist is rejected once a song by them is disliked and nothing by
        them is liked, so a single like keeps the rest of that artist open.
        """
        if sid in self._disliked:
            return True
        return sid in self.songs and self.artist(sid) in self._blocked_artists()

    def _blocked_artists(self):
        if self._blocked is None:
            disliked = {self.artist(s) for s in self._disliked if s in self.songs}
            liked = {self.artist(s) for s in self._liked}
            self._blocked = {a for a in disliked - liked if _is_artist(a)}
        return self._blocked

    def mood_label(self, sid, mood_id):
        """0..1: how strongly crowd tags, or failing that the genre, name a mood."""
        terms = _MOOD_TERMS.get(mood_id, frozenset())
        best = 0.0
        for name, weight in self.tags.get(sid, ()):
            if _tag_terms(name) & terms:
                best = max(best, min(1.0, float(weight or 0) / 100.0))
        genre = _genre_of(self.songs.get(sid)).lower()
        if genre and genre in _MOOD_GENRES.get(mood_id, frozenset()):
            best = max(best, _GENRE_LABEL)
        return best

    @property
    def has_history(self):
        return len(self._aff) >= 5

    def taste(self):
        """(unit centroid, sims array) of the listener's taste, or None."""
        if self._taste is False:
            c = self.fi.centroid(self._aff) if self.fi else None
            self._taste = (c, self.fi.sims_to(c)) if c is not None else None
        return self._taste

    def top_genres(self):
        if self._top_genres is None:
            counts = {}
            for sid, a in self._aff.items():
                g = _genre_of(self.songs.get(sid))
                if g:
                    counts[g] = counts.get(g, 0.0) + a
            self._top_genres = set(sorted(counts, key=counts.get, reverse=True)[:4])
        return self._top_genres

    def taste_score(self, sid):
        """0..1 closeness to the listener's taste.

        Analysed songs get their audio closeness. Unanalysed songs get a flat
        genre prior instead: it is not on the audio scale, so inside a
        feature-driven mix it only competes for the unanalysed budget.
        """
        t = self.taste()
        if t is not None and self.featured(sid):
            return max(0.0, float(t[1][self.fi.pos[sid]]))
        g = _genre_of(self.songs.get(sid))
        return 0.4 if g and g in self.top_genres() else 0.1


# ------------------------------------------------------------------ helpers

def _primary_artist(artist):
    return re.split(r'[,;/&]', artist or '')[0].strip()


def _is_artist(name):
    """A real artist name; the 'Unknown Artist' placeholder never counts."""
    return bool(name) and name.lower() != 'unknown artist'


def _genre_of(row):
    g = (row or {}).get('genre') or ''
    g = re.split(r'[;/,]', g)[0].strip()
    return '' if g.lower() in ('', 'unknown', 'other') else g


def _dominant_genre(ctx, sids):
    counts = {}
    for s in sids:
        g = _genre_of(ctx.songs.get(s))
        if g:
            counts[g] = counts.get(g, 0) + 1
    return max(sorted(counts), key=counts.get) if counts else ''


def _tag_terms(name):
    """Match keys for a crowd tag: its whole name and each part of 'Genre---Style'."""
    norm = ' '.join((name or '').lower().split())
    return {norm} | {p.strip() for p in norm.split('---')}


class _Room:
    """What one mix still has room for.

    `counts` caps songs per artist; `unanalysed_left` is the budget of songs
    without audio features (None = no budget, for history-driven mixes). One
    `_Room` is shared by every pick that builds the same mix, so each cap holds
    for the whole mix. `core` collects the score-fixed songs in the order they
    were taken: the backbone that flow keeps stable across refreshes.
    """

    def __init__(self, ctx, unanalysed=_UNANALYSED_MAX):
        self.ctx = ctx
        self.counts = {}
        self.unanalysed_left = unanalysed
        self.core = []

    def fits(self, sid, artist_cap):
        art = self.ctx.artist(sid)
        if art and self.counts.get(art, 0) >= artist_cap:
            return False
        if self.unanalysed_left is None or self.ctx.featured(sid):
            return True
        return self.unanalysed_left > 0

    def take(self, sid, core=False):
        art = self.ctx.artist(sid)
        if art:
            self.counts[art] = self.counts.get(art, 0) + 1
        if self.unanalysed_left is not None and not self.ctx.featured(sid):
            self.unanalysed_left -= 1
        if core:
            self.core.append(sid)


def _pick(ctx, scores, limit, rng, room, artist_cap=_ARTIST_CAP, exclude=(),
          core=_CORE_SHARE):
    """Choose `limit` songs from {song_id: score}, in two parts.

    The core is the best-scoring songs taken in order, with no randomness: the
    same scores always give the same core, so a refresh cannot reshuffle what
    the listener is clearly served. The tail is a weighted draw over the next
    candidates; scores are z-normalised first, so the draw does not depend on
    the score scale, and a new seed moves only the tail. The result lists the
    core first, then the tail, each best-first.
    """
    exclude = set(exclude)
    ranked = sorted(((float(v), sid) for sid, v in scores.items()
                     if sid not in exclude and np.isfinite(v) and not ctx.blocked(sid)),
                    key=lambda x: (-x[0], x[1]))[:limit * 4]
    n_core = min(limit, int(round(limit * core)))
    picked, rest = [], []
    for v, sid in ranked:
        if len(picked) < n_core and room.fits(sid, artist_cap):
            room.take(sid, core=True)
            picked.append(sid)
        else:
            rest.append((v, sid))
    pool = [(v, sid) for v, sid in rest if room.fits(sid, artist_cap)]
    tail = []
    if pool and len(picked) < limit:
        vals = np.array([v for v, _ in pool])
        sd = float(vals.std())
        z = (vals - vals.mean()) / sd if sd > 1e-12 else np.zeros(len(vals))
        keys = z / _TAIL_TEMP + rng.gumbel(size=len(pool))
        for k in np.argsort(-keys, kind='stable'):
            if len(picked) + len(tail) >= limit:
                break
            sid = pool[k][1]
            if room.fits(sid, artist_cap):
                room.take(sid)
                tail.append(sid)
    best = {sid: v for v, sid in pool}
    tail.sort(key=lambda s: (-best[s], s))
    return picked + tail


def _enough(notes, kind, sids, what, minimum=_MIN_MIX):
    """True when a mix has its minimum size; otherwise record why it is left out."""
    if len(sids) >= minimum:
        return True
    notes.append((kind, f'{what}: {len(sids)} song(s) to choose from, need {minimum}'))
    return False


def _topped_up(ctx, rng, room, sids, fallback, artist_cap):
    """Top a short mix up to `_MIN_MIX` from `fallback` ({song_id: score}).

    The fallback is what the kind is still about once its own pool runs dry
    (replay falls back to everything the listener has played or liked). Fallback
    songs come in score order with no tail, so a top-up is deterministic too.
    """
    if len(sids) >= _MIN_MIX or not fallback:
        return sids
    return sids + _pick(ctx, fallback, _MIN_MIX - len(sids), rng, room,
                        artist_cap=artist_cap, exclude=sids, core=1.0)


def flow_order(ctx, sids, rng=None, anchor=None, core=None):
    """Order songs so neighbours sound alike, deterministically.

    `core` is the backbone chosen by score (see `_pick`). It is walked first,
    greedy nearest-neighbour with same-artist back-to-back penalised, and the
    other analysed songs are then inserted beside the song they sound most like.
    A refresh that only swaps the tail therefore keeps the backbone's order.
    Unanalysed songs have no sound to walk by, so they are spread evenly through
    the result rather than placed by a guess. `rng` is accepted for call-site
    compatibility and not used: the order is a function of the songs alone.
    """
    sids = list(dict.fromkeys(sids))
    feat = [s for s in sids if ctx.featured(s)]
    loose = [s for s in sids if not ctx.featured(s)]
    if core is None:
        base, extra = feat, []
    else:
        in_feat = set(feat)
        base = [s for s in dict.fromkeys(core) if s in in_feat]
        seen = set(base)
        extra = [s for s in feat if s not in seen]
    ordered = _walk(ctx, base, anchor)
    for s in extra:
        ordered = _insert(ctx, ordered, s)
    return _scatter(ordered, loose)


def _walk(ctx, sids, anchor=None):
    n = len(sids)
    if n <= 2 or not ctx.fi:
        return list(sids)
    fi = ctx.fi
    U = np.stack([fi.U[fi.pos[s]] for s in sids])
    S = U @ U.T
    artists = [ctx.artist(s) for s in sids]
    if anchor is not None and anchor in fi.pos:
        start = int(np.argmax(U @ fi.U[fi.pos[anchor]]))
    else:
        start = 0                       # the backbone's first song: the top-scored one
    order = [start]
    remaining = set(range(n)) - {start}
    while remaining:
        cur = order[-1]
        prev = order[-2] if len(order) > 1 else None
        best, best_v = None, -9.0
        for j in sorted(remaining):
            v = S[cur, j]
            if artists[j] and artists[j] == artists[cur]:
                v -= 0.35
            elif prev is not None and artists[j] and artists[j] == artists[prev]:
                v -= 0.12
            if v > best_v:
                best, best_v = j, v
        order.append(best)
        remaining.discard(best)
    return [sids[k] for k in order]


def _insert(ctx, ordered, sid):
    """Put `sid` right after the song in `ordered` it sounds most like."""
    if not ordered:
        return [sid]
    fi = ctx.fi
    v = fi.U[fi.pos[sid]]
    best_i, best_v = 0, -9.0
    for i, other in enumerate(ordered):
        score = float(fi.U[fi.pos[other]] @ v)
        if ctx.artist(other) and ctx.artist(other) == ctx.artist(sid):
            score -= 0.35
        if score > best_v:
            best_i, best_v = i, score
    out = list(ordered)
    out.insert(best_i + 1, sid)
    return out


def _scatter(ordered, loose):
    """Insert the unanalysed songs at evenly spaced places in `ordered`."""
    if not loose:
        return ordered
    n = len(ordered) + len(loose)
    slots = {int((k + 1) * n / (len(loose) + 1)): s for k, s in enumerate(loose)}
    it = iter(ordered)
    return [slots[i] if i in slots else next(it) for i in range(n)]


def _spherical_kmeans(U, w, k, rng, iters=12):
    n = len(U)
    w = np.asarray(w, dtype=np.float64)
    centers = [U[rng.choice(n, p=w / w.sum())]]
    for _ in range(1, k):
        d = np.clip(1.0 - np.max(U @ np.stack(centers).T, axis=1), 0, None) * w
        tot = d.sum()
        idx = rng.choice(n, p=d / tot) if tot > 1e-12 else int(rng.integers(n))
        centers.append(U[idx])
    C = np.stack(centers)
    for _ in range(iters):
        labels = np.argmax(U @ C.T, axis=1)
        for j in range(k):
            m = labels == j
            if m.any():
                c = (U[m] * w[m, None]).sum(axis=0)
                nrm = float(np.linalg.norm(c))
                if nrm > 1e-9:
                    C[j] = c / nrm
    return np.argmax(U @ C.T, axis=1), C


def _size_repair(U, labels, C):
    """Move songs so every taste group holds at least `_MY_MIN_MEMBERS`.

    A small group grows by taking, from the groups that can spare one, the song
    that sits closest to it relative to its own group. A group that no one can
    spare from is folded into its nearest neighbour, so every listened song still
    shapes a My Mix and nothing is dropped. Returns relabelled 0..m-1 labels.
    """
    labels = np.array(labels, dtype=int)
    alive = {int(j) for j in np.unique(labels)}
    while len(alive) > 1:
        sizes = {j: int(np.sum(labels == j)) for j in alive}
        small = min(alive, key=lambda j: (sizes[j], j))
        if sizes[small] >= _MY_MIN_MEMBERS:
            break
        donors = [i for i in np.where(labels != small)[0]
                  if sizes[labels[i]] > _MY_MIN_MEMBERS]
        if donors:
            gain = [float(U[i] @ C[small] - U[i] @ C[labels[i]]) for i in donors]
            labels[donors[int(np.argmax(gain))]] = small
            continue
        nearest = max((j for j in alive if j != small),
                      key=lambda j: (float(C[j] @ C[small]), -j))
        labels[labels == small] = nearest
        alive.discard(small)
    remap = {j: i for i, j in enumerate(sorted(alive))}
    return np.array([remap[int(j)] for j in labels], dtype=int)


def _taste_groups(U, w, k):
    """Split the listener's analysed taste into up to `k` groups of songs.

    Best of `_CLUSTER_RESTARTS` fixed-seed spherical k-means runs, then the size
    repair above. Returns index arrays, the largest taste mass first.
    """
    best = None
    for r in range(_CLUSTER_RESTARTS):
        labels, C = _spherical_kmeans(U, w, k, np.random.default_rng(_CLUSTER_SEED + r))
        score = float(np.sum(w * np.sum(U * C[labels], axis=1)))
        if best is None or score > best[0]:
            best = (score, labels, C)
    labels = _size_repair(U, best[1], best[2])
    groups = [np.where(labels == j)[0] for j in range(int(labels.max()) + 1)]
    groups.sort(key=lambda g: -float(w[g].sum()))
    return groups


def _my_group_count(n):
    """How many taste groups to ask for, given n analysed listened songs.

    Follows the profile's size (about one group per 8 songs, 2 to 5), and holds
    at least `_MY_MIX_FLOOR` groups once there are enough songs for that many
    groups of `_MY_MIN_MEMBERS`.
    """
    k = min(_MY_MIX_MAX, max(2, round(math.sqrt(n / 8))))
    if n >= _MY_MIX_FLOOR * _MY_MIN_MEMBERS:
        k = max(k, _MY_MIX_FLOOR)
    return int(k)


def _artist_line(ctx, sids, lead=None):
    """'A, B, C and more' from the most frequent artists in a mix."""
    counts = {}
    for s in sids:
        a = ctx.artist(s)
        if a and a.lower() != 'unknown artist':
            counts[a] = counts.get(a, 0) + 1
    names = sorted(counts, key=lambda a: -counts[a])
    if lead:
        names = [lead] + [a for a in names if a != lead]
    if not names:
        return ''
    head = ', '.join(names[:3])
    return head + (' and more' if len(names) > 3 else '')


def _mix(ctx, mid, kind, shelf, title, sids, subtitle=None, tag=None, external=None):
    return {
        'id': mid, 'kind': kind, 'shelf': shelf, 'title': title,
        'subtitle': subtitle if subtitle is not None else _artist_line(ctx, sids),
        'tag': tag, 'song_ids': list(sids),
        # Songs the listener does not own yet, from YouTube Music's radio. Kept
        # apart from song_ids so every local-only code path (extend, scoring,
        # tests) keeps working unchanged; serialize() interleaves them.
        'external_tracks': list(external or []),
    }


# ------------------------------------------------------------------- moods

def _m_energize(p):
    return 0.5 * p['energy'] + 0.3 * p['tempo'] + 0.2 * p['loud']


def _m_chill(p):
    return 1 - (0.55 * p['energy'] + 0.30 * p['tempo'] + 0.15 * p['loud'])


def _m_focus(p):
    return 0.5 * (1 - p['dance']) + 0.5 * (1 - min(1.0, abs(p['energy'] - 0.35) * 2))


def _m_workout(p):
    closeness = max(0.0, 1 - abs((p['bpm'] or 0) - 145) / 60.0)
    return 0.45 * closeness + 0.40 * p['energy'] + 0.15 * p['loud']


def _m_party(p):
    return 0.6 * p['dance'] + 0.4 * p['energy']


def _m_sleep(p):
    return 0.6 * (1 - p['energy']) + 0.25 * (1 - p['tempo']) + 0.15 * (1 - p['loud'])


# id, title, subtitle, scorer
MOODS = [
    ('energize', 'Energize', 'Upbeat and high energy', _m_energize),
    ('chill', 'Chill', 'Slow and relaxed', _m_chill),
    ('focus', 'Focus', 'Steady, low distraction', _m_focus),
    ('workout', 'Workout', 'Fast tempo, high energy', _m_workout),
    ('party', 'Party', 'Danceable and loud', _m_party),
    ('sleep', 'Wind Down', 'Slow and quiet', _m_sleep),
]
_MOOD_BY_ID = {m[0]: m for m in MOODS}

# The label half of the mood fusion: which crowd tags (Last.fm, MusicBrainz,
# Discogs styles) and which top-level genres speak for each mood.
_MOOD_TERMS = {
    'energize': frozenset({
        'energetic', 'energy', 'high energy', 'upbeat', 'uplifting', 'happy',
        'feel good', 'feel-good', 'fun', 'exciting', 'driving', 'hype'}),
    'chill': frozenset({
        'chill', 'chillout', 'chill out', 'chill-out', 'chillwave', 'relaxing',
        'relax', 'mellow', 'calm', 'laid back', 'laid-back', 'downtempo',
        'lounge', 'easy listening', 'soft', 'smooth', 'lo-fi', 'lofi'}),
    'focus': frozenset({
        'study', 'focus', 'concentration', 'instrumental', 'minimal', 'ambient',
        'post-rock', 'drone', 'background', 'idm'}),
    'workout': frozenset({
        'workout', 'gym', 'running', 'exercise', 'training', 'intense',
        'aggressive', 'hardcore', 'hardstyle', 'drum and bass', 'dnb', 'metal',
        'hard rock'}),
    'party': frozenset({
        'party', 'dance', 'club', 'dancefloor', 'danceable', 'disco', 'house',
        'dance-pop', 'electronic', 'edm', 'club dance', 'dancehall', 'reggaeton'}),
    'sleep': frozenset({
        'sleep', 'sleepy', 'lullaby', 'bedtime', 'night', 'soothing', 'peaceful',
        'slow', 'quiet', 'calm', 'drone', 'new age', 'classical'}),
}
_MOOD_GENRES = {
    'energize': frozenset({'rock', 'punk', 'pop'}),
    'chill': frozenset({'folk', 'jazz', 'blues', 'soul'}),
    'focus': frozenset({'classical', 'stage & screen'}),
    'workout': frozenset({'metal', 'hip hop'}),
    'party': frozenset({'electronic', 'latin'}),
    'sleep': frozenset({'classical', 'new age'}),
}


def build_mood_percentiles(rows):
    """{song_id: {'energy','dance','tempo','loud','bpm'}} from song_features rows."""
    rows = [r for r in rows
            if r.get('energy') is not None and r.get('tempo_bpm') is not None
            and r.get('danceability') is not None]
    if len(rows) < 2:
        return {}
    def col(name, default=0.0):
        return np.array([float(r.get(name) if r.get(name) is not None else default)
                         for r in rows])
    pe, pd = _percentiles(col('energy')), _percentiles(col('danceability'))
    pt = _percentiles(col('tempo_bpm'))
    loud = np.array([r.get('loudness_db') for r in rows], dtype=object)
    lvals = np.array([float(x) if x is not None else np.nan for x in loud])
    median = np.nanmedian(lvals) if np.isfinite(lvals).any() else 0.0
    pl = _percentiles(np.where(np.isnan(lvals), median, lvals))
    out = {}
    for i, r in enumerate(rows):
        out[r['song_id']] = {'energy': float(pe[i]), 'dance': float(pd[i]),
                             'tempo': float(pt[i]), 'loud': float(pl[i]),
                             'bpm': float(r['tempo_bpm'])}
    return out


def _percentiles(values):
    """Rank-percentile (0..1) for an array, robust to scale differences."""
    order = np.argsort(np.argsort(values))
    return order / max(len(values) - 1, 1)


def _mood_pool(ctx):
    """Analysed songs the listener has not rejected: where moods are judged."""
    return [s for s in ctx.mood_pct if ctx.featured(s) and not ctx.blocked(s)]


def _mood_gate(ctx, mood_id):
    """{song_id: audio fit} for the songs inside a mood's coherence bar.

    The bar is the top third of the listener's own analysed library on that
    mood's audio scorer. Tags and listening only reorder inside it, so audio
    decides which songs can be in a mood at all: a Chill mix cannot hold a
    hard-dance track whatever its labels say.
    """
    fn = _MOOD_BY_ID[mood_id][3]
    fit = {s: fn(ctx.mood_pct[s]) for s in _mood_pool(ctx)}
    if not fit:
        return {}
    cut = float(np.percentile(list(fit.values()), _MOOD_CUT_PCT))
    return {s: v for s, v in fit.items() if v >= cut}


def _mood_score(ctx, sid, mood_id, audio):
    """Fuse audio fit with the listener's signal and the crowd's labels."""
    return (_W_AUDIO * audio + _W_LABEL * ctx.mood_label(sid, mood_id)
            + _W_AFF * ctx.aff(sid) + _W_TASTE * ctx.taste_score(sid))


# ---------------------------------------------------------------- builders
# Each builder returns its mix, or a list of them, or None; when it leaves a
# kind out it appends (kind, reason) to `notes` first.

def _supermix(ctx, rng, limit, notes):
    room = _Room(ctx)                               # feature-driven: unanalysed budget
    songs = [s for s in ctx.songs if not ctx.blocked(s)]
    if not ctx.has_history:
        sids = _pick(ctx, {s: rng.uniform(0, 1) for s in songs}, limit, rng, room, artist_cap=2)
        subtitle = 'A bit of everything in your library'
    else:
        familiar = {s: 0.6 * ctx.aff(s) + 0.4 * ctx.taste_score(s)
                    for s in songs if ctx.aff(s) > 0}
        fresh = {s: ctx.taste_score(s) for s in songs if ctx.aff(s) == 0}
        n_fresh = min(limit // 3, len(fresh))
        fam = _pick(ctx, familiar, limit - n_fresh, rng, room, artist_cap=2)
        new = _pick(ctx, fresh, limit - len(fam), rng, room, artist_cap=2)
        sids = fam + new
        subtitle = None
    if not _enough(notes, 'supermix', sids, 'supermix'):
        return None
    return _mix(ctx, 'supermix', 'supermix', 'made', 'Supermix',
                flow_order(ctx, sids, rng, core=room.core), subtitle=subtitle)


def _my_mixes(ctx, rng, limit, notes):
    """Cluster the listener's analysed taste into distinct 'My Mix' playlists.

    Floor: `_MY_MIX_FLOOR` mixes whenever the taste holds that many groups of
    `_MY_MIN_MEMBERS` songs; ceiling `_MY_MIX_MAX`. A group whose songs are
    (mostly) those of an earlier mix is merged into it, not shown twice.
    """
    fi = ctx.fi
    pts = [s for s in ctx._aff if ctx.featured(s) and not ctx.blocked(s)]
    if len(pts) < _MY_MIN_PROFILE:
        notes.append(('my', f'{len(pts)} analysed listened song(s), need {_MY_MIN_PROFILE}'))
        return []
    U = fi.U[[fi.pos[s] for s in pts]]
    w = np.array([ctx.aff(s) for s in pts])
    candidates = sorted(s for s in ctx.featured_ids() if not ctx.blocked(s))
    out, kept, used_tags = [], [], set()
    for members in _taste_groups(U, w, _my_group_count(len(pts))):
        centre = (U[members] * w[members][:, None]).sum(axis=0)
        norm = float(np.linalg.norm(centre))
        if norm < 1e-9:
            continue
        sims = fi.U @ (centre / norm)
        scores = {sid: float(sims[fi.pos[sid]]) + 0.25 * ctx.aff(sid) for sid in candidates}
        room = _Room(ctx)
        sids = _pick(ctx, scores, limit, rng, room, artist_cap=_ARTIST_CAP)
        if len(sids) < _MIN_MIX:
            notes.append(('my', f'a taste group could fill {len(sids)} song(s), need {_MIN_MIX}'))
            continue
        chosen = set(sids)
        if any(len(chosen & other) > _MY_MAX_OVERLAP * min(len(chosen), len(other))
               for other in kept):
            continue
        kept.append(chosen)
        genres = {}
        for i in members:
            g = _genre_of(ctx.songs.get(pts[i]))
            if g:
                genres[g] = genres.get(g, 0) + float(w[i])
        tag = None
        for g in sorted(genres, key=genres.get, reverse=True):
            if g not in used_tags:
                tag = g
                used_tags.add(g)
                break
        n_out = len(out) + 1
        out.append(_mix(ctx, f'my-{n_out}', 'my', 'made', f'My Mix {n_out}',
                        flow_order(ctx, sids, rng, core=room.core), tag=tag))
    if len(out) < _MY_MIX_FLOOR and len(pts) >= _MY_MIX_FLOOR * _MY_MIN_MEMBERS:
        notes.append(('my', f'the taste holds {len(out)} distinct group(s); '
                            f'the floor is {_MY_MIX_FLOOR}'))
    return out


def _discover(ctx, rng, limit, notes):
    if not ctx.has_history:
        notes.append(('discover', 'no listening history yet'))
        return None
    room = _Room(ctx)                               # feature-driven: unanalysed budget
    played_artists = {ctx.artist(s) for s in ctx._aff}
    scores = {}
    for sid in ctx.songs:
        if ctx.played(sid) or sid in ctx.liked or ctx.blocked(sid):
            continue
        s = ctx.taste_score(sid)
        if _genre_of(ctx.songs[sid]) in ctx.top_genres():
            s += 0.08
        if ctx.artist(sid) not in played_artists:
            s += 0.06           # reward genuinely new artists
        scores[sid] = s
    sids = _pick(ctx, scores, limit, rng, room, artist_cap=2)
    if not _enough(notes, 'discover', sids, 'discover'):
        return None
    return _mix(ctx, 'discover', 'discover', 'fresh', 'Discover Mix',
                flow_order(ctx, sids, rng, core=room.core), tag='Not played yet')


def _replay(ctx, rng, limit, notes):
    """Songs played in the last 60 days, most played first.

    Top-up (below _MIN_MIX): other songs the listener has played or liked,
    ranked by affinity, so thin recent history still gives a full mix.
    """
    room = _Room(ctx, unanalysed=None)              # history-driven
    recent = {sid: p['c60'] + 0.3 * p['c'] for sid, p in ctx.plays.items()
              if sid in ctx.songs and p.get('c60', 0) > 0 and not ctx.blocked(sid)}
    older = {sid: ctx.aff(sid) for sid in ctx._aff
             if sid in ctx.songs and sid not in recent and not ctx.blocked(sid)}
    sids = _pick(ctx, recent, limit, rng, room, artist_cap=4)
    sids = _topped_up(ctx, rng, room, sids, older, artist_cap=4)
    if not _enough(notes, 'replay', sids, 'replay'):
        return None
    rank = {**older, **recent}
    sids.sort(key=lambda s: -rank[s])               # most played first, as before
    return _mix(ctx, 'replay', 'replay', 'fresh', 'Replay Mix', sids, tag='Last 60 days')


def _right_now(ctx, rng, limit, notes):
    """Songs played around this hour of the day.

    Top-up (below _MIN_MIX): the listener's other played or liked songs, by affinity.
    """
    room = _Room(ctx, unanalysed=None)              # history-driven
    hour = {sid: c for sid, c in ctx.hour_plays.items()
            if sid in ctx.songs and not ctx.blocked(sid)}
    scores = {sid: c + 0.5 * ctx.taste_score(sid) + 0.5 * ctx.aff(sid)
              for sid, c in hour.items()}
    sids = _pick(ctx, scores, limit, rng, room, artist_cap=3)
    older = {sid: ctx.aff(sid) for sid in ctx._aff
             if sid in ctx.songs and sid not in scores and not ctx.blocked(sid)}
    sids = _topped_up(ctx, rng, room, sids, older, artist_cap=3)
    if not _enough(notes, 'now', sids, 'right now'):
        return None
    h = ctx.hour
    part = ('Morning' if 5 <= h < 11 else 'Afternoon' if 11 <= h < 17
            else 'Evening' if 17 <= h < 22 else 'Late Night')
    return _mix(ctx, 'now', 'now', 'fresh', f'{part} Mix',
                flow_order(ctx, sids, rng, core=room.core),
                subtitle=_artist_line(ctx, sids), tag='Right now')


def _rediscover(ctx, rng, limit, notes):
    """Liked or often-played songs not heard in 60 days.

    Top-up (below _MIN_MIX): the songs the listener has played, longest unheard first.
    """
    room = _Room(ctx, unanalysed=None)              # history-driven
    cutoff = ctx.now - timedelta(days=60)
    unheard, older = {}, {}
    for sid in ctx.songs:
        a = ctx.aff(sid)
        if a <= 0 or ctx.blocked(sid):
            continue
        last = (ctx.plays.get(sid) or {}).get('last')
        days = 365 if last is None else (ctx.now - last).days
        if a >= 0.25 and (last is None or last < cutoff):   # ~4+ plays, or liked
            unheard[sid] = a + min(days, 720) / 720.0 * 0.5
        else:
            older[sid] = min(days, 720) / 720.0 + 0.1 * a   # longest unheard first
    sids = _pick(ctx, unheard, limit, rng, room, artist_cap=3)
    sids = _topped_up(ctx, rng, room, sids, older, artist_cap=3)
    if not _enough(notes, 'rediscover', sids, 'rediscover'):
        return None
    return _mix(ctx, 'rediscover', 'rediscover', 'fresh', 'Rediscover Mix',
                flow_order(ctx, sids, rng, core=room.core),
                tag="Haven't heard in a while")


def _new_arrivals(ctx, rng, limit, notes):
    """Songs scanned into the library in the last 30 days, newest first.

    Top-up (below _MIN_MIX): the most recently scanned songs of any age.
    """
    room = _Room(ctx, unanalysed=None)              # history-driven (library, not sound)
    dated = sorted(((r['scanned_at'], sid) for sid, r in ctx.songs.items()
                    if r.get('scanned_at') and not ctx.blocked(sid)), reverse=True)
    cutoff = ctx.now - timedelta(days=30)
    recent = [sid for ts, sid in dated if ts >= cutoff]
    scores = {sid: (len(recent) - i) / len(recent) + 0.3 * ctx.taste_score(sid)
              for i, sid in enumerate(recent)}
    newest = {sid: (len(dated) - i) / len(dated) for i, (_, sid) in enumerate(dated)}
    sids = _pick(ctx, scores, limit, rng, room, artist_cap=4)
    sids = _topped_up(ctx, rng, room, sids, newest, artist_cap=4)
    if not _enough(notes, 'new', sids, 'new arrivals'):
        return None
    return _mix(ctx, 'new', 'new', 'fresh', 'New Arrivals',
                flow_order(ctx, sids, rng, core=room.core), tag='Added this month')


def _liked(ctx, rng, limit, notes):
    """Every liked song the artist cap allows. No size limit: the likes are the mix."""
    liked = [s for s in ctx.liked if not ctx.blocked(s)]
    if not liked:
        notes.append(('liked', 'no liked songs yet'))
        return None
    room = _Room(ctx, unanalysed=None)              # history-driven
    scores = {s: ctx.aff(s) + 0.2 * ctx.taste_score(s) for s in liked}
    # Every liked song the artist cap allows: the likes are the mix, so the
    # limit is the number of likes, not MIX_SIZE.
    sids = _pick(ctx, scores, len(liked), rng, room, artist_cap=4)
    if not _enough(notes, 'liked', sids, 'liked', minimum=1):
        return None
    return _mix(ctx, 'liked', 'liked', 'fresh', 'Liked Mix',
                flow_order(ctx, sids, rng, core=room.core), tag=f'{len(ctx.liked)} liked')


def _artist_mixes(ctx, rng, limit, notes, how_many=3):
    """'<Artist> Mix' for the artists the listener has done the most with.

    Artists are ranked by affinity (plays and likes together), so thin play
    history still leaves the liked artists. The artist's own songs are history
    (no audio bar). Everything else is ranked in tiers: related artists, then
    audio-similar songs, then the artist's genre, then the rest of what the
    listener plays, so an artist with no analysed songs still gets a full mix.
    """
    totals = {}
    for sid in ctx._aff:
        art = ctx.artist(sid)
        if sid in ctx.songs and _is_artist(art) and not ctx.blocked(sid):
            totals[art] = totals.get(art, 0.0) + ctx.aff(sid)
    if not totals:
        notes.append(('artist', 'no listened artist yet'))
        return []
    out = []
    for art in sorted(totals, key=lambda a: (-totals[a], a)):
        if len(out) >= how_many:
            break
        own = [s for s in ctx.songs if ctx.artist(s) == art and not ctx.blocked(s)]
        if len(own) < 2:
            continue
        center = ctx.fi.centroid({s: 1 + ctx.aff(s) for s in own}) if ctx.fi else None
        sims = ctx.fi.sims_to(center) if center is not None else None
        try:
            rel = {r['related_artist'].lower(): float(r.get('similarity') or 0)
                   for r in (ctx.related(art) or [])}
        except Exception:  # noqa: BLE001
            rel = {}
        genre = _dominant_genre(ctx, own)
        room = _Room(ctx, unanalysed=None)          # history-driven
        pick_own = _pick(ctx, {s: 1.0 + 0.3 * ctx.aff(s) for s in own},
                         min(10, limit // 3), rng, room, artist_cap=_OWN_ARTIST_CAP)
        others = {}
        for sid in ctx.songs:
            if ctx.artist(sid) == art or ctx.blocked(sid):
                continue
            tiers = []
            r = rel.get(ctx.artist(sid).lower())
            if r is not None:
                tiers.append(2.0 + r)
            if sims is not None and ctx.featured(sid):
                sim = float(sims[ctx.fi.pos[sid]])
                if sim > 0.3:
                    tiers.append(1.0 + sim)
            if genre and _genre_of(ctx.songs[sid]) == genre:
                tiers.append(0.5 + 0.25 * ctx.aff(sid))
            if ctx.aff(sid) > 0:
                tiers.append(0.25 + 0.5 * ctx.aff(sid))
            if tiers:
                others[sid] = max(tiers)
        pick_other = _pick(ctx, others, limit - len(pick_own), rng, room,
                           artist_cap=2, exclude=pick_own)
        sids = pick_own + pick_other
        if len(sids) < _MIN_MIX:
            notes.append(('artist', f'{art}: {len(sids)} song(s) to choose from, '
                                    f'need {_MIN_MIX}'))
            continue
        flow = flow_order(ctx, sids, rng, anchor=pick_own[0] if pick_own else None,
                          core=room.core)
        slug = re.sub(r'[^a-z0-9]+', '-', art.lower()).strip('-')
        out.append(_mix(ctx, 'artist-' + slug, 'artist', 'artists', f'{art} Mix', flow,
                        subtitle=_artist_line(ctx, flow, lead=art), tag='Because you listen'))
    if not out:
        notes.append(('artist', 'no listened artist could fill a mix'))
    return out


def _mood_mixes(ctx, rng, limit, notes):
    # Moods are judged on audio, so they need a real sample of analysed songs;
    # below _MIN_FEATURED the shelf is left out with a reason, not guessed at.
    pool = _mood_pool(ctx)
    if len(pool) < _MIN_FEATURED:
        notes.append(('mood', f'{len(pool)} analysed song(s), need {_MIN_FEATURED}'))
        return []
    out = []
    for mid, title, sub, _fn in MOODS:
        gate = _mood_gate(ctx, mid)
        scores = {s: _mood_score(ctx, s, mid, audio) for s, audio in gate.items()}
        room = _Room(ctx)                           # feature-driven: no unanalysed songs
        sids = _pick(ctx, scores, limit, rng, room, artist_cap=2)
        if not _enough(notes, 'mood', sids, f'mood {mid}'):
            continue
        out.append(_mix(ctx, 'mood-' + mid, 'mood', 'moods', title,
                        flow_order(ctx, sids, rng, core=room.core), subtitle=sub))
    return out


def build_mixes(ctx, seed=None, limit=MIX_SIZE, notes=None, external=None):
    """The full shelf of mixes for one listener (list of descriptors).

    A kind that cannot reach `_MIN_MIX` songs is left out, and why is appended
    to `notes` as (kind, reason) and logged, so an empty slot is never silent.

    `external` is an optional provider of songs the listener does NOT own:
    `external(mood_id=None, want=N, exclude_videos=()) -> [track dicts]`.
    When given, the shelf blends YouTube Music candidates into the mixes where
    they make sense and gains an all-external radio mix. When it returns nothing
    (YouTube down, budget spent, no seed) the shelf is exactly the local one.
    """
    notes = [] if notes is None else notes
    if not ctx.songs:
        notes.append(('shelf', 'the library has no songs yet'))
        return []
    rng = np.random.default_rng(seed)
    shelf = [_supermix(ctx, rng, limit, notes)]
    shelf += _my_mixes(ctx, rng, limit, notes)
    for builder in (_discover, _replay, _right_now, _rediscover, _new_arrivals, _liked):
        shelf.append(builder(ctx, rng, limit, notes))
    shelf += _artist_mixes(ctx, rng, limit, notes)
    shelf += _mood_mixes(ctx, rng, limit, notes)
    shelf = [m for m in shelf if m]
    if external is not None:
        shelf = _with_youtube(ctx, shelf, limit, notes, external)
    for kind, reason in notes:
        print(f"[mixes] {kind} left out: {reason}")
    return shelf


# ------------------------------------------------- YouTube blend (R1)

_YT_PER_MIX = 5          # external tracks blended into one local mix
_YT_SLOT_EVERY = 6       # one external slot every N positions, so the mix flows
_YT_MIX_KINDS = ('supermix', 'discover')   # local kinds that gain external tracks


def _with_youtube(ctx, shelf, limit, notes, external):
    """Blend external candidates into the shelf, and add the all-external mix.

    One video is offered at most once across the whole shelf: the same "new"
    song in six mixes reads as a bug, not as a recommendation.
    """
    used = set()

    def take(mood_id=None, want=_YT_PER_MIX):
        try:
            tracks = external(mood_id=mood_id, want=want, exclude_videos=tuple(used)) or []
        except Exception as e:  # noqa: BLE001
            print(f"[mixes] youtube provider failed: {e}")
            return []
        fresh = [t for t in tracks if t.get('videoId') and t['videoId'] not in used]
        used.update(t['videoId'] for t in fresh)
        return fresh

    for m in shelf:
        if m['kind'] in _YT_MIX_KINDS:
            m['external_tracks'] = take()
        elif m['kind'] == 'mood':
            # Seed from songs that fit this mood, so YouTube's radio inherits it.
            m['external_tracks'] = take(mood_id=m['id'][5:])

    # `discover` is the kind that most needs new music; if the local unplayed
    # pool was too thin to stand alone, YouTube fills it instead of dropping it.
    if not any(m['kind'] == 'discover' for m in shelf):
        tracks = take(want=max(_YT_PER_MIX, limit - _MIN_MIX))
        if tracks:
            local = _unplayed_candidates(ctx, limit - len(tracks))
            shelf.append(_mix(ctx, 'discover', 'discover', 'fresh', 'Discover Mix',
                              local, tag='Not played yet', external=tracks))
            notes.append(('discover', 'local unplayed pool thin; filled from YouTube'))

    radio = take(want=_YT_RADIO_SIZE)
    if radio:
        shelf.append(_mix(ctx, 'youtube-radio', 'youtube', 'artists',
                          'YouTube Radio Mix', [],
                          subtitle='Songs you do not have yet',
                          tag='Not in your library', external=radio))
    return shelf


_YT_RADIO_SIZE = 20      # size of the all-external YouTube Radio Mix


def _unplayed_candidates(ctx, want):
    """A few unplayed library songs, best taste fit first (discover top-up)."""
    if want <= 0:
        return []
    scores = {s: ctx.taste_score(s) for s in ctx.songs
              if not ctx.played(s) and s not in ctx.liked and not ctx.blocked(s)}
    ranked = sorted(scores, key=lambda s: (-scores[s], s))
    return ranked[:want]


def extend(ctx, mix_id, recent_ids, limit=15, seed=None):
    """More songs for an endlessly-playing mix.

    Steers by what is playing *now* (the last few queued songs) so the
    session drifts naturally, while staying anchored to the mix's character
    (mood coherence bar, 'discover' = unplayed only) and the listener's taste.
    """
    rng = np.random.default_rng(seed)
    exclude = set(recent_ids)
    tail = [s for s in recent_ids if s in ctx.songs][-5:]
    c_tail = ctx.fi.centroid({s: 1.0 + i * 0.3 for i, s in enumerate(tail)}) if ctx.fi else None
    sims_tail = ctx.fi.sims_to(c_tail) if c_tail is not None else None
    mood = _MOOD_BY_ID.get(mix_id[5:]) if mix_id.startswith('mood-') else None

    # A mood mix keeps its character: only songs inside the mood's coherence
    # bar are eligible, and sound-alike steering happens inside that.
    eligible = _mood_gate(ctx, mood[0]) if mood is not None else None

    scores = {}
    for sid in ctx.songs:
        if sid in exclude or ctx.blocked(sid):
            continue
        if eligible is not None and sid not in eligible:
            continue
        if mix_id == 'discover' and (ctx.played(sid) or sid in ctx.liked):
            continue
        i = ctx.fi.pos.get(sid) if ctx.featured(sid) else None
        s = 0.2 * ctx.taste_score(sid) + 0.15 * ctx.aff(sid)
        if sims_tail is not None and i is not None:
            s += 0.6 * max(0.0, float(sims_tail[i]))
        scores[sid] = s
    room = _Room(ctx)
    sids = _pick(ctx, scores, limit, rng, room, artist_cap=2)
    return flow_order(ctx, sids, rng, anchor=tail[-1] if tail else None, core=room.core)


# --------------------------------------------------------- data (MySQL side)

def load_context(user_id):
    """Gather the listener's data. The only DB-touching function here."""
    from models.library_access import LibraryAccessModel
    from models.song_rating import SongRatingModel
    from utils import recommender

    rows = Database.execute_query(
        "SELECT id, file_path, title, artist, album, duration, track_number, "
        "year, genre, cover_path, scanned_at, youtube_id FROM songs", fetch_all=True) or []
    visible = LibraryAccessModel.visible_song_ids(user_id)
    songs = {}
    for r in rows:
        if r['id'] in visible:
            r['primary_artist'] = _primary_artist(r.get('artist'))
            songs[r['id']] = r

    liked = SongRatingModel.get_liked_song_ids(user_id)
    disliked = SongRatingModel.get_disliked_song_ids(user_id)

    plays = {}
    for r in Database.execute_query(
            "SELECT song_id, COUNT(*) AS c, MAX(played_at) AS last_at, "
            "SUM(played_at >= DATE_SUB(NOW(), INTERVAL 60 DAY)) AS c60 "
            "FROM play_history WHERE user_id = %s AND counted = 1 "
            "GROUP BY song_id", (user_id,), fetch_all=True) or []:
        plays[r['song_id']] = {'c': int(r['c']), 'last': r['last_at'],
                               'c60': int(r['c60'] or 0)}

    hour_row = Database.execute_query("SELECT HOUR(NOW()) AS h", fetch_one=True) or {}
    hour_plays = {}
    for r in Database.execute_query(
            "SELECT song_id, COUNT(*) AS c FROM play_history "
            "WHERE user_id = %s AND counted = 1 AND "
            "MOD(HOUR(played_at) - HOUR(NOW()) + 24, 24) IN (22, 23, 0, 1, 2) "
            "GROUP BY song_id", (user_id,), fetch_all=True) or []:
        hour_plays[r['song_id']] = int(r['c'])

    try:
        fi = FeatureIndex.build(recommender._load_features(), set(songs))
    except Exception as e:  # noqa: BLE001
        print(f"[mixes] feature load failed: {e}")
        fi = FeatureIndex()

    # Percentiles are ranked within this listener's visible library: "high
    # energy" should mean high for their collection, not across the server.
    try:
        feat_rows = [r for r in (Database.execute_query(
            "SELECT song_id, tempo_bpm, danceability, energy, loudness_db "
            "FROM song_features", fetch_all=True) or []) if r['song_id'] in songs]
        mood_pct = build_mood_percentiles(feat_rows)
    except Exception as e:  # noqa: BLE001
        print(f"[mixes] mood features failed: {e}")
        mood_pct = {}

    # Crowd tags (Last.fm moods and genres, Discogs styles) feed the mood fusion.
    tags = {}
    try:
        ids = list(songs)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            marks = ', '.join(['%s'] * len(chunk))
            for r in (Database.execute_query(
                    f"SELECT song_id, tag_name, weight FROM song_tags "
                    f"WHERE song_id IN ({marks})", tuple(chunk), fetch_all=True) or []):
                tags.setdefault(r['song_id'], []).append((r['tag_name'], r.get('weight') or 0))
    except Exception as e:  # noqa: BLE001
        print(f"[mixes] tags failed: {e}")
        tags = {}

    def related(artist):
        return Database.execute_query(
            "SELECT related_artist, similarity FROM artist_relations "
            "WHERE artist_name = %s ORDER BY similarity DESC LIMIT 25",
            (artist,), fetch_all=True) or []

    return Ctx(songs, liked, disliked, plays, hour_plays,
               int(hour_row.get('h', 12)), fi, mood_pct, related, tags=tags)


def song_payload(row):
    return {
        'id': row['id'], 'path': row['file_path'], 'title': row['title'],
        'artist': row['artist'], 'album': row['album'],
        'duration': row['duration'], 'track': row['track_number'],
        'year': row['year'], 'genre': row['genre'],
        'cover_path': row['cover_path'],
    }


def serialize(ctx, mixes):
    """Descriptors -> JSON-ready mixes with full song dicts + cover mosaic.

    `unanalysed` counts the songs the engine has no audio features for, so a
    client can see why a mix is not sound-matched. External (not-in-library)
    tracks are interleaved into `songs` with `videoId` + `in_library: False`,
    which is the shape the player and the song context menu already understand
    from Radio: they stream through the preview proxy and can be kept with the
    existing "save to library" action.
    """
    out = []
    for m in mixes:
        ids = [s for s in m['song_ids'] if s in ctx.songs]
        songs = [song_payload(ctx.songs[s]) for s in ids]
        external = [t for t in (m.get('external_tracks') or []) if t.get('videoId')]
        if not songs and not external:
            continue
        songs = _interleave(songs, external)
        covers, seen = [], set()
        for s in songs:
            cp = s.get('cover_path') or s.get('cover_url')
            if cp and cp not in seen:
                seen.add(cp)
                covers.append(cp)
            if len(covers) == 4:
                break
        out.append({
            'id': m['id'], 'kind': m['kind'], 'shelf': m['shelf'],
            'title': m['title'], 'subtitle': m['subtitle'], 'tag': m['tag'],
            'count': len(songs),
            'duration': sum(int(s.get('duration') or 0) for s in songs),
            'unanalysed': ctx.unanalysed_in(ids),
            'external_count': len(external),
            'covers': covers, 'songs': songs,
        })
    return out


def _interleave(songs, external, every=_YT_SLOT_EVERY):
    """Local songs keep their flow order; external tracks land in spread slots.

    An all-external mix (no local songs) is just the external list.
    """
    if not external:
        return songs
    if not songs:
        return list(external)
    out, ei = [], 0
    for i, s in enumerate(songs):
        out.append(s)
        if (i + 1) % every == 0 and ei < len(external):
            out.append(external[ei])
            ei += 1
    out.extend(external[ei:])
    return out
