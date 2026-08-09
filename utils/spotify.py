"""Spotify playlist importer utility.
Fetches public playlist track listings from Spotify's embed page (no API credentials required).
"""

import json
import re

import requests


class SpotifyImporter:
    EMBED_URL = "https://open.spotify.com/embed/playlist/{playlist_id}"
    TRACK_EMBED_URL = "https://open.spotify.com/embed/track/{track_id}"
    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }

    def parse_playlist_id(self, url):
        """Extract playlist ID from various Spotify URL formats.

        Supported formats:
            https://open.spotify.com/playlist/{id}?si=...
            https://open.spotify.com/intl-es/playlist/{id}  (locale prefix)
            spotify:playlist:{id}
            {id} (raw ID)
        """
        url = url.strip()

        match = re.search(r"spotify\.com/(?:[^/]+/)?playlist/([a-zA-Z0-9]+)", url)
        if match:
            return match.group(1)

        match = re.search(r"spotify:playlist:([a-zA-Z0-9]+)", url)
        if match:
            return match.group(1)

        if re.fullmatch(r"[a-zA-Z0-9]{22}", url):
            return url

        return None

    def parse_track_id(self, url):
        """Extract track ID from various Spotify URL formats.

        Supported formats:
            https://open.spotify.com/track/{id}?si=...
            https://open.spotify.com/intl-es/track/{id}  (locale prefix)
            spotify:track:{id}
            {id} (raw ID)
        """
        url = url.strip()

        match = re.search(r"spotify\.com/(?:[^/]+/)?track/([a-zA-Z0-9]+)", url)
        if match:
            return match.group(1)

        match = re.search(r"spotify:track:([a-zA-Z0-9]+)", url)
        if match:
            return match.group(1)

        if re.fullmatch(r"[a-zA-Z0-9]{22}", url):
            return url

        return None

    def fetch_track(self, url):
        """Fetch a single track's title and artist from a Spotify track URL.

        Returns:
            dict with 'success', 'title', 'artist', 'duration_ms', 'spotify_uri'
            on success, or {'success': False, 'error': ...} on failure.
        """
        track_id = self.parse_track_id(url)
        if not track_id:
            return {
                "success": False,
                "error": "Invalid Spotify track URL. Expected format: https://open.spotify.com/track/...",
            }

        try:
            embed_url = self.TRACK_EMBED_URL.format(track_id=track_id)
            resp = requests.get(embed_url, headers=self.HEADERS, timeout=15)
            resp.raise_for_status()
        except requests.RequestException as e:
            return {"success": False, "error": f"Failed to fetch Spotify track: {e}"}

        entity = self._extract_entity(resp.text)
        if entity is None:
            return {
                "success": False,
                "error": "Could not parse track data from Spotify. The track may be unavailable.",
            }

        title = (entity.get("title") or entity.get("name") or "").strip()
        if not title:
            return {"success": False, "error": "Could not determine the track title."}

        return {
            "success": True,
            "title": title,
            "artist": self._artist_names(entity),
            "duration_ms": entity.get("duration") or 0,
            "spotify_uri": entity.get("uri") or "",
        }

    def _artist_names(self, entity):
        """Extract a comma-separated artist string from an entity.

        Tracks expose an 'artists' array; playlist track items use 'subtitle'.
        Deduplicates case-insensitively to avoid 'A, A, A' artefacts.
        """
        def _dedupe(raw):
            seen = set()
            out = []
            for part in str(raw).split(','):
                name = part.strip()
                if not name:
                    continue
                key = name.lower()
                if key not in seen:
                    seen.add(key)
                    out.append(name)
            return ', '.join(out) if out else ''

        artists = entity.get("artists")
        if isinstance(artists, list) and artists:
            names = [a.get("name", "").strip() for a in artists if a.get("name") and a.get("name").strip()]
            # dedupe while preserving order
            seen = set()
            deduped = []
            for n in names:
                key = n.lower()
                if key not in seen:
                    seen.add(key)
                    deduped.append(n)
            if deduped:
                return _dedupe(', '.join(deduped)) or "Unknown Artist"
        raw_sub = (entity.get("subtitle") or "").strip()
        deduped_sub = _dedupe(raw_sub)
        return deduped_sub or "Unknown Artist"

    def fetch_playlist(self, url):
        """Fetch playlist name and track list from a Spotify playlist URL.

        Returns:
            dict with 'success', 'name', and 'tracks' (list of
            {title, artist, duration_ms, spotify_uri}) on success,
            or {'success': False, 'error': ...} on failure.
        """
        playlist_id = self.parse_playlist_id(url)
        if not playlist_id:
            return {
                "success": False,
                "error": "Invalid Spotify playlist URL. Expected format: https://open.spotify.com/playlist/...",
            }

        try:
            embed_url = self.EMBED_URL.format(playlist_id=playlist_id)
            resp = requests.get(embed_url, headers=self.HEADERS, timeout=15)
            resp.raise_for_status()
        except requests.RequestException as e:
            return {"success": False, "error": f"Failed to fetch Spotify playlist: {e}"}

        entity = self._extract_entity(resp.text)
        if entity is None:
            return {
                "success": False,
                "error": "Could not parse playlist data from Spotify. The playlist may be private or unavailable.",
            }

        name = entity.get("title") or entity.get("name") or "Imported Playlist"
        track_list = entity.get("trackList") or []

        tracks = []
        for item in track_list:
            title = (item.get("title") or "").strip()
            if not title:
                continue
            tracks.append({
                "title": title,
                "artist": self._artist_names(item),
                "duration_ms": item.get("duration") or 0,
                "spotify_uri": item.get("uri") or "",
            })

        if not tracks:
            return {"success": False, "error": "No playable tracks found in this playlist."}

        return {"success": True, "name": name, "tracks": tracks}

    def _extract_entity(self, html):
        """Extract the playlist entity from the __NEXT_DATA__ JSON block."""
        match = re.search(
            r'<script\s+id="__NEXT_DATA__"\s+type="application/json">(.*?)</script>',
            html,
            re.DOTALL,
        )
        if not match:
            return None

        try:
            data = json.loads(match.group(1))
            return (
                data.get("props", {})
                .get("pageProps", {})
                .get("state", {})
                .get("data", {})
                .get("entity")
            )
        except (json.JSONDecodeError, AttributeError):
            return None
