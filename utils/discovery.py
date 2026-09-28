"""Playlist DISCOVERY: find YouTube / Spotify playlists BY NAME.

Complements the existing paste-a-URL importers (utils/youtube.py,
utils/spotify.py, utils/import_jobs.py): this module only SEARCHES and
PREVIEWS — importing reuses the existing import-jobs queue.

  search_playlists(query, source='all')  -> list of result cards
  preview_playlist(url)                  -> name, cover, track list (no download)
  detect_source(url)                     -> 'youtube' | 'spotify' | None

Spotify has no credential-free search API, so name-search for Spotify
playlists goes through DuckDuckGo (site:open.spotify.com playlist "<q>"),
then each candidate is verified/embellished via the embed scraper already
in utils/spotify.py — everything stays key-free.

Search results are cached in-process for a few minutes (module-level dict)
so re-opening the Discover tab doesn't hammer yt-dlp / DDG.
"""

import re
import time
import threading
import urllib.parse

# ---------------------------------------------------------------- cache ----

_CACHE_TTL = 600          # seconds
_EMPTY_TTL = 120          # seconds, cache true-empty results briefly
_CACHE_MAX = 64
_cache = {}               # key -> (expires_at, value)
_cache_lock = threading.Lock()


class DiscoveryUnavailable(Exception):
    """A discovery backend (e.g. DDG) is temporarily refusing requests."""
    pass


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        if hit:
            _cache.pop(key, None)
    return None


def _cache_set(key, value, ttl=_CACHE_TTL):
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            now = time.time()
            for k in [k for k, (exp, _) in _cache.items() if exp <= now]:
                _cache.pop(k, None)
            if len(_cache) >= _CACHE_MAX:
                _cache.pop(next(iter(_cache)), None)
        _cache[key] = (time.time() + ttl, value)
    return value


# -------------------------------------------------------------- helpers ----

def detect_source(url):
    """Classify a pasted URL as 'youtube' or 'spotify' playlist link."""
    if not url:
        return None
    u = url.strip().lower()
    if 'open.spotify.com' in u or u.startswith('spotify:playlist:'):
        return 'spotify'
    if re.search(r'(youtube\.com/(?:playlist|watch)|music\.youtube\.com|youtu\.be)', u):
        return 'youtube'
    return None


# ------------------------------------------------------ youtube search ----

# YouTube search URL param that filters results to playlists only.
# (double-encoded '=' as yt-dlp expects it on the raw URL)
_YT_PLAYLIST_FILTER = 'EgIQAw%253D%253D'


def search_youtube_playlists(query, limit=8):
    """Search YouTube for PLAYLISTS by name via yt-dlp."""
    key = ('yt', query, limit)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    import yt_dlp

    url = ('https://www.youtube.com/results?search_query='
           + urllib.parse.quote_plus(query)
           + '&sp=' + _YT_PLAYLIST_FILTER)
    opts = {'quiet': True, 'no_warnings': True, 'extract_flat': True}
    results = []
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        print(f"[discovery] youtube search failed: {e}")
        return results

    seen = set()
    for entry in (info or {}).get('entries') or []:
        if not entry:
            continue
        href = entry.get('url') or ''
        m = re.search(r'list=([\w-]+)', href)
        if not m or 'playlist' not in href:
            continue
        list_id = m.group(1)
        if list_id in seen:
            continue
        seen.add(list_id)
        name = (entry.get('title') or '').strip()
        if not name:
            continue
        thumbs = entry.get('thumbnails') or []
        cover = None
        if thumbs:
            best = max(thumbs, key=lambda t: (t.get('width') or 0))
            cover = best.get('url')
        results.append({
            'source': 'youtube',
            'name': name,
            'url': f'https://www.youtube.com/playlist?list={list_id}',
            'channel': entry.get('channel') or entry.get('uploader'),
            'cover': cover,
            'track_count': entry.get('playlist_count'),
        })
        if len(results) >= limit:
            break
    return _cache_set(key, results)


# ------------------------------------------------------- spotify search ----

_SPOTIFY_PLAYLIST_RE = re.compile(
    r'open\.spotify\.com/(?:intl-[a-z]+/)?playlist/([A-Za-z0-9]{16,})')

_SCRAPER_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
               'Firefox/128.0')


def _search_ddg(query):
    """DuckDuckGo HTML endpoint. Returns raw result text/pages or raises."""
    import requests
    resp = requests.get(
        'https://html.duckduckgo.com/html/',
        params={'q': f'site:open.spotify.com playlist "{query}"'},
        headers={'User-Agent': _SCRAPER_UA,
                 'Accept': 'text/html,application/xhtml+xml',
                 'Accept-Language': 'en-US,en;q=0.9'},
        timeout=12)
    if resp.status_code == 202:  # anomaly / bot-check page
        raise DiscoveryUnavailable('duckduckgo rate-limited')
    resp.raise_for_status()
    # DDG wraps result URLs: //duckduckgo.com/l/?uddg=<encoded target>
    targets = [urllib.parse.unquote(t)
               for t in re.findall(r'uddg=([^&"\']+)', resp.text)]
    return targets + [resp.text]


def _search_bing(query):
    """Bing HTML endpoint; result links are base64-wrapped in u=a1 params."""
    import base64
    import requests
    resp = requests.get(
        'https://www.bing.com/search',
        params={'q': f'site:open.spotify.com playlist "{query}"'},
        headers={'User-Agent': _SCRAPER_UA,
                 'Accept': 'text/html,application/xhtml+xml',
                 'Accept-Language': 'en-US,en;q=0.9'},
        timeout=12)
    resp.raise_for_status()
    targets = []
    for u in re.findall(r'u=a1([A-Za-z0-9_\-]+)', resp.text):
        try:
            pad = u + '=' * (-len(u) % 4)
            decoded = base64.urlsafe_b64decode(pad).decode('utf-8', 'ignore')
            if decoded.startswith('http'):
                targets.append(decoded)
        except Exception:  # noqa: BLE001
            continue
    if not targets:
        # no wrapped links at all = probably a consent/challenge page
        raise DiscoveryUnavailable('bing returned no organic links')
    return targets


def _spotify_cover(entity_or_data):
    """Extract a cover URL from a raw embed entity or a fetch_playlist dict."""
    data = entity_or_data or {}
    ca = data.get('coverArt')
    if isinstance(ca, dict):
        src = (ca.get('sources') or [{}])[0].get('url')
        if src:
            return src
    vi = data.get('visualIdentity')
    return (vi or {}).get('coverUrl') or data.get('cover')



_ENGINES = [_search_ddg, _search_bing]


def _spotify_playlist_ids(query):
    """Find Spotify playlist IDs by name via a chain of key-free search
    engines (DDG, then Bing). Returns ordered unique ids. Raises
    DiscoveryUnavailable only when every engine is refusing us."""
    tried, failed = 0, 0
    found, seen = [], set()
    for engine in _ENGINES:
        tried += 1
        try:
            pages = engine(query)
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"[discovery] {engine.__name__} unavailable: {e}")
            continue
        for page in pages:
            for m in _SPOTIFY_PLAYLIST_RE.finditer(page):
                pid = m.group(1)
                if pid not in seen:
                    seen.add(pid)
                    found.append(pid)
        if found:
            break
    if not found and failed == tried:
        raise DiscoveryUnavailable('all Spotify name-search engines refused')
    return found


def _verify_spotify_candidate(pid):
    """Fetch a candidate playlist via the embed scraper for a real card."""
    import requests
    from utils.spotify import SpotifyImporter
    s = SpotifyImporter()
    try:
        resp = requests.get(s.EMBED_URL.format(playlist_id=pid),
                            headers=s.HEADERS, timeout=15)
        resp.raise_for_status()
        entity = s._extract_entity(resp.text)
    except Exception:  # noqa: BLE001
        return None
    if not entity:
        return None
    tracks = entity.get('trackList') or []
    name = entity.get('name') or entity.get('title')
    if not name:
        return None
    return {
        'source': 'spotify',
        'name': name,
        'url': f'https://open.spotify.com/playlist/{pid}',
        'channel': entity.get('subtitle'),
        'cover': _spotify_cover(entity),
        'track_count': len(tracks),
    }


def search_spotify_playlists(query, limit=6, notices=None):
    """Search Spotify playlists by name (DDG scrape + embed verification).

    If DDG bot-checks us, raises DiscoveryUnavailable (callers catch it);
    genuinely-empty lookups are cached briefly so the UI can tell the two
    apart on retry. `notices` optionally collects warning strings."""
    key = ('sp', query, limit)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    try:
        candidates = _spotify_playlist_ids(query)[:limit * 2]
    except DiscoveryUnavailable:
        # don't cache a block — let the next attempt hit fresh; flag it
        if notices is not None:
            notices.append('Spotify name-search is rate-limited right now. '
                           'Try again in a minute, or paste the playlist link.')
        raise

    results = []
    if candidates:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            for card in pool.map(_verify_spotify_candidate, candidates):
                if card:
                    results.append(card)
                if len(results) >= limit:
                    break
    return _cache_set(key, results,
                      ttl=_EMPTY_TTL if not results else _CACHE_TTL)


# ------------------------------------------------------------ dispatch ----

def search_playlists(query, source='all', limit=8):
    """Search playlists by name. source: 'all' | 'youtube' | 'spotify'.

    Returns {'results': [...], 'notices': [...], 'error': str | None}.
    Partial results are normal: if Spotify search is rate-limited the
    YouTube side still returns, with a notice explaining the gap."""
    query = (query or '').strip()
    if not query:
        return {'results': [], 'notices': [], 'error': None}

    notices = []

    if source == 'youtube':
        return {'results': search_youtube_playlists(query, limit=limit),
                'notices': notices, 'error': None}
    if source == 'spotify':
        try:
            results = search_spotify_playlists(query, limit=min(limit, 6),
                                               notices=notices)
            err = None
        except DiscoveryUnavailable as e:
            results, err = [], str(e)
        return {'results': results, 'notices': notices, 'error': err}

    # both, in parallel
    from concurrent.futures import ThreadPoolExecutor

    def _safe_spotify():
        try:
            return search_spotify_playlists(query, limit=min(limit, 6),
                                            notices=notices)
        except DiscoveryUnavailable:
            return None  # notices already carry the reason

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_yt = pool.submit(search_youtube_playlists, query, limit)
        fut_sp = pool.submit(_safe_spotify)
        try:
            yt = fut_yt.result(timeout=60) or []
        except Exception as e:  # noqa: BLE001
            yt = []
            notices.append(f'YouTube search failed: {e}')
        try:
            sp = fut_sp.result(timeout=60) or []
        except Exception:  # noqa: BLE001
            sp = []
            notices.append('Spotify name-search timed out. '
                           'Try again, or paste the playlist link.')
    # interleave so both sources are visible without scrolling
    merged, i = [], 0
    while i < max(len(yt), len(sp)):
        if i < len(yt):
            merged.append(yt[i])
        if i < len(sp):
            merged.append(sp[i])
        i += 1
    return {'results': merged[:limit * 2], 'notices': notices, 'error': None}


# ------------------------------------------------------------- preview ----

_MAX_PREVIEW_TRACKS = 400


def preview_playlist(url, source=None):
    """Inspect a playlist WITHOUT downloading anything.

    Returns {success, source, name, cover, total, note?, tracks:[
      {title, artist, duration, url?}]}.
    """
    source = source or detect_source(url)
    if not source:
        return {'success': False,
                'error': 'Unrecognized URL. Expected a YouTube or Spotify playlist link.'}
    if source == 'spotify':
        return _preview_spotify(url)
    return _preview_youtube(url)


def _preview_spotify(url):
    """Preview via embed entity (same scraper import uses) so the card can
    show the real cover art too."""
    import requests
    from utils.spotify import SpotifyImporter
    s = SpotifyImporter()
    pid = s.parse_playlist_id(url)
    if not pid:
        return {'success': False,
                'error': 'Invalid Spotify playlist URL/ID.'}
    try:
        resp = requests.get(s.EMBED_URL.format(playlist_id=pid),
                            headers=s.HEADERS, timeout=15)
        resp.raise_for_status()
        entity = s._extract_entity(resp.text)
    except Exception as e:  # noqa: BLE001
        return {'success': False, 'error': f'Failed to fetch Spotify playlist: {e}'}
    if not entity:
        return {'success': False,
                'error': 'Could not parse playlist. It may be private or unavailable.'}
    tracks = [{'title': (t.get('title') or '').strip(),
               'artist': s._artist_names(t),
               'duration': (t.get('duration') or 0) // 1000,
               'url': None}
              for t in (entity.get('trackList') or [])[:_MAX_PREVIEW_TRACKS]
              if (t.get('title') or '').strip()]
    out = {'success': True, 'source': 'spotify',
           'name': entity.get('name') or entity.get('title') or 'Playlist',
           'cover': _spotify_cover(entity),
           'total': len(tracks), 'tracks': tracks}
    if len(tracks) >= 50:
        out['note'] = ('Spotify shows the first ~50 tracks here; importing '
                       'creates the same list.')
    return out


def _preview_youtube(url):
    import yt_dlp
    opts = {'quiet': True, 'no_warnings': True, 'extract_flat': 'in_playlist'}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url.strip(), download=False)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if len(msg) > 300:
            msg = msg[:300] + '…'
        return {'success': False, 'error': f'Could not read YouTube playlist: {msg}'}
    if not info or info.get('_type') != 'playlist':
        return {'success': False,
                'error': 'That YouTube link is not a playlist. Import a single track instead.'}

    entries = list(info.get('entries') or [])[:_MAX_PREVIEW_TRACKS]
    tracks = []
    for e in entries:
        if not e:
            continue
        vid = e.get('id')
        href = e.get('url') or (f'https://www.youtube.com/watch?v={vid}' if vid else None)
        tracks.append({
            'title': e.get('title'),
            'artist': (e.get('artist') or e.get('channel')
                       or e.get('uploader') or ''),
            'duration': int(e.get('duration') or 0),
            'url': href,
        })
    covers = [t.get('url') for t in (info.get('thumbnails') or [])
              if isinstance(t, dict) and t.get('url')]
    return {
        'success': True, 'source': 'youtube',
        'name': info.get('title') or 'Playlist',
        'cover': (info.get('thumbnail') or (covers[0] if covers else None)),
        'total': info.get('playlist_count') or len(tracks),
        'tracks': tracks,
        'uploader': info.get('uploader') or info.get('channel'),
        'note': ('YouTube playlists can be large; every listed track will be '
                 'queued for download on import.') if len(tracks) > 50 else None,
    }
