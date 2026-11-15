"""YouTube Music candidates for the personalised mixes.

The mixes used to be library-only: everything they could suggest was something
the listener already owned. This module lets a mix carry songs they do NOT own
yet, drawn from YouTube Music's own radio (the same algorithm the Radio feature
uses), so a mix doubles as a way to grow the catalogue — exactly like radio does.

Design rules, in order of importance:

1. **The shelf request stays fast.** `GET /api/smartmix/mixes` is on the critical
   path of opening the app, so YouTube work is budgeted in wall-clock seconds,
   cache-first, and concurrent. When the budget runs out the mix simply stays
   library-only; it never fails and never blocks.
2. **Reuse, do not reimplement.** `utils/ytradio.py` already owns matching,
   filtering, co-occurrence re-ranking and the track payload shape. This module
   only chooses seeds and blends results.
3. **Mood-anchored seeding.** A YouTube track has no audio features, so it cannot
   be mood-scored. Instead the *seed* is chosen from the songs that fit the mood,
   and YouTube's radio inherits that character. That is the honest way to put
   external songs in a Chill mix.
4. **Only genuinely new songs.** Tracks the listener owns are filtered out here
   (they are already candidates for the local half of the mix), so an external
   slot is always a song worth adding.
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

SEEDS_PER_SHELF = 3        # how many library songs seed the shelf's YouTube radios
SEEDS_PER_MOOD = 2         # mood mixes seed from their own best-fitting songs
PER_MIX = 5                # external tracks blended into one mix
RADIO_MIX_SIZE = 20        # the all-external "YouTube Radio Mix"
BUDGET_S = 6.0             # total wall-clock budget for one shelf's YouTube work
WORKERS = 3                # concurrent radio fetches
SEED_SEARCH_BUDGET = 2     # songs we are willing to match on YouTube (a search each)

_cache_lock = threading.Lock()
_pool_cache = {}           # (user_id, video_id) -> (ts, tracks)
_POOL_TTL = 300.0


def _owned_index(ctx):
    """video_id -> song_id and normalised key -> song_id for the visible library."""
    from utils import ytradio
    by_video, by_key = {}, {}
    for sid, row in ctx.songs.items():
        vid = row.get('youtube_id')
        if vid:
            by_video[vid] = sid
        by_key.setdefault(ytradio.song_key(row.get('title'), row.get('artist')), sid)
    return by_video, by_key


def _seeds(ctx, mood_id=None, count=SEEDS_PER_SHELF):
    """Library songs worth seeding a YouTube radio with.

    Preference order: songs that already have a matched YouTube id (no extra
    search), then the listener's strongest affinity. For a mood, only songs
    inside that mood's coherence bar are eligible, so the radio inherits it.
    """
    if mood_id is not None:
        from utils.mixes import _mood_gate
        gate = _mood_gate(ctx, mood_id)
        pool = sorted(gate, key=lambda s: (-gate[s], -ctx.aff(s)))
    else:
        pool = sorted(ctx.songs, key=lambda s: (-ctx.aff(s), s))
    known = [s for s in pool if ctx.songs[s].get('youtube_id')]
    unknown = [s for s in pool if not ctx.songs[s].get('youtube_id')]
    return (known + unknown)[:count], len(known)


def _radio_tracks(video_id, budget_left):
    """One seed's radio, cache-first. Returns [] on any failure or timeout."""
    from models.radio import RadioCacheModel
    from utils import ytradio
    key = video_id
    with _cache_lock:
        hit = _pool_cache.get(key)
        if hit and time.time() - hit[0] < _POOL_TTL:
            return hit[1]
    cached = RadioCacheModel.get(video_id, ytradio.RADIO_CACHE_DAYS)
    tracks = (cached or {}).get('tracks') or []
    if not tracks and budget_left > 0.4:
        try:
            tracks = ytradio.fetch_radio(video_id, deep=False) or []
        except Exception as e:  # noqa: BLE001
            print(f"[mixes] youtube radio failed for {video_id}: {e}")
            tracks = []
    with _cache_lock:
        _pool_cache[key] = (time.time(), tracks)
        if len(_pool_cache) > 400:
            _pool_cache.pop(min(_pool_cache, key=lambda k: _pool_cache[k][0]), None)
    return tracks


def candidates(user_id, ctx, mood_id=None, want=PER_MIX, budget=BUDGET_S,
               exclude_videos=(), count=None):
    """External tracks for one mix, best first. Never raises.

    Returns a list of track dicts in `ytradio.track_payload` shape plus
    `in_library: False`. Empty when YouTube gives nothing, the budget is spent,
    or the listener has no seedable song — the caller then keeps the mix local.
    """
    from utils import ytradio
    if want <= 0 or not ctx.songs:
        return []
    t0 = time.time()
    seeds, n_known = _seeds(ctx, mood_id, count or (SEEDS_PER_MOOD if mood_id else SEEDS_PER_SHELF))
    if not seeds:
        return []

    by_video, by_key = _owned_index(ctx)
    blocked = {ytradio.song_key(ctx.songs[s].get('title'), ctx.songs[s].get('artist'))
               for s in ctx.disliked if s in ctx.songs}
    exclude = set(exclude_videos) | set(by_video)

    # Resolve video ids. Songs already matched cost nothing; a handful of
    # searches is the most we will pay to seed a shelf.
    videos = []
    searches = 0
    for sid in seeds:
        row = ctx.songs[sid]
        vid = row.get('youtube_id')
        if not vid and searches < SEED_SEARCH_BUDGET and time.time() - t0 < budget:
            try:
                vid = ytradio.ensure_video_id(dict(row))
                searches += 1
            except Exception as e:  # noqa: BLE001
                print(f"[mixes] youtube match failed for song {sid}: {e}")
                vid = None
            if vid:
                row['youtube_id'] = vid
        if vid:
            videos.append((sid, vid))
    if not videos:
        return []

    pools = {}
    left = budget - (time.time() - t0)
    if left > 0.2:
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(_radio_tracks, vid, left): vid for _sid, vid in videos}
            try:
                for fut in futs:
                    remaining = max(0.05, budget - (time.time() - t0))
                    try:
                        pools[futs[fut]] = fut.result(timeout=remaining)
                    except (FutureTimeout, Exception):  # noqa: BLE001
                        pools[futs[fut]] = []
            except Exception:  # noqa: BLE001
                pass

    # Merge the seeds' radios, keeping YouTube's own order as the base signal.
    merged, seen = [], set()
    for _sid, vid in videos:
        for pos, t in enumerate(pools.get(vid) or []):
            v = t.get('videoId')
            if not v or v in seen or v in exclude:
                continue
            seen.add(v)
            merged.append({**t, 'pos': pos})
    if not merged:
        return []

    filters = dict(seed_title=ctx.songs[videos[0][0]].get('title') or '',
                   library_by_video=by_video, library_by_key=by_key,
                   exclude_videos=exclude, exclude_songs=set(ctx.disliked),
                   blocked_keys=blocked)
    try:
        cands = ytradio.filter_candidates(merged, **filters)
    except Exception as e:  # noqa: BLE001
        print(f"[mixes] youtube filter failed: {e}")
        return []
    # Only songs the listener does not own: an external slot must be new.
    cands = [t for t in cands if not t.get('song_id')]
    if not cands:
        return []
    try:
        counts, _per_seed = ytradio.cooccurrence(user_id)
    except Exception:  # noqa: BLE001
        counts = {}
    try:
        picked = ytradio.rerank(cands, counts, limit=want, variation=0.0)
    except Exception as e:  # noqa: BLE001
        print(f"[mixes] youtube rerank failed: {e}")
        picked = cands[:want]
    out = []
    for t in picked:
        p = ytradio.track_payload(t)
        p['in_library'] = False
        p['external'] = True
        out.append(p)
    return out


def radio_mix(user_id, ctx, budget=BUDGET_S):
    """The all-external mix: what YouTube's radio thinks the listener is missing.

    Seeded from their strongest song, so it is anchored in their taste rather
    than being a generic chart. Returns [] when nothing is available.
    """
    return candidates(user_id, ctx, want=RADIO_MIX_SIZE, budget=budget)


class Session:
    """One shelf's worth of YouTube work, done once.

    `candidates()` is stateless and fine for a single `/more` batch, but a whole
    shelf has ~9 mixes; calling it per mix would mean ~9 network rounds on a cold
    cache. A Session resolves a deduped seed set (top songs + each mood's best
    fits), fetches their radios concurrently under one budget, and then every
    mix draws from the in-memory pool with no further network. Mood mixes only
    draw from radios seeded by songs that fit that mood, so the character holds.
    """

    def __init__(self, user_id, ctx, budget=BUDGET_S):
        from utils import ytradio
        self.user_id, self.ctx = user_id, ctx
        self.t0 = time.time()
        self.budget = budget
        self.by_video, self.by_key = _owned_index(ctx)
        self.blocked = {ytradio.song_key(ctx.songs[s].get('title'), ctx.songs[s].get('artist'))
                        for s in ctx.disliked if s in ctx.songs}
        # seed video -> set of mood ids it fits (empty = general seed)
        self.seed_moods = {}
        self.pools = {}
        self._counts = None
        self._searches = 0          # global across the shelf, so searches can't eat the budget
        self._prepare()

    def _resolve(self, sids):
        from utils import ytradio
        vids = []
        for sid in sids:
            row = self.ctx.songs[sid]
            vid = row.get('youtube_id')
            if not vid and self._searches < SEED_SEARCH_BUDGET \
                    and time.time() - self.t0 < self.budget:
                try:
                    vid = ytradio.ensure_video_id(dict(row))
                    self._searches += 1
                except Exception:  # noqa: BLE001
                    vid = None
                if vid:
                    row['youtube_id'] = vid
            if vid:
                vids.append(vid)
        return vids

    def _prepare(self):
        from utils.mixes import _mood_gate, MOODS
        general, _ = _seeds(self.ctx, None, SEEDS_PER_SHELF)
        seed_set = {}
        for vid in self._resolve(general):
            seed_set.setdefault(vid, set())
        for mid, _title, _sub, _fn in MOODS:
            mood_seeds, _ = _seeds(self.ctx, mid, SEEDS_PER_MOOD)
            for vid in self._resolve(mood_seeds):
                seed_set.setdefault(vid, set()).add(mid)
        self.seed_moods = seed_set
        if not seed_set:
            return
        left = self.budget - (time.time() - self.t0)
        if left <= 0.2:
            return
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(_radio_tracks, vid, left): vid for vid in seed_set}
            for fut in futs:
                remaining = max(0.05, self.budget - (time.time() - self.t0))
                try:
                    self.pools[futs[fut]] = fut.result(timeout=remaining)
                except Exception:  # noqa: BLE001
                    self.pools[futs[fut]] = []

    def _cooc(self):
        if self._counts is None:
            from utils import ytradio
            try:
                self._counts, _ = ytradio.cooccurrence(self.user_id)
            except Exception:  # noqa: BLE001
                self._counts = {}
        return self._counts

    def for_mix(self, mood_id=None, want=PER_MIX, exclude_videos=()):
        """External tracks for one mix, drawn from the pre-fetched pool."""
        from utils import ytradio
        if want <= 0 or not self.pools:
            return []
        exclude = set(exclude_videos) | set(self.by_video)
        merged, seen = [], set()
        for vid, moods in self.seed_moods.items():
            if mood_id is not None and mood_id not in moods:
                continue
            for pos, t in enumerate(self.pools.get(vid) or []):
                v = t.get('videoId')
                if not v or v in seen or v in exclude:
                    continue
                seen.add(v)
                merged.append({**t, 'pos': pos})
        if not merged:
            return []
        first_seed = next(iter(self.seed_moods), None)
        seed_title = ''
        if first_seed:
            for sid, row in self.ctx.songs.items():
                if row.get('youtube_id') == first_seed:
                    seed_title = row.get('title') or ''
                    break
        filters = dict(seed_title=seed_title, library_by_video=self.by_video,
                       library_by_key=self.by_key, exclude_videos=exclude,
                       exclude_songs=set(self.ctx.disliked), blocked_keys=self.blocked)
        try:
            cands = ytradio.filter_candidates(merged, **filters)
        except Exception:  # noqa: BLE001
            return []
        cands = [t for t in cands if not t.get('song_id')]
        if not cands:
            return []
        try:
            picked = ytradio.rerank(cands, self._cooc(), limit=want, variation=0.0)
        except Exception:  # noqa: BLE001
            picked = cands[:want]
        out = []
        for t in picked:
            p = ytradio.track_payload(t)
            p['in_library'] = False
            p['external'] = True
            out.append(p)
        return out


def shelf_provider(user_id, ctx, budget=BUDGET_S):
    """A provider closure backed by one Session (one fetch for the whole shelf)."""
    session = Session(user_id, ctx, budget=budget)
    return lambda mood_id=None, want=PER_MIX, exclude_videos=(): \
        session.for_mix(mood_id=mood_id, want=want, exclude_videos=exclude_videos)
