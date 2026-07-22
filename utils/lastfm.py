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
MB_RATE_LIMIT = 1.1  # seconds between MusicBrainz calls (they ask for >= 1s)
_mb_last_call = 0.0


def _lastfm_key():
    return getattr(Config, 'LASTFM_API_KEY', None) or None


def _http_get_json(url, timeout=15):
    """GET a URL and parse JSON. Returns dict or None on any failure."""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Rainy/1.0 (self-hosted music player)',
            'Accept': 'application/json',
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:  # noqa: BLE001
        print(f"[enrich] GET failed {url[:80]}...: {e}")
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
    summary = {'tags': 0, 'similar_artists': 0, 'bio': False, 'mbid': None}

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    # 1. Last.fm track tags
    progress(10, 'Fetching Last.fm tags…')
    lfm_tags = lastfm_track_tags(primary_artist, title)
    if lfm_tags:
        SongTagsModel.replace_for_song(song_id, lfm_tags, 'lastfm')
        summary['tags'] += len(lfm_tags)

    # 2 + 3. Similar artists + bio (cached per artist)
    if primary_artist and not ArtistRelationsModel.has(primary_artist):
        progress(35, 'Fetching similar artists…')
        similar = lastfm_similar_artists(primary_artist)
        if similar:
            ArtistRelationsModel.replace_for_artist(primary_artist, similar)
            summary['similar_artists'] = len(similar)

        progress(55, 'Fetching artist bio…')
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
    progress(75, 'Looking up MusicBrainz…')
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

    progress(100, 'Done')
    return summary
