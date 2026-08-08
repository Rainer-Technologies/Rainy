"""AI-driven new-music discovery feed.

Pipeline (all local orchestration, LLM does the thinking):
  1. Build a compact taste profile from the user's play history + ratings:
     top artists, top genres, top songs.
  2. LLM generates 6-8 YouTube Music search queries aimed at finding NEW
     songs the user would like (not in their library).
  3. Run each query through the existing YT Music searcher, collect results,
     drop anything already in the library (normalized title+artist match),
     dedupe.
  4. LLM curates: given the candidate list, picks + ranks the best N for the
     user's taste, returning reasons.
  5. Return the ranked feed (each item still carries videoId/cover/duration
     so the existing preview + download machinery works unchanged).

Falls back to heuristic queries (genre + "2025/2026" + top artists) when the
LLM is not configured or fails — the feed never 500s.
"""
import json
import re

from models.database import Database
from models.settings import SettingsModel
from utils.metadata import MetadataSearcher
from models.duplicates import _norm

QUERY_COUNT = 7          # how many search queries the LLM should generate
PER_QUERY = 12           # YT results per query
CANDIDATE_CAP = 60       # hard cap on total candidates collected
CURATE_CAP = 30          # how many candidates the LLM curator sees
FEED_SIZE = 20           # final feed length

# Genre strings that make bad YouTube searches on their own
_BAD_GENRES = {'music', 'gaming', 'various', 'unknown', 'other'}


def _primary_artist(artist):
    return (artist or '').split(',')[0].strip()


def _taste_profile(user_id):
    """Compact, LLM-friendly summary of what the user listens to."""
    plays = Database.execute_query(
        """
        SELECT s.id, s.title, s.artist, s.genre,
               COUNT(*) AS plays, MAX(ph.played_at) AS last_played
        FROM play_history ph
        JOIN songs s ON s.id = ph.song_id
        WHERE ph.user_id = %s
        GROUP BY s.id, s.title, s.artist, s.genre
        ORDER BY plays DESC, last_played DESC
        """, (user_id,), fetch_all=True,
    ) or []

    liked = Database.execute_query(
        """
        SELECT s.title, s.artist, s.genre
        FROM song_ratings sr JOIN songs s ON s.id = sr.song_id
        WHERE sr.user_id = %s AND sr.rating = 'like'
        """, (user_id,), fetch_all=True,
    ) or []

    genre_counts, artist_counts, top_songs = {}, {}, []
    for p in plays:
        g = (p.get('genre') or '').strip()
        if g and g not in _BAD_GENRES:
            genre_counts[g] = genre_counts.get(g, 0) + p['plays']
        a = _primary_artist(p.get('artist'))
        if a:
            artist_counts[a] = artist_counts.get(a, 0) + p['plays']
        top_songs.append(f"{p['title']} by {p['artist'][:60]}")

    top_genres = sorted(genre_counts, key=genre_counts.get, reverse=True)[:6]
    top_artists = sorted(artist_counts, key=artist_counts.get, reverse=True)[:8]

    liked_str = '; '.join(
        f"{l['title']} - {l['artist'][:50]}" for l in liked[:15]) or 'none'

    return {
        'top_genres': top_genres,
        'top_artists': top_artists,
        'top_songs': top_songs[:10],
        'liked_songs': liked_str,
    }


def _profile_text(profile):
    return (
        "TOP GENRES: " + (', '.join(profile['top_genres']) or 'unknown') + "\n"
        "TOP ARTISTS: " + (', '.join(profile['top_artists']) or 'unknown') + "\n"
        "MOST PLAYED SONGS: " + ('; '.join(profile['top_songs']) or 'unknown') + "\n"
        "LIKED SONGS: " + profile['liked_songs']
    )


def _compact_profile_text(profile):
    """Short profile (genres + artists only) for steps that don't need songs."""
    return (
        "TOP GENRES: " + (', '.join(profile['top_genres']) or 'unknown') + "\n"
        "TOP ARTISTS: " + (', '.join(profile['top_artists']) or 'unknown')
    )


def _llm_queries(profile):
    """Ask the LLM for search queries; returns list of strings or []."""
    from utils import ai_client
    if not ai_client.is_configured():
        return []
    prompt = f"""You are a music discovery expert. A user has this listening profile:

{_profile_text(profile)}

Your job: generate {QUERY_COUNT} YouTube Music SEARCH QUERIES that will find NEW
songs the user would enjoy — music they probably do NOT already have. Mix of:
- niche/genre searches ("reggaeton romántico 2026", "latin trap similar to X")
- artist-adjacent searches (artists similar to their top artists)
- mood/style searches derived from their most-played songs
Do NOT include the user's own artist names verbatim as the whole query (their
library already has those); prefer "similar to X" or genre-adjacent phrasing.
Return ONLY a JSON object: {{"queries": ["...", ...]}}"""
    try:
        out = ai_client.chat_json(
            [{'role': 'user', 'content': prompt}], max_tokens=4096)
        queries = out.get('queries') if isinstance(out, dict) else None
        if not isinstance(queries, list):
            return []
        return [q for q in queries if isinstance(q, str) and q.strip()][:QUERY_COUNT]
    except Exception as e:  # noqa: BLE001
        print(f"[discover-feed] LLM query generation failed: {e}")
        return []


def _heuristic_queries(profile):
    """No-LLM fallback: genre+year and artist-adjacent searches."""
    queries = []
    for g in profile['top_genres'][:3]:
        queries.append(f"{g} 2026")
        queries.append(f"{g} 2025")
    for a in profile['top_artists'][:3]:
        queries.append(f"songs similar to {a}")
    return queries[:QUERY_COUNT] or ['new music 2026']


def _search_and_filter(queries, user_id):
    """Run queries, drop in-library + disliked, dedupe; returns list of dicts."""
    searcher = MetadataSearcher()

    disliked_ids = set()
    try:
        from models.song_rating import SongRatingModel
        disliked_ids = set(SongRatingModel.get_disliked_song_ids(user_id))
    except Exception:  # noqa: BLE001
        pass

    lib_rows = Database.execute_query(
        "SELECT id, title, artist FROM songs", fetch_all=True) or []
    lib_index = {}
    for row in lib_rows:
        key = _norm(row.get('title')) + '||' + _norm(row.get('artist'))
        lib_index.setdefault(key, row['id'])

    seen_vids, seen_keys, results = set(), set(), []
    for q in queries:
        try:
            found = searcher.search(q, limit=PER_QUERY)
        except Exception as e:  # noqa: BLE001
            print(f"[discover-feed] search '{q}' failed: {e}")
            continue
        for s in found:
            vid = s.get('videoId')
            if not vid or vid in seen_vids:
                continue
            title = (s.get('title') or '').strip()
            # Skip hour-long DJ mixes / compilations — they're not songs.
            if _is_mix_title(title) or (s.get('duration') or 0) > 900:
                continue
            key = _norm(title) + '||' + _norm(s.get('artist'))
            if key in seen_keys or key in lib_index:
                continue  # already in feed or already in library
            seen_vids.add(vid)
            seen_keys.add(key)
            results.append(s)
    return results


_MIX_TITLE_RE = re.compile(
    r'\b(mix|mega mix|megamix|enganchado|sesi[oó]n|live|en vivo|cover|'
    r'karaoke|remix compilation|top hits|grandes exitos|best of|'
    r'party mix|perreo mix)\b',
    re.IGNORECASE,
)


def _is_mix_title(title):
    """True for compilation/mix/live titles that aren't a single song."""
    if not title:
        return True
    low = title.lower()
    m = _MIX_TITLE_RE.search(low)
    if m:
        # "X (Remix)" featuring artists is a real song — only flag when the
        # mix/cover word starts the title or appears standalone.
        return m.start() <= 3
    return False


def _pre_rank(profile, candidates):
    """Local heuristic ranking so the LLM curator sees the best candidates.

    Scores by: artist in the user's top artists, genre match, and title
    quality. Keeps the LLM's job to the top `CURATE_CAP` instead of whatever
    order the searches happened to return.
    """
    top_artists = {a.lower() for a in profile['top_artists']}
    top_genres = {g.lower() for g in profile['top_genres']}

    def score(c):
        s = 0.0
        artist = (c.get('artist') or '').lower()
        if any(ta in artist for ta in top_artists):
            s += 3.0
        # Genre guess: check the album name + artist against top genres is
        # unreliable, so weight artist match heavily and title length lightly
        # (long titles are often mixes/remixes even after filtering).
        title = c.get('title') or ''
        if len(title) > 60:
            s -= 1.0
        if any(g in title.lower() for g in top_genres):
            s += 0.5
        return s

    return sorted(candidates, key=score, reverse=True)


def _llm_curate(profile, candidates):
    """LLM picks + ranks the best candidates; returns ordered list of dicts."""
    from utils import ai_client
    if not candidates:
        return []
    if not ai_client.is_configured():
        return candidates[:FEED_SIZE]

    candidates = _pre_rank(profile, candidates)

    # Compact candidate list for the model. Keep it SHORT — reasoning models
    # burn tokens on thinking; a 60-item list blows the budget and returns
    # truncated JSON. 30 items + reasoning_effort low + 8192 tokens works.
    listing = []
    for i, c in enumerate(candidates[:CURATE_CAP]):
        listing.append(
            f"{i}. {c['title']} — {c['artist']} ({c.get('album') or '?'}, "
            f"{c.get('year') or '?'})")
    listing_str = '\n'.join(listing)

    prompt = f"""You are a music curator. The user's taste profile:

{_compact_profile_text(profile)}

Candidate songs found online (index. title — artist (album, year)):

{listing_str}

Pick the {FEED_SIZE} best matches for this user's taste and rank them best-first.
Prefer songs that fit their top genres/artists/moods. Skip mixes, remixes of
songs they already have, live/cover versions, and duplicates of the same song.
Return ONLY a JSON object:
{{"picks": [{{"index": 3, "reason": "short why"}}, ...]}}"""
    try:
        out = ai_client.chat_json(
            [{'role': 'user', 'content': prompt}], max_tokens=8192, timeout=180)
        picks = out.get('picks') if isinstance(out, dict) else None
        if not isinstance(picks, list):
            return candidates[:FEED_SIZE]
        ranked = []
        for p in picks:
            if not isinstance(p, dict):
                continue
            idx = p.get('index')
            try:
                idx = int(idx)
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(candidates):
                item = dict(candidates[idx])
                item['reason'] = str(p.get('reason') or '')[:160]
                ranked.append(item)
        if ranked:
            return ranked[:FEED_SIZE]
    except Exception as e:  # noqa: BLE001
        print(f"[discover-feed] LLM curation failed: {e}")
    return candidates[:FEED_SIZE]


def build_feed(user_id, limit=FEED_SIZE):
    """Full discovery feed: LLM queries -> YT search -> LLM curation."""
    profile = _taste_profile(user_id)
    if not profile['top_artists'] and not profile['top_genres']:
        return [], {'error': 'Not enough listening history yet — play a few songs first.'}

    queries = _llm_queries(profile) or _heuristic_queries(profile)
    candidates = _search_and_filter(queries, user_id)
    ranked = _llm_curate(profile, candidates)

    feed = []
    for i, s in enumerate(ranked[:limit]):
        feed.append({
            'videoId': s.get('videoId'),
            'title': s.get('title'),
            'artist': s.get('artist'),
            'album': s.get('album'),
            'year': s.get('year'),
            'duration': s.get('duration'),
            'duration_text': s.get('duration_text'),
            'cover_url': s.get('cover_url'),
            'in_library': False,
            'reason': s.get('reason', ''),
        })
    return feed, {'queries': queries, 'candidates': len(candidates)}
