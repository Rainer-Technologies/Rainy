"""Personalised mixes, YouTube-Music style.

Turns the listening data Rainy already has (play history, likes, audio
features, genres, artist relations, scan dates) into a shelf of ready-made
mixes:

  Made for you   Supermix, My Mix 1..N (k-means over your taste)
  Fresh & known  Discover, Replay, Right Now, Rediscover, New Arrivals, Liked
  Because you    "<Artist> Mix" for your top artists (+ related artists)
  Moods          Energize, Chill, Focus, Workout, Party, Sleep

Every mix is *sequenced*: after picking songs (weighted-random, so refreshes
differ, with a per-artist cap for variety) we order them with a greedy
nearest-neighbour walk over the audio-feature space so neighbouring tracks
sound alike - a mix flows instead of jumping between genres.

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
_MIN_FEATURED = 25       # analysed songs needed before audio-based mixes appear
_TEMP = 0.12             # sampling temperature (higher = more random)

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
                 hour=12, fi=None, mood_pct=None, related=None, now=None):
        self.songs = songs                    # id -> row (visible only)
        self.liked = set(liked) & set(songs)
        self.disliked = set(disliked)
        self.plays = plays or {}              # id -> {'c','last','c60'}
        self.hour_plays = hour_plays or {}    # id -> plays around this hour
        self.hour = hour
        self.fi = fi or FeatureIndex()
        self.mood_pct = mood_pct or {}        # id -> percentile dict
        self.related = related or (lambda artist: [])
        self.now = now or datetime.now()
        self._aff = {}
        for sid in songs:
            c = (self.plays.get(sid) or {}).get('c', 0)
            a = 0.55 * (1.0 if sid in self.liked else 0.0) \
                + 0.45 * min(1.0, math.log1p(c) / math.log1p(12))
            if a > 0:
                self._aff[sid] = min(1.0, a)
        self._taste = False   # lazy: (centroid, sims) | None
        self._top_genres = None

    def aff(self, sid):
        return self._aff.get(sid, 0.0)

    def played(self, sid):
        return (self.plays.get(sid) or {}).get('c', 0) > 0

    def artist(self, sid):
        return (self.songs.get(sid) or {}).get('primary_artist', '')

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
        """0..1 closeness to the listener's taste (audio, else genre)."""
        t = self.taste()
        i = self.fi.pos.get(sid) if self.fi else None
        if t is not None and i is not None:
            return max(0.0, float(t[1][i]))
        g = _genre_of(self.songs.get(sid))
        return 0.4 if g and g in self.top_genres() else 0.1


# ------------------------------------------------------------------ helpers

def _primary_artist(artist):
    return re.split(r'[,;/&]', artist or '')[0].strip()


def _genre_of(row):
    g = (row or {}).get('genre') or ''
    g = re.split(r'[;/,]', g)[0].strip()
    return '' if g.lower() in ('', 'unknown', 'other') else g


def _pick(ctx, scores, limit, rng, artist_cap=_ARTIST_CAP, temp=_TEMP,
          exclude=()):
    """Weighted-random top picks with a per-artist cap.

    Gumbel-perturbing score/temp is a weighted sample without replacement:
    strong candidates nearly always make it, borderline ones rotate between
    refreshes. The pool is limited to the best `limit*4` so junk never wins.
    """
    exclude = set(exclude)
    items = [(s, sid) for sid, s in scores.items()
             if sid not in ctx.disliked and sid not in exclude]
    items.sort(key=lambda x: -x[0])
    items = items[:limit * 4]
    if not items:
        return []
    noise = rng.gumbel(size=len(items))
    ranked = sorted(zip(items, noise), key=lambda p: -(p[0][0] / temp + p[1]))
    chosen, counts = [], {}
    for (_, sid), _n in ranked:
        art = ctx.artist(sid)
        if art and counts.get(art, 0) >= artist_cap:
            continue
        chosen.append(sid)
        counts[art] = counts.get(art, 0) + 1
        if len(chosen) >= limit:
            break
    return chosen


def flow_order(ctx, sids, rng, anchor=None):
    """Order songs so neighbours sound alike (greedy nearest-neighbour walk).

    Same-artist back-to-back is penalised; songs with no audio features get
    a neutral similarity so they scatter through the mix instead of
    clustering at the end.
    """
    sids = list(dict.fromkeys(sids))
    n = len(sids)
    if n <= 2 or not ctx.fi:
        return sids
    fi = ctx.fi
    have = np.array([s in fi.pos for s in sids])
    U = np.zeros((n, fi.U.shape[1]))
    for k, s in enumerate(sids):
        if have[k]:
            U[k] = fi.U[fi.pos[s]]
    S = U @ U.T
    miss = ~have
    S[miss, :] = 0.2
    S[:, miss] = 0.2
    artists = [ctx.artist(s) for s in sids]

    remaining = set(range(n))
    if anchor is not None and anchor in fi.pos:
        a_vec = fi.U[fi.pos[anchor]]
        start = int(np.argmax([float(U[k] @ a_vec) if have[k] else -1 for k in range(n)]))
    else:
        start = int(rng.integers(n))
    order = [start]
    remaining.discard(start)
    while remaining:
        cur = order[-1]
        prev = order[-2] if len(order) > 1 else None
        best, best_v = None, -9.0
        for j in remaining:
            v = S[cur, j] + rng.uniform(0, 0.03)
            if artists[j] and artists[j] == artists[cur]:
                v -= 0.35
            elif prev is not None and artists[j] and artists[j] == artists[prev]:
                v -= 0.12
            if v > best_v:
                best, best_v = j, v
        order.append(best)
        remaining.discard(best)
    return [sids[k] for k in order]


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


def _percentiles(values):
    """Rank-percentile (0..1) for an array, robust to scale differences."""
    order = np.argsort(np.argsort(values))
    return order / max(len(values) - 1, 1)


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


def _mix(ctx, mid, kind, shelf, title, sids, subtitle=None, tag=None):
    return {
        'id': mid, 'kind': kind, 'shelf': shelf, 'title': title,
        'subtitle': subtitle if subtitle is not None else _artist_line(ctx, sids),
        'tag': tag, 'song_ids': list(sids),
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


# ---------------------------------------------------------------- builders

def _supermix(ctx, rng, limit):
    songs = list(ctx.songs)
    if not ctx.has_history:
        scores = {s: rng.uniform(0, 1) for s in songs}
        sids = _pick(ctx, scores, limit, rng, temp=1.0)
        return _mix(ctx, 'supermix', 'supermix', 'made', 'Supermix',
                    flow_order(ctx, sids, rng),
                    subtitle='A bit of everything in your library')
    familiar = {s: 0.6 * ctx.aff(s) + 0.4 * ctx.taste_score(s)
                for s in songs if ctx.aff(s) > 0}
    fresh = {s: ctx.taste_score(s) for s in songs if ctx.aff(s) == 0}
    n_fresh = min(limit // 3, len(fresh))
    fam = _pick(ctx, familiar, limit - n_fresh, rng, artist_cap=2)
    new = _pick(ctx, fresh, limit - len(fam), rng, artist_cap=2)
    sids = flow_order(ctx, fam + new, rng)
    return _mix(ctx, 'supermix', 'supermix', 'made', 'Supermix', sids,
                subtitle=_artist_line(ctx, sids))


def _my_mixes(ctx, rng, limit):
    """Cluster the listener's taste into a few distinct 'My Mix' playlists."""
    fi = ctx.fi
    pts = [s for s in ctx._aff if s in fi.pos] if fi else []
    if len(pts) < 12:
        return []
    k = int(min(5, max(2, round(math.sqrt(len(pts) / 8)))))
    U = fi.U[[fi.pos[s] for s in pts]]
    w = np.array([ctx.aff(s) for s in pts])
    labels, C = _spherical_kmeans(U, w, k, rng)
    groups = []
    for j in range(k):
        members = [pts[i] for i in np.where(labels == j)[0]]
        if len(members) >= 5:
            groups.append((sum(ctx.aff(m) for m in members), members, C[j]))
    groups.sort(key=lambda g: -g[0])

    out, used_tags = [], set()
    for n, (_, members, center) in enumerate(groups, start=1):
        sims = fi.U @ center
        scores = {}
        for sid, i in fi.pos.items():
            if sid in ctx.disliked:
                continue
            scores[sid] = float(sims[i]) + 0.25 * ctx.aff(sid)
        sids = _pick(ctx, scores, limit, rng, artist_cap=3)
        if len(sids) < 10:
            continue
        counts = {}
        for m in members:
            g = _genre_of(ctx.songs.get(m))
            if g:
                counts[g] = counts.get(g, 0) + ctx.aff(m)
        tag = None
        for g in sorted(counts, key=counts.get, reverse=True):
            if g not in used_tags:
                tag = g
                used_tags.add(g)
                break
        out.append(_mix(ctx, f'my-{n}', 'my', 'made', f'My Mix {n}',
                        flow_order(ctx, sids, rng), tag=tag))
    return out


def _discover(ctx, rng, limit):
    if not ctx.has_history:
        return None
    played_artists = {ctx.artist(s) for s in ctx._aff}
    scores = {}
    for sid in ctx.songs:
        if ctx.played(sid) or sid in ctx.liked:
            continue
        s = ctx.taste_score(sid)
        if _genre_of(ctx.songs[sid]) in ctx.top_genres():
            s += 0.08
        if ctx.artist(sid) not in played_artists:
            s += 0.06           # reward genuinely new artists
        scores[sid] = s
    sids = _pick(ctx, scores, limit, rng, artist_cap=2)
    if len(sids) < 8:
        return None
    return _mix(ctx, 'discover', 'discover', 'fresh', 'Discover Mix',
                flow_order(ctx, sids, rng),
                tag='Not played yet')


def _replay(ctx, rng, limit):
    scores = {}
    for sid, p in ctx.plays.items():
        if sid in ctx.songs and p.get('c60', 0) > 0:
            scores[sid] = p['c60'] + 0.3 * p['c']
    if len(scores) < 10:
        return None
    sids = _pick(ctx, scores, limit, rng, artist_cap=4, temp=max(scores.values()) * 0.15 or 1)
    sids.sort(key=lambda s: -scores[s])
    return _mix(ctx, 'replay', 'replay', 'fresh', 'Replay Mix', sids,
                tag='Last 60 days')


def _right_now(ctx, rng, limit):
    scores = {sid: c for sid, c in ctx.hour_plays.items() if sid in ctx.songs}
    if len(scores) < 8:
        return None
    for sid in scores:
        scores[sid] += 0.5 * ctx.taste_score(sid) + 0.5 * ctx.aff(sid)
    sids = _pick(ctx, scores, limit, rng, artist_cap=3,
                 temp=max(scores.values()) * 0.15 or 1)
    h = ctx.hour
    part = ('Morning' if 5 <= h < 11 else 'Afternoon' if 11 <= h < 17
            else 'Evening' if 17 <= h < 22 else 'Late Night')
    return _mix(ctx, 'now', 'now', 'fresh', f'{part} Mix',
                flow_order(ctx, sids, rng),
                subtitle=_artist_line(ctx, sids), tag='Right now')


def _rediscover(ctx, rng, limit):
    cutoff = ctx.now - timedelta(days=60)
    scores = {}
    for sid in ctx.songs:
        a = ctx.aff(sid)
        if a < 0.25:      # ~4+ plays, or liked
            continue
        last = (ctx.plays.get(sid) or {}).get('last')
        if last is None or last < cutoff:
            days = 365 if last is None else (ctx.now - last).days
            scores[sid] = a + min(days, 720) / 720.0 * 0.5
    if len(scores) < 8:
        return None
    sids = _pick(ctx, scores, limit, rng, artist_cap=3)
    return _mix(ctx, 'rediscover', 'rediscover', 'fresh', 'Rediscover Mix',
                flow_order(ctx, sids, rng),
                tag="Haven't heard in a while")


def _new_arrivals(ctx, rng, limit):
    cutoff = ctx.now - timedelta(days=30)
    recent = [(r['scanned_at'], sid) for sid, r in ctx.songs.items()
              if r.get('scanned_at') and r['scanned_at'] >= cutoff
              and sid not in ctx.disliked]
    if len(recent) < 5:
        return None
    recent.sort(key=lambda x: x[0], reverse=True)
    scores = {sid: (len(recent) - i) / len(recent) + 0.3 * ctx.taste_score(sid)
              for i, (_, sid) in enumerate(recent)}
    sids = _pick(ctx, scores, limit, rng, artist_cap=4, temp=0.3)
    return _mix(ctx, 'new', 'new', 'fresh', 'New Arrivals',
                flow_order(ctx, sids, rng),
                tag='Added this month')


def _liked(ctx, rng, limit):
    if not ctx.liked:
        return None
    scores = {s: 1.0 + rng.uniform(0, 0.3) for s in ctx.liked}
    sids = _pick(ctx, scores, limit, rng, artist_cap=4, temp=0.5)
    return _mix(ctx, 'liked', 'liked', 'fresh', 'Liked Mix',
                flow_order(ctx, sids, rng), tag=f'{len(ctx.liked)} liked')


def _artist_mixes(ctx, rng, limit, how_many=3):
    totals = {}
    for sid, p in ctx.plays.items():
        art = ctx.artist(sid)
        if sid in ctx.songs and art and art.lower() != 'unknown artist':
            totals[art] = totals.get(art, 0) + p['c']
    out = []
    for art in sorted(totals, key=lambda a: -totals[a]):
        if len(out) >= how_many:
            break
        own = [s for s in ctx.songs if ctx.artist(s) == art]
        if len(own) < 2:
            continue
        center = ctx.fi.centroid({s: 1 + ctx.aff(s) for s in own}) if ctx.fi else None
        sims = ctx.fi.sims_to(center) if center is not None else None
        try:
            rel = {r['related_artist'].lower(): float(r.get('similarity') or 0)
                   for r in (ctx.related(art) or [])}
        except Exception:  # noqa: BLE001
            rel = {}
        own_scores = {s: 1.0 + 0.3 * ctx.aff(s) for s in own}
        others = {}
        for sid in ctx.songs:
            if ctx.artist(sid) == art:
                continue
            i = ctx.fi.pos.get(sid) if ctx.fi else None
            sim = float(sims[i]) if (sims is not None and i is not None) else 0.0
            r = rel.get(ctx.artist(sid).lower())
            s = (0.5 + 0.4 * r + 0.1 * sim) if r is not None else 0.5 * sim
            if s > 0.3:
                others[sid] = s
        pick_own = _pick(ctx, own_scores, min(10, limit // 3), rng, artist_cap=10)
        pick_other = _pick(ctx, others, limit - len(pick_own), rng, artist_cap=2,
                           exclude=pick_own)
        sids = pick_own + pick_other
        if len(sids) < 10:
            continue
        sids = flow_order(ctx, sids, rng, anchor=pick_own[0] if pick_own else None)
        out.append(_mix(ctx, 'artist-' + re.sub(r'[^a-z0-9]+', '-', art.lower()).strip('-'),
                        'artist', 'artists', f'{art} Mix', sids,
                        subtitle=_artist_line(ctx, sids, lead=art), tag='Because you listen'))
    return out


def _mood_mixes(ctx, rng, limit):
    if len(ctx.mood_pct) < _MIN_FEATURED:
        return []
    out = []
    for mid, title, sub, fn in MOODS:
        scores = {}
        for sid, p in ctx.mood_pct.items():
            if sid in ctx.songs:
                scores[sid] = fn(p) + 0.1 * ctx.aff(sid)
        sids = _pick(ctx, scores, limit, rng, artist_cap=2, temp=0.10)
        if len(sids) < 10:
            continue
        out.append(_mix(ctx, 'mood-' + mid, 'mood', 'moods', title,
                        flow_order(ctx, sids, rng), subtitle=sub))
    return out


def build_mixes(ctx, seed=None, limit=MIX_SIZE):
    """The full shelf of mixes for one listener (list of descriptors)."""
    if not ctx.songs:
        return []
    rng = np.random.default_rng(seed)
    mixes = [_supermix(ctx, rng, limit)]
    mixes += _my_mixes(ctx, rng, limit)
    for builder in (_discover, _replay, _right_now, _rediscover, _new_arrivals, _liked):
        m = builder(ctx, rng, limit)
        if m:
            mixes.append(m)
    mixes += _artist_mixes(ctx, rng, limit)
    mixes += _mood_mixes(ctx, rng, limit)
    return [m for m in mixes if m['song_ids']]


def extend(ctx, mix_id, recent_ids, limit=15, seed=None):
    """More songs for an endlessly-playing mix.

    Steers by what is playing *now* (the last few queued songs) so the
    session drifts naturally, while staying anchored to the mix's character
    (mood scorer, 'discover' = unplayed only) and the listener's taste.
    """
    rng = np.random.default_rng(seed)
    exclude = set(recent_ids)
    tail = [s for s in recent_ids if s in ctx.songs][-5:]
    c_tail = ctx.fi.centroid({s: 1.0 + i * 0.3 for i, s in enumerate(tail)}) if ctx.fi else None
    sims_tail = ctx.fi.sims_to(c_tail) if c_tail is not None else None
    mood = _MOOD_BY_ID.get(mix_id[5:]) if mix_id.startswith('mood-') else None

    # A mood mix keeps its character: only the best-fitting third of the
    # library is eligible, and sound-alike steering happens inside that.
    eligible = None
    if mood is not None:
        fit = {sid: mood[3](p) for sid, p in ctx.mood_pct.items() if sid in ctx.songs}
        if fit:
            cut = float(np.percentile(list(fit.values()), 67))
            eligible = {sid for sid, v in fit.items() if v >= cut}

    scores = {}
    for sid in ctx.songs:
        if sid in exclude or sid in ctx.disliked:
            continue
        if eligible is not None and sid not in eligible:
            continue
        if mix_id == 'discover' and (ctx.played(sid) or sid in ctx.liked):
            continue
        i = ctx.fi.pos.get(sid) if ctx.fi else None
        s = 0.2 * ctx.taste_score(sid) + 0.15 * ctx.aff(sid)
        if sims_tail is not None and i is not None:
            s += 0.6 * max(0.0, float(sims_tail[i]))
        scores[sid] = s
    sids = _pick(ctx, scores, limit, rng, artist_cap=2)
    return flow_order(ctx, sids, rng, anchor=tail[-1] if tail else None)


# --------------------------------------------------------- data (MySQL side)

def load_context(user_id):
    """Gather the listener's data. The only DB-touching function here."""
    from models.library_access import LibraryAccessModel
    from models.song_rating import SongRatingModel
    from utils import recommender

    rows = Database.execute_query(
        "SELECT id, file_path, title, artist, album, duration, track_number, "
        "year, genre, cover_path, scanned_at FROM songs", fetch_all=True) or []
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

    try:
        mood_pct = build_mood_percentiles(Database.execute_query(
            "SELECT song_id, tempo_bpm, danceability, energy, loudness_db "
            "FROM song_features", fetch_all=True) or [])
    except Exception as e:  # noqa: BLE001
        print(f"[mixes] mood features failed: {e}")
        mood_pct = {}

    def related(artist):
        return Database.execute_query(
            "SELECT related_artist, similarity FROM artist_relations "
            "WHERE artist_name = %s ORDER BY similarity DESC LIMIT 25",
            (artist,), fetch_all=True) or []

    return Ctx(songs, liked, disliked, plays, hour_plays,
               int(hour_row.get('h', 12)), fi, mood_pct, related)


def song_payload(row):
    return {
        'id': row['id'], 'path': row['file_path'], 'title': row['title'],
        'artist': row['artist'], 'album': row['album'],
        'duration': row['duration'], 'track': row['track_number'],
        'year': row['year'], 'genre': row['genre'],
        'cover_path': row['cover_path'],
    }


def serialize(ctx, mixes):
    """Descriptors -> JSON-ready mixes with full song dicts + cover mosaic."""
    out = []
    for m in mixes:
        songs = [song_payload(ctx.songs[s]) for s in m['song_ids'] if s in ctx.songs]
        if not songs:
            continue
        covers, seen = [], set()
        for s in songs:
            cp = s.get('cover_path')
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
            'covers': covers, 'songs': songs,
        })
    return out
