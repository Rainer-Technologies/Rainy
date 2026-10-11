"""Song radio: YouTube Music discovery on top of the local library.

"Start radio" on a song builds an endless queue of similar music, most of
it songs the listener does not have yet:

  - The queue follows YouTube Music's own radio for the seed song
    (ytmusicapi, no login). The *deep* radio of the seed (~150 tracks) is the
    pool for the whole session: re-seeding on whatever plays last drifts off
    within ten songs, staying anchored to the seed does not.
  - It is re-ranked for the listener by co-occurrence: a track that also
    shows up in the radios of other songs they own moves up. Measured on a
    real library this is what predicts "songs you would add"; plain artist
    affinity adds nothing on top.
  - A radio track the listener already owns plays from their library; it is
    never downloaded again.
  - New songs are downloaded a few tracks ahead (utils/radio_worker.py) as
    *transient* songs: real `songs` rows without library access, playable
    through `radio_access`, kept only if the listener likes them or adds
    them somewhere (promote), deleted again otherwise (cleanup).
  - If YouTube Music gives nothing (it is an unofficial API), the radio
    falls back to library songs that sound like the seed.

The text/matching/ranking helpers are pure functions; everything that
touches YouTube Music or the database is below them.
"""
import difflib
import math
import os
import re
import shutil
import threading
import time
import unicodedata
from collections import Counter

from config import Config
from models.database import Database
from models.radio import RadioAccessModel, RadioCacheModel, RadioTrackModel

SHALLOW_LIMIT = 50            # one page: enough for a first batch, ~0.7s
DEEP_LIMIT = 150              # the session pool, ~4s
RADIO_CACHE_DAYS = 7
MIN_SECONDS, MAX_SECONDS = 60, 600
ARTIST_CAP = 2                # per batch
LOCAL_MIN, LOCAL_MAX = 10, 60  # library songs the offline fallback draws on (a quarter of it)
COOC_SONGS = 600              # library songs feeding the co-occurrence counts
COOC_RADIO_SIZE = 50
TRANSIENT_TTL_HOURS = 24
TRANSIENT_MAX_FILES = 200

_ATV = 'MUSIC_VIDEO_TYPE_ATV'  # official audio ("Topic") tracks

_PAREN = re.compile(r'[\(\[][^\)\]]*[\)\]]')
_FEAT = re.compile(r'\b(feat|ft|featuring)\b\.?.*$', re.I)
_VERSION = re.compile(
    r'\b(live|en vivo|en directo|directo|remix|sped up|slowed|reverb|nightcore|'
    r'karaoke|instrumental|acoustic|acustic[oa]|acústic[oa]|cover|8d|demo|mashup|preview)\b', re.I)
_ARTIST_SPLIT = re.compile(r',|&| x | feat\.? | ft\.? ', re.I)


# ------------------------------------------------------------------- text

def norm(s):
    """Accent-folded, lowercase, alphanumeric words."""
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    return ' '.join(re.sub(r'[^a-z0-9 ]+', ' ', s).split())


def core_title(title):
    """The title without (feat. …), [remaster] and ' - Live' style suffixes."""
    t = _PAREN.sub(' ', title or '')
    t = re.split(r'\s[-–]\s', t)[0]
    return norm(_FEAT.sub('', t))


def artists_of(artist):
    """Normalised artist names of a 'A, B & C' credit, in order."""
    return [a for a in (norm(x) for x in _ARTIST_SPLIT.split(artist or '')) if a]


def versions(title):
    """Version markers in a title ({'live'}, {'remix'}, …)."""
    return {m.group(1).lower() for m in _VERSION.finditer(title or '')}


def song_key(title, artist):
    """Identity of a song across sources: core title + first artist."""
    names = artists_of(artist)
    return core_title(title) + '|' + (names[0] if names else '')


def parse_length(text):
    """'3:37' / '1:02:03' -> seconds (0 when unparseable)."""
    try:
        parts = [int(p) for p in str(text).split(':')]
    except (TypeError, ValueError):
        return 0
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


# ---------------------------------------------------------------- matching

def match_score(song, result):
    """How well a YouTube Music search result matches a local song.

    song: {'title', 'artist', 'duration'}; result: {'title', 'artists'
    (names), 'duration'}. Returns (total, (title, artist, duration, penalty)).
    """
    lt, rt = core_title(song.get('title')), core_title(result.get('title'))
    title_s = difflib.SequenceMatcher(None, lt, rt).ratio() if lt and rt else 0.0

    local = artists_of(song.get('artist'))
    remote = [norm(a) for a in result.get('artists') or []]
    artist_s = 0.0
    if local and remote:
        if any(local[0] == r or local[0] in r or r in local[0] for r in remote):
            artist_s = 1.0
        elif set(local) & set(remote):
            artist_s = 0.8
        else:
            artist_s = 0.6 * max(difflib.SequenceMatcher(None, local[0], r).ratio() for r in remote)

    dur_s = 0.5  # unknown on either side: neutral
    ld, rd = song.get('duration'), result.get('duration')
    if ld and rd:
        dur_s = max(0.0, 1.0 - abs(ld - rd) / 12.0)

    penalty = 0.15 if versions(song.get('title')) != versions(result.get('title')) else 0.0
    total = 0.45 * title_s + 0.30 * artist_s + 0.25 * dur_s - penalty
    return total, (title_s, artist_s, dur_s, penalty)


def is_confident(total, parts):
    return total >= 0.72 and parts[0] >= 0.6 and parts[1] >= 0.6


def match_song(song, search=None):
    """Find the YouTube Music track for a local song.

    search(query, kind) -> [{'videoId', 'title', 'artists', 'duration'}];
    defaults to YouTube Music. Returns {'videoId', 'score'} or None when no
    result is a confident match (a wrong seed poisons the whole radio).
    """
    search = search or _yt_search
    first_artist = (song.get('artist') or '').split(',')[0].strip()
    title = song.get('title') or ''
    queries = [
        (f'{first_artist} {title}'.strip(), 'songs'),
        (f'{core_title(title)} {norm(first_artist)}'.strip(), 'songs'),
        (f'{first_artist} {title}'.strip(), 'videos'),
    ]
    best, best_total, best_parts = None, -1.0, None
    for query, kind in queries:
        if not query:
            continue
        try:
            results = search(query, kind)
        except Exception as e:  # noqa: BLE001
            print(f"[radio] search failed for {query!r}: {e}")
            continue
        for r in results[:5]:
            if not r.get('videoId'):
                continue
            total, parts = match_score(song, r)
            if kind == 'videos':
                total -= 0.05   # prefer the official audio when both match
            if total > best_total:
                best, best_total, best_parts = r, total, parts
        if best_total >= 0.85:
            break
    if best is None or not is_confident(best_total, best_parts):
        return None
    return {'videoId': best['videoId'], 'score': round(best_total, 3)}


# ----------------------------------------------------------------- ranking

def filter_candidates(tracks, seed_title='', library_by_video=None, library_by_key=None,
                      exclude_videos=(), exclude_songs=(), blocked_keys=()):
    """Radio tracks worth queueing, original order kept.

    A track the listener already owns (same video, or same title + artist)
    is kept as that library song: it carries its 'song_id' and will play
    from disk. Anything else is a *new* song, and those are held to a
    stricter bar: no user uploads / music videos, no odd lengths, no
    versions the seed is not (live, remix, sped up…). Blocked (disliked)
    and already queued songs are dropped either way.
    Each kept track gets its position in the radio as 'pos'.
    """
    seed_versions = versions(seed_title)
    library_by_video, library_by_key = library_by_video or {}, library_by_key or {}
    exclude_videos, exclude_songs = set(exclude_videos), set(exclude_songs)
    blocked_keys = set(blocked_keys)
    seen_keys, seen_songs, out = set(), set(), []
    for pos, t in enumerate(tracks):
        vid = t.get('videoId')
        if not vid or vid in exclude_videos:
            continue
        key = song_key(t.get('title'), t.get('artist'))
        if key in blocked_keys or key in seen_keys:
            continue
        song_id = library_by_video.get(vid) or library_by_key.get(key)
        if song_id is not None:
            if song_id not in exclude_songs and song_id not in seen_songs:
                seen_songs.add(song_id)
                seen_keys.add(key)
                out.append({**t, 'pos': pos, 'song_id': song_id})
            continue
        if t.get('type') != _ATV:
            continue
        if not MIN_SECONDS <= (t.get('duration') or 0) <= MAX_SECONDS:
            continue
        if versions(t.get('title')) - seed_versions:
            continue
        seen_keys.add(key)
        out.append({**t, 'pos': pos})
    return out


def rerank(candidates, cooccurrence=None, skipped_artists=(), limit=10,
           artist_cap=ARTIST_CAP):
    """Order candidates for the listener and pick `limit` of them.

    score = radio position + co-occurrence with the listener's library
            - a penalty for artists skipped in this session.
    """
    cooccurrence = cooccurrence or {}
    skipped = {norm(a) for a in skipped_artists}

    def score(t):
        s = 1.0 / (1.0 + t.get('pos', 0) / 15.0)
        s += 0.6 * math.log1p(max(0.0, cooccurrence.get(t['videoId'], 0.0)))
        names = artists_of(t.get('artist'))
        if names and names[0] in skipped:
            s -= 0.5
        return s

    ranked = sorted(candidates, key=lambda t: (-score(t), t.get('pos', 0)))
    chosen, per_artist = [], Counter()
    for t in ranked:
        if len(chosen) >= limit:
            break
        names = artists_of(t.get('artist'))
        first = names[0] if names else ''
        if first and per_artist[first] >= artist_cap:
            continue
        per_artist[first] += 1
        chosen.append(t)
    return chosen


def expansion_pool(neighbour_radios, known_videos, min_votes=2):
    """Tracks outside the seed's own radio that at least `min_votes` of its
    closest neighbours' radios agree on (keeps a long session on topic)."""
    votes, first = Counter(), {}
    for radio in neighbour_radios:
        for t in {t['videoId']: t for t in radio if t.get('videoId')}.values():
            votes[t['videoId']] += 1
            first.setdefault(t['videoId'], t)
    known = set(known_videos)
    return [first[v] for v, n in votes.most_common() if n >= min_votes and v not in known]


# --------------------------------------------------------- YouTube Music

def _ytm():
    from utils.metadata import _get_ytm
    return _get_ytm()


def _artist_names(entry):
    return [a.get('name', '').strip() for a in entry.get('artists') or [] if a.get('name')]


def _yt_search(query, kind):
    out = []
    for r in _ytm().search(query, filter=kind, limit=5):
        out.append({
            'videoId': r.get('videoId'),
            'title': r.get('title'),
            'artists': _artist_names(r),
            'duration': r.get('duration_seconds') or parse_length(r.get('duration')),
        })
    return out


def _radio_track(t):
    from utils.metadata import resize_google_cover
    thumbs = t.get('thumbnail') or t.get('thumbnails') or []
    cover = thumbs[-1].get('url') if thumbs else None
    album = t.get('album') or {}
    return {
        'videoId': t.get('videoId'),
        'title': t.get('title') or '',
        'artist': ', '.join(dict.fromkeys(_artist_names(t))) or 'Unknown Artist',
        'album': album.get('name') or '' if isinstance(album, dict) else '',
        'duration': parse_length(t.get('length')),
        'cover_url': resize_google_cover(cover, size=544) if cover else None,
        'type': t.get('videoType'),
    }


def _yt_radio(video_id, limit):
    """YouTube Music's radio for a track (the seed itself comes first)."""
    data = _ytm().get_watch_playlist(videoId=video_id, radio=True, limit=limit)
    seen, tracks = set(), []
    for t in data.get('tracks') or []:
        vid = t.get('videoId')
        if not vid or vid in seen:
            continue
        seen.add(vid)
        tracks.append(_radio_track(t))
    return tracks


def track_info(video_id):
    """YouTube Music's own metadata for one track (performers only — the
    tags yt-dlp writes also list every songwriter as an artist)."""
    data = _ytm().get_watch_playlist(videoId=video_id, limit=1)
    for t in data.get('tracks') or []:
        if t.get('videoId') == video_id:
            return _radio_track(t)
    return None


def fetch_radio(video_id, deep=False):
    """Tracks of a song's radio (seed excluded), cached in the database.

    The deep radio is the pool a whole session draws from; the shallow one
    is a single fast page. A cached deep radio also serves shallow requests.
    """
    cached = RadioCacheModel.get(video_id, RADIO_CACHE_DAYS)
    if cached and (cached.get('deep') or not deep):
        return cached.get('tracks') or []
    tracks = [t for t in _yt_radio(video_id, DEEP_LIMIT if deep else SHALLOW_LIMIT)
              if t['videoId'] != video_id]
    if tracks:
        RadioCacheModel.put(video_id, {'deep': bool(deep), 'tracks': tracks})
    return tracks


def ensure_video_id(song):
    """The song's YouTube Music id, matching (and remembering) it if needed."""
    if song.get('youtube_id'):
        return song['youtube_id']
    if song.get('youtube_matched_at'):
        return None   # already tried; the background worker retries nothing
    found = match_song(song)
    Database.execute_query(
        "UPDATE songs SET youtube_id = %s, youtube_matched_at = NOW() WHERE id = %s",
        (found['videoId'] if found else None, song['id']))
    return found['videoId'] if found else None


# ------------------------------------------------------- listener context

_cooc_cache = {}
_cooc_lock = threading.Lock()
_COOC_TTL = 600.0

_local_cache = {}
_local_lock = threading.Lock()
_LOCAL_TTL = 600.0


def _library_rows(user_id):
    from models.library_access import LibraryAccessModel
    join_sql, join_params = LibraryAccessModel.access_join(user_id)
    return Database.execute_query(
        f"SELECT s.id, s.title, s.artist, s.youtube_id FROM songs s {join_sql}",
        join_params, fetch_all=True) or []


def _play_counts(user_id):
    rows = Database.execute_query(
        "SELECT song_id, COUNT(*) AS c FROM play_history "
        "WHERE user_id = %s AND counted = 1 GROUP BY song_id",
        (user_id,), fetch_all=True) or []
    return {r['song_id']: r['c'] for r in rows}


def cooccurrence(user_id, library=None):
    """({video: weight}, {seed_video: (weight, {videos})}) over the cached
    radios of the listener's library. Songs they play more count more."""
    with _cooc_lock:
        hit = _cooc_cache.get(user_id)
        if hit and time.time() - hit[0] < _COOC_TTL:
            return hit[1], hit[2]
    library = library if library is not None else _library_rows(user_id)
    plays = _play_counts(user_id)
    owned = [r for r in library if r.get('youtube_id')]
    owned.sort(key=lambda r: (-plays.get(r['id'], 0), -r['id']))
    owned = owned[:COOC_SONGS]
    radios = RadioCacheModel.get_many([r['youtube_id'] for r in owned])
    counts, per_seed = Counter(), {}
    for r in owned:
        cached = radios.get(r['youtube_id'])
        if not cached:
            continue
        weight = 1.0 + min(1.0, math.log1p(plays.get(r['id'], 0)) / 3.0)
        vids = {t['videoId'] for t in (cached.get('tracks') or [])[:COOC_RADIO_SIZE]}
        per_seed[r['youtube_id']] = (weight, vids)
        for v in vids:
            counts[v] += weight
    with _cooc_lock:
        _cooc_cache[user_id] = (time.time(), counts, per_seed)
        if len(_cooc_cache) > 200:
            _cooc_cache.pop(min(_cooc_cache, key=lambda u: _cooc_cache[u][0]), None)
    return counts, per_seed


def _local_similar(user_id, seed_id, visible):
    """Library songs that sound like the seed (audio features), cached."""
    key = (user_id, seed_id)
    with _local_lock:
        hit = _local_cache.get(key)
        if hit and time.time() - hit[0] < _LOCAL_TTL:
            return hit[1]
    ids = []
    try:
        from utils.recommender import radio as audio_radio
        # Only the closest part of the library counts as "sounds like the
        # seed": further down the ranking it is just the rest of the library,
        # and new songs keep a radio on topic better than that does.
        closest = max(LOCAL_MIN, min(LOCAL_MAX, len(visible) // 4))
        ranked = audio_radio(seed_id, limit=len(visible) + 50, user_id=user_id)
        ids = [i for i in ranked if i in visible][:closest]
    except Exception as e:  # noqa: BLE001
        print(f"[radio] local similarity failed: {e}")
    with _local_lock:
        _local_cache[key] = (time.time(), ids)
        if len(_local_cache) > 200:
            _local_cache.pop(min(_local_cache, key=lambda k: _local_cache[k][0]), None)
    return ids


def song_payload(row, in_library=True):
    """A song row in the shape the web player queues."""
    return {
        'id': row['id'],
        'path': row['file_path'],
        'title': row['title'],
        'artist': row['artist'],
        'album': row['album'],
        'duration': row['duration'],
        'track': row.get('track_number'),
        'year': row.get('year'),
        'genre': row.get('genre'),
        'cover_path': row.get('cover_path'),
        'in_library': bool(in_library),
    }


def _songs_by_ids(ids):
    if not ids:
        return {}
    ph = ', '.join(['%s'] * len(ids))
    rows = Database.execute_query(
        f"SELECT id, file_path, title, artist, album, duration, track_number, year, "
        f"genre, cover_path, transient FROM songs WHERE id IN ({ph})",
        tuple(ids), fetch_all=True) or []
    return {r['id']: r for r in rows}


def track_payload(track):
    """A not-yet-downloaded radio track; plays through the preview proxy
    until its download lands."""
    return {
        'videoId': track['videoId'],
        'title': track['title'],
        'artist': track['artist'],
        'album': track.get('album') or '',
        'duration': track.get('duration') or 0,
        'cover_url': track.get('cover_url'),
        'radio': True,
    }


# ------------------------------------------------------------ queue build

def build_queue(user_id, seed_id, exclude_song_ids=(), exclude_video_ids=(),
                skipped_artists=(), limit=12, deep=True):
    """The next `limit` items of a radio session.

    Follows YouTube Music's radio for the seed, re-ranked for the listener.
    Tracks they own come back as their library song, the rest as new tracks
    to download. Stateless: the client says what it already queued
    (exclude_*). Returns player items: songs (song_payload) and new tracks
    (track_payload).
    """
    from models.library_access import LibraryAccessModel
    from models.song_rating import SongRatingModel

    seed = Database.execute_query(
        "SELECT id, title, artist, duration, youtube_id, youtube_matched_at "
        "FROM songs WHERE id = %s", (seed_id,), fetch_one=True)
    if not seed or not LibraryAccessModel.can_play(user_id, seed_id):
        return []

    library = _library_rows(user_id)
    visible = {r['id'] for r in library}
    by_id = {r['id']: r for r in library}
    disliked = set(SongRatingModel.get_disliked_song_ids(user_id))
    exclude_songs = set(exclude_song_ids) | disliked | {seed_id}

    picked = []
    try:
        seed_video = ensure_video_id(seed)
        if seed_video:
            pool = fetch_radio(seed_video, deep=deep)
            counts, per_seed = cooccurrence(user_id, library)
            own_weight, own_videos = per_seed.get(seed_video, (0.0, set()))
            cooc = {v: c - (own_weight if v in own_videos else 0.0) for v, c in counts.items()}

            by_key = {}
            for r in library:
                by_key.setdefault(song_key(r['title'], r['artist']), r['id'])
            # A track downloaded earlier is queued as its song, so the client
            # reports it by song id: don't offer its video again.
            queued_videos = _videos_of_downloaded(pool, exclude_songs)
            filters = dict(
                seed_title=seed['title'],
                library_by_video={r['youtube_id']: r['id'] for r in library if r.get('youtube_id')},
                library_by_key=by_key,
                exclude_videos=set(exclude_video_ids) | queued_videos | {seed_video},
                exclude_songs=exclude_songs,
                blocked_keys={song_key(by_id[i]['title'], by_id[i]['artist'])
                              for i in disliked if i in by_id},
            )
            candidates = filter_candidates(pool, **filters)
            if deep and len(candidates) < limit:
                # The seed's own radio is used up: widen with what its
                # closest neighbours agree on.
                neighbours = [fetch_radio(t['videoId']) for t in pool[:5]]
                extra = expansion_pool(neighbours, {t['videoId'] for t in pool} | {seed_video})
                filters['exclude_videos'] |= _videos_of_downloaded(extra, exclude_songs)
                have_keys = {song_key(t['title'], t['artist']) for t in candidates}
                have_songs = {t['song_id'] for t in candidates if t.get('song_id')}
                for t in filter_candidates(extra, **filters):
                    if song_key(t['title'], t['artist']) in have_keys or t.get('song_id') in have_songs:
                        continue
                    candidates.append({**t, 'pos': len(pool) + t['pos']})
            picked = rerank(candidates, cooc, skipped_artists, limit=limit)
    except Exception as e:  # noqa: BLE001
        # YouTube Music is an unofficial API: a radio must survive it failing.
        print(f"[radio] YouTube Music radio failed for song {seed_id}: {e}")

    if picked:
        return _resolve(user_id, picked, visible)

    # Nothing from YouTube Music (down, no match for the seed, or its radio
    # is used up): keep going with library songs that sound like the seed.
    local_ids = [i for i in _local_similar(user_id, seed_id, visible)
                 if i not in exclude_songs][:limit]
    rows = _songs_by_ids(local_ids)
    return [song_payload(rows[i]) for i in local_ids if i in rows]


def _videos_of_downloaded(tracks, song_ids):
    """Videos among `tracks` whose download is one of `song_ids`."""
    if not song_ids:
        return set()
    known = RadioTrackModel.get_many([t['videoId'] for t in tracks if t.get('videoId')])
    return {v for v, r in known.items() if r['status'] == 'ready' and r.get('song_id') in song_ids}


def _resolve(user_id, tracks, visible):
    """Radio tracks as player items, order kept: the listener's own songs
    and tracks already on disk as songs (granting play access to those),
    the rest as pending tracks to download."""
    owned = {t['videoId']: t['song_id'] for t in tracks if t.get('song_id')}
    known = RadioTrackModel.get_many([t['videoId'] for t in tracks if not t.get('song_id')])
    ready = {v: r['song_id'] for v, r in known.items()
             if r['status'] == 'ready' and r.get('song_id')}
    rows = _songs_by_ids(list(set(owned.values()) | set(ready.values())))
    items = []
    for t in tracks:
        vid = t['videoId']
        if vid in owned and owned[vid] in rows:
            items.append(song_payload(rows[owned[vid]]))
        elif ready.get(vid) in rows:
            row = rows[ready[vid]]
            RadioAccessModel.grant(user_id, row['id'])
            items.append(song_payload(row, in_library=row['id'] in visible))
        elif vid not in owned:
            items.append(track_payload(t))
    return items


def prefetch(user_id, tracks):
    """Queue downloads for pending tracks and report where each one is.

    tracks: track_payload dicts. Returns {videoId: {'status', 'song'?}};
    'ready' ones carry the playable song and are granted to the listener.
    """
    from models.library_access import LibraryAccessModel
    from utils import radio_worker

    tracks = [t for t in tracks if t.get('videoId')]
    if not tracks:
        return {}
    RadioTrackModel.request(tracks)
    radio_worker.notify()
    known = RadioTrackModel.get_many([t['videoId'] for t in tracks])
    ready_ids = [r['song_id'] for r in known.values()
                 if r['status'] == 'ready' and r.get('song_id')]
    rows = _songs_by_ids(ready_ids)
    out = {}
    for t in tracks:
        row = known.get(t['videoId'])
        if not row:
            out[t['videoId']] = {'status': 'queued'}
            continue
        song = rows.get(row.get('song_id')) if row['status'] == 'ready' else None
        if row['status'] == 'ready' and not song:
            # The song was cleaned up since: fetch it again.
            RadioTrackModel.forget_song(row['song_id'])
            RadioTrackModel.request([t])
            out[t['videoId']] = {'status': 'queued'}
            continue
        if song:
            RadioAccessModel.grant(user_id, song['id'])
            out[t['videoId']] = {
                'status': 'ready',
                'song': song_payload(
                    song, in_library=LibraryAccessModel.has_access(user_id, song['id'])),
            }
        else:
            out[t['videoId']] = {'status': row['status']}
    return out


# --------------------------------------------------------------- lifecycle

def radio_dir(music_path):
    return os.path.join(music_path, Config.RADIO_DIR)


def is_transient_path(rel_path):
    return (rel_path or '').replace('\\', '/').startswith(Config.RADIO_DIR + '/')


def _library_filename(music_path, title, artist, ext):
    """A free '<Title> - <Artist><ext>' name in the music folder."""
    from utils.youtube import YouTubeDownloader
    clean = YouTubeDownloader(music_path)._sanitize_filename
    base = f"{clean(title or 'Unknown Title')} - {clean((artist or 'Unknown Artist').split(',')[0])}"
    name, n = f'{base}{ext}', 1
    while os.path.exists(os.path.join(music_path, name)):
        n += 1
        name = f'{base} ({n}){ext}'
    return name


def _move_into_library(song, music_path):
    """Move a transient song's file out of the radio folder and clear the
    flag, so scans treat it like any other library file."""
    rel = song['file_path']
    if is_transient_path(rel):
        src = os.path.join(music_path, rel)
        if os.path.isfile(src):
            new_rel = _library_filename(
                music_path, song.get('title'), song.get('artist'), os.path.splitext(rel)[1])
            shutil.move(src, os.path.join(music_path, new_rel))
            rel = new_rel
    Database.execute_query(
        "UPDATE songs SET transient = 0, file_path = %s WHERE id = %s", (rel, song['id']))
    from models.lyrics_job import LyricsJobModel
    from utils import lightshow_worker, lyrics_worker
    lightshow_worker.enqueue_song(song['id'])
    # A kept song gets a second chance at lyrics: a lookup that found
    # nothing is dropped so the job searches again.
    LyricsJobModel.forget_missing(song['id'])
    lyrics_worker.enqueue_song(song['id'])


def promote(song_id, user_id, music_path=None):
    """Keep a radio song: it becomes a normal song in the user's library.

    Returns True when the user now has it in their library. A song they
    only reach through radio_access but which already belongs to someone
    (a duplicate of an existing file) is added like a shared-playlist save.
    """
    from models.library_access import LibraryAccessModel
    from models.settings import SettingsModel

    song = Database.execute_query(
        "SELECT id, file_path, title, artist, transient FROM songs WHERE id = %s",
        (song_id,), fetch_one=True)
    if not song:
        return False
    if LibraryAccessModel.has_access(user_id, song_id) and not song['transient']:
        return True
    if not LibraryAccessModel.can_play(user_id, song_id):
        return False
    if song['transient']:
        music_path = music_path or SettingsModel.get_music_path()
        if not music_path:
            return False
        _move_into_library(song, music_path)
        LibraryAccessModel.grant(user_id, song_id, origin='import')
    else:
        LibraryAccessModel.save_to_library(user_id, song_id)
    return True


def _delete_transient(song, music_path):
    """Remove a transient song: row (cascades access, history, analysis),
    queued jobs, audio file, and its cover if nothing else uses it."""
    RadioTrackModel.forget_song(song['id'])
    for table in ('enrichment_jobs', 'lightshow_jobs', 'lyrics_jobs'):
        try:
            Database.execute_query(
                f"DELETE FROM {table} WHERE song_id = %s AND status = 'queued'", (song['id'],))
        except Exception as e:  # noqa: BLE001
            print(f"[radio] could not clear {table} for song {song['id']}: {e}")
    Database.execute_query("DELETE FROM songs WHERE id = %s", (song['id'],))

    root = os.path.realpath(music_path)

    def remove(rel):
        full = os.path.realpath(os.path.join(root, rel.replace('\\', '/')))
        if full == root or os.path.commonpath([root, full]) != root:
            return
        try:
            if os.path.isfile(full):
                os.remove(full)
        except OSError as e:
            print(f"[radio] could not delete {full}: {e}")

    if song.get('file_path'):
        remove(song['file_path'])
    cover = song.get('cover_path')
    if cover and not Database.execute_query(
            "SELECT 1 FROM songs WHERE cover_path = %s "
            "UNION SELECT 1 FROM playlists WHERE cover_path = %s",
            (cover, cover), fetch_one=True):
        remove(cover)


def cleanup(music_path, ttl_hours=TRANSIENT_TTL_HOURS, max_files=TRANSIENT_MAX_FILES):
    """Delete radio downloads nobody kept. Returns (deleted, promoted).

    A transient song goes when no radio has had it queued for ttl_hours, or
    when there are more than max_files of them (least recently used first).
    Safety net: one that ended up in a library or a playlist anyway is
    promoted instead — it is someone's song now.
    """
    songs = RadioAccessModel.transient_songs()
    deleted = promoted = 0
    keep = []
    for s in songs:
        if s['library_refs'] or s['playlist_refs']:
            _move_into_library(s, music_path)
            promoted += 1
        else:
            keep.append(s)
    expired = RadioAccessModel.expired_song_ids(ttl_hours)
    overflow = max(0, len(keep) - max_files)
    for i, s in enumerate(keep):          # least recently used first
        if s['id'] in expired or i < overflow:
            _delete_transient(s, music_path)
            deleted += 1
    RadioTrackModel.drop_orphans()
    return deleted, promoted
