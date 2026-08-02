"""Free external metadata enrichment: Last.fm tags + MusicBrainz IDs.

Both services are free and keyed on artist + title, so they work for any
audio file regardless of source.

- Last.fm (https://www.last.fm/api/account/create — free key in 30s):
  crowd-sourced genre/mood/style tags, similar artists, artist bios.
  Requires LASTFM_API_KEY in .env. If absent, these steps are skipped.
- MusicBrainz (https://musicbrainz.org — no key needed):
  universal recording MBID + community genre tags. Rate-limited to 1 req/s.
"""
import json
import time
import urllib.parse
import urllib.request

from config import Config

LASTFM_API_BASE = "https://ws.audioscrobbler.com/2.0/"
MUSICBRAINZ_API_BASE = "https://musicbrainz.org/ws/2/"
MB_RATE_LIMIT = 1.5  # seconds between MusicBrainz calls (they ask for >= 1s;
                     # we do 2 calls/song so 1.5s keeps us safely under)
_mb_last_call = 0.0


# Recognised genre labels used to pick a clean genre from crowd-sourced tags.
# Last.fm tags are free-form (moods, vocalists, years...), so we prefer a tag
# that matches a known genre and only fall back to the top tag otherwise.
KNOWN_GENRES = {
    'rock', 'pop', 'hip hop', 'hip-hop', 'rap', 'jazz', 'blues', 'country',
    'folk', 'electronic', 'dance', 'house', 'techno', 'trance', 'dubstep',
    'drum and bass', 'dnb', 'ambient', 'chillout', 'chillwave', 'lo-fi',
    'lofi', 'metal', 'heavy metal', 'death metal', 'black metal', 'punk',
    'hardcore', 'indie', 'indie rock', 'indie pop', 'alternative',
    'alternative rock', 'classic rock', 'progressive rock', 'psychedelic',
    'psychedelic rock', 'funk', 'soul', 'rnb', 'r&b', 'disco', 'reggae',
    'ska', 'latin', 'reggaeton', 'salsa', 'bossa nova', 'classical',
    'opera', 'soundtrack', 'score', 'new age', 'gospel', 'christian', 'k-pop',
    'kpop', 'j-pop', 'jpop', 'synthwave', 'vaporwave', 'post-punk', 'punk rock',
    'grunge', 'emo', 'shoegaze', 'dream pop', 'trip hop', 'trip-hop',
    'deep house', 'tech house', 'progressive house', 'electro', 'edm',
    'garage', 'uk garage', 'breakbeat', 'jungle', 'idm', 'experimental',
    'instrumental', 'acoustic', 'piano', 'singer-songwriter', 'swing',
    'big band', 'bebop', 'smooth jazz', 'trap', 'drill', 'grime', 'afrobeat',
    'afrobeats', 'world', 'celtic', 'bluegrass', 'americana', 'surf',
    'post-rock', 'math rock', 'stoner rock', 'doom metal', 'power metal',
    'symphonic metal', 'metalcore', 'pop punk', 'pop rock', 'soft rock',
    'dancehall', 'dub', 'funk carioca', 'phonk', 'hyperpop', 'city pop',
    'disco house', 'nu jazz', 'future bass', 'future funk', 'hardstyle',
    'techno house', 'christmas', 'children', 'comedy', 'spoken word',
}

# Tags that are clearly not genres — avoided when falling back to the top tag.
NON_GENRE_TAGS = {
    'seen live', 'female vocalists', 'male vocalists', 'male vocalist',
    'female vocalist', 'awesome', 'best songs', 'love', 'favourites',
    'favorites', 'chill', 'sad', 'happy', 'summer', 'winter', 'party',
    'road trip', 'workout', 'study', 'sleep', 'romantic', 'sexy', 'energetic',
    'melancholic', 'uplifting', 'catchy', 'groovy', 'smooth', 'mellow',
    'atmospheric', 'epic', 'dreamy', 'dark', 'heavy', 'soft', 'oldies',
    '2000s', '2010s', '2020s', '90s', '80s', '70s', '60s', 'one hit wonder',
    'guilty pleasure', 'underrated', 'overrated', 'legend', 'classic',
}


def _normalize_tag(name):
    """Lowercase + collapse whitespace so tag comparisons are consistent."""
    return ' '.join((name or '').strip().lower().split())


def pick_genre(tags):
    """Pick the best genre label from [(tag_name, weight), ...].

    Returns a clean title-cased genre string, or None if nothing looks like a
    genre. Prefers the strongest tag that matches KNOWN_GENRES; otherwise falls
    back to the strongest tag unless it's an obvious non-genre label.
    """
    if not tags:
        return None
    for name, _weight in tags:
        norm = _normalize_tag(name)
        if norm in KNOWN_GENRES:
            return norm.title()
    top = _normalize_tag(tags[0][0])
    if top and top not in NON_GENRE_TAGS:
        return top.title()
    return None


def _lastfm_key():
    return getattr(Config, 'LASTFM_API_KEY', None) or None


def _http_get_json(url, timeout=15, retries=2):
    """GET a URL and parse JSON. Retries on 503 (rate limit) with backoff.

    Returns dict or None on any failure.
    """
    import urllib.error
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Rainy/1.0 (self-hosted music player)',
                'Accept': 'application/json',
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 503 and attempt < retries:
                # Rate-limited — back off and retry.
                wait = 5 * (attempt + 1)
                print(f"[enrich] 503 from {url[:60]}... retrying in {wait}s "
                      f"(attempt {attempt + 1}/{retries})")
                time.sleep(wait)
                continue
            print(f"[enrich] HTTP {e.code} {url[:80]}...")
            return None
        except Exception as e:  # noqa: BLE001
            print(f"[enrich] GET failed {url[:80]}...: {e}")
            return None
    return None


# ---------------------------------------------------------------------------
# Last.fm
# ---------------------------------------------------------------------------

def lastfm_track_tags(artist, title):
    """Return [(tag_name, weight), ...] for a track, strongest first.

    Last.fm normalises the top tag to 100. Returns [] if no key or no data.
    """
    key = _lastfm_key()
    if not key:
        return []
    params = urllib.parse.urlencode({
        'method': 'track.getTopTags',
        'artist': artist,
        'track': title,
        'api_key': key,
        'format': 'json',
    })
    data = _http_get_json(f"{LASTFM_API_BASE}?{params}")
    if not data or 'toptags' not in data:
        return []
    tags = data['toptags'].get('tag', [])
    return [(t['name'], int(t.get('count', 0))) for t in tags if t.get('name')]


def lastfm_similar_artists(artist, limit=15):
    """Return [(related_artist, similarity), ...] similarity in 0..1."""
    key = _lastfm_key()
    if not key:
        return []
    params = urllib.parse.urlencode({
        'method': 'artist.getSimilar',
        'artist': artist,
        'limit': limit,
        'api_key': key,
        'format': 'json',
    })
    data = _http_get_json(f"{LASTFM_API_BASE}?{params}")
    if not data or 'similarartists' not in data:
        return []
    artists = data['similarartists'].get('artist', [])
    out = []
    for a in artists:
        name = a.get('name')
        try:
            sim = float(a.get('match', 0))
        except (TypeError, ValueError):
            sim = 0.0
        if name:
            out.append((name, sim))
    return out


def lastfm_artist_bio(artist):
    """Return a plain-text artist bio/description, or None."""
    key = _lastfm_key()
    if not key:
        return None
    params = urllib.parse.urlencode({
        'method': 'artist.getInfo',
        'artist': artist,
        'api_key': key,
        'format': 'json',
    })
    data = _http_get_json(f"{LASTFM_API_BASE}?{params}")
    if not data or 'artist' not in data:
        return None
    bio = data['artist'].get('bio', {})
    # Prefer the summary (shorter, no HTML); fall back to content.
    text = (bio.get('summary') or bio.get('content') or '').strip()
    # Strip the Last.fm attribution link that gets appended.
    if 'Read more on Last.fm' in text:
        text = text.split('Read more on Last.fm')[0].strip()
    return text or None


# ---------------------------------------------------------------------------
# MusicBrainz
# ---------------------------------------------------------------------------

def _mb_throttle():
    """Enforce MusicBrainz's 1 req/s rate limit."""
    global _mb_last_call
    elapsed = time.time() - _mb_last_call
    if elapsed < MB_RATE_LIMIT:
        time.sleep(MB_RATE_LIMIT - elapsed)
    _mb_last_call = time.time()


def musicbrainz_recording(artist, title):
    """Look up a recording on MusicBrainz by artist + title.

    Returns (mbid, genre_tags) where mbid is the recording UUID (or None) and
    genre_tags is [(tag, count), ...] from the release/recording tag list.
    """
    _mb_throttle()
    query = f'recording:"{title}" AND artist:"{artist}"'
    params = urllib.parse.urlencode({
        'query': query,
        'fmt': 'json',
        'limit': 1,
    })
    data = _http_get_json(f"{MUSICBRAINZ_API_BASE}recording/?{params}")
    if not data:
        return None, []
    recordings = data.get('recordings', [])
    if not recordings:
        return None, []

    mbid = recordings[0].get('id')
    if not mbid:
        return None, []

    # The search endpoint doesn't include tags; do a second lookup by ID.
    # Recording-level tags are sparse on MusicBrainz (most tagging happens at
    # release/work level), so this often comes back empty — that's fine, the
    # MBID is the primary value here. Last.fm carries the rich tag data.
    _mb_throttle()
    detail_params = urllib.parse.urlencode({'fmt': 'json', 'inc': 'tags+genres'})
    detail = _http_get_json(f"{MUSICBRAINZ_API_BASE}recording/{mbid}?{detail_params}")

    genre_tags = []
    if detail:
        # Prefer curated genres; fall back to raw tags.
        for tag in detail.get('genres', []) or detail.get('tags', []) or []:
            name = tag.get('name')
            count = int(tag.get('count', 0))
            if name:
                genre_tags.append((name, count))

    return mbid, genre_tags


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def enrich_song(song_id, artist, title, on_progress=None):
    """Run all free enrichment for one song.

    Steps:
      1. Last.fm track tags -> song_tags (source=lastfm)
      2. Last.fm similar artists -> artist_relations (cached per artist)
      3. Last.fm artist bio -> artists_metadata.description
      4. MusicBrainz recording -> songs.musicbrainz_id + song_tags (source=musicbrainz)

    Returns a summary dict of what was enriched.
    """
    from models.song_metadata import (
        ArtistRelationsModel,
        SongTagsModel,
        SongMetadataModel,
    )
    from models.database import Database

    primary_artist = (artist or '').split(',')[0].strip()
    summary = {'tags': 0, 'similar_artists': 0, 'bio': False, 'mbid': None, 'genre': None}

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    # 1. Last.fm track tags
    progress(10, 'Fetching genre & mood tags (Last.fm)…')
    lfm_tags = lastfm_track_tags(primary_artist, title)
    if lfm_tags:
        SongTagsModel.replace_for_song(song_id, lfm_tags, 'lastfm')
        summary['tags'] += len(lfm_tags)
        # Backfill a missing genre from the crowd-sourced tags so genre-based
        # browsing/radio works even for files without an embedded genre.
        genre = pick_genre(lfm_tags)
        if genre:
            SongMetadataModel.set_genre_if_missing(song_id, genre)
            summary['genre'] = genre

    # 2 + 3. Similar artists + bio (cached per artist)
    if primary_artist and not ArtistRelationsModel.has(primary_artist):
        progress(35, 'Finding similar artists (Last.fm)…')
        similar = lastfm_similar_artists(primary_artist)
        if similar:
            ArtistRelationsModel.replace_for_artist(primary_artist, similar)
            summary['similar_artists'] = len(similar)

        progress(55, 'Fetching artist bio (Last.fm)…')
        bio = lastfm_artist_bio(primary_artist)
        if bio:
            Database.execute_query(
                """
                INSERT INTO artists_metadata (artist_name, description)
                VALUES (%s, %s)
                ON DUPLICATE KEY UPDATE description = VALUES(description)
                """,
                (primary_artist, bio),
            )
            summary['bio'] = True
    else:
        # Already cached — still count it as covered.
        existing = ArtistRelationsModel.get(primary_artist)
        summary['similar_artists'] = len(existing) if existing else 0

    # 4. MusicBrainz recording MBID + genre tags
    progress(75, 'Looking up MusicBrainz ID & tags…')
    mbid, mb_tags = musicbrainz_recording(primary_artist, title)
    if mbid:
        SongMetadataModel.set_musicbrainz_id(song_id, mbid)
        summary['mbid'] = mbid
    if mb_tags:
        # Normalise MusicBrainz counts to a 0-100 weight relative to the max.
        max_count = max((c for _n, c in mb_tags), default=1) or 1
        normalised = [(n, int(round(c / max_count * 100))) for n, c in mb_tags]
        SongTagsModel.replace_for_song(song_id, normalised, 'musicbrainz')
        summary['tags'] += len(normalised)

    progress(100, 'Done — metadata saved')
    return summary
