"""
Metadata search utility using ytmusicapi
Provides song metadata search from YouTube Music
"""

from ytmusicapi import YTMusic
import requests
import os
import hashlib
from concurrent.futures import ThreadPoolExecutor



def resize_google_cover(url, size=544):
    """
    Resize Google-hosted cover art URLs (googleusercontent.com/ggpht.com).
    Leaves standard YouTube/ytimg.com URLs intact.
    """
    if not url:
        return url
    if 'googleusercontent.com' not in url and 'ggpht.com' not in url:
        return url
        
    import re
    if '=' in url:
        # Split at first '=' and append size modifier
        base = url.split('=', 1)[0]
        return f"{base}=w{size}-h{size}-rj"
        
    # Match modifiers like -w120-h120 or -s120 at the end of the URL
    pattern = r'-[ws]\d+(?:-h\d+)?(?:-[a-zA-Z0-9-]+)*$'
    if re.search(pattern, url):
        base = re.sub(pattern, '', url)
        return f"{base}=w{size}-h{size}-rj"
        
    return f"{url}=w{size}-h{size}-rj"


_ytm_client = None


def _get_ytm():
    """Return a process-wide YTMusic client (it does a network call on init)."""
    global _ytm_client
    if _ytm_client is None:
        _ytm_client = YTMusic()
    return _ytm_client


class MetadataSearcher:
    def __init__(self):
        """Initialize the YouTube Music API client."""
        self.ytmusic = _get_ytm()
    
    def search(self, query, limit=10):
        """
        Search for songs on YouTube Music.
        
        Args:
            query: Search term (song title, artist, etc.)
            limit: Maximum number of results to return
            
        Returns:
            List of song metadata dictionaries
        """
        try:
            results = self.ytmusic.search(query, filter="songs", limit=limit)
            
            songs = []
            for result in results:
                if result.get('resultType') != 'song':
                    continue
                    
                # Extract artist names (deduplicate — YTMusic can return the same
                # artist multiple times for e.g. "Magic" by John Michael Howell)
                artists = result.get('artists', [])
                raw_names = [a.get('name', '').strip() for a in artists if a.get('name') and a.get('name').strip()]
                seen_meta = set()
                deduped_names = []
                for n in raw_names:
                    key = n.lower()
                    if key not in seen_meta:
                        seen_meta.add(key)
                        deduped_names.append(n)
                artist_names = ', '.join(deduped_names)
                
                # Extract album info
                album = result.get('album', {})
                album_name = album.get('name', '') if album else ''
                
                # Extract thumbnail (prefer highest quality)
                thumbnails = result.get('thumbnails', [])
                cover_url = None
                if thumbnails:
                    base_url = thumbnails[-1].get('url')
                    if base_url:
                        cover_url = resize_google_cover(base_url, size=544)
                
                # Extract duration
                duration_text = result.get('duration', '0:00')
                duration_seconds = self._parse_duration(duration_text)
                
                # Extract year from album if available
                year = result.get('year', '')
                
                songs.append({
                    'videoId': result.get('videoId', ''),
                    'title': result.get('title', ''),
                    'artist': artist_names or 'Unknown Artist',
                    'album': album_name or 'Unknown Album',
                    'year': year,
                    'duration': duration_seconds,
                    'duration_text': duration_text,
                    'cover_url': cover_url
                })
            
            return songs
            
        except Exception as e:
            print(f"Error searching YouTube Music: {e}")
            return []

    def get_artist_info(self, artist_name):
        """
        Look up an artist on YouTube Music and return a description + image.

        Picks the best single match (exact case-insensitive name, otherwise first hit).
        Returns None when nothing usable is found.
        """
        try:
            candidates = self.search_artist_candidates(artist_name, limit=5)
            if not candidates:
                return None
            name = (artist_name or '').strip().lower()
            best = next(
                (c for c in candidates if (c.get('name') or '').lower() == name),
                candidates[0],
            )
            return {
                'description': best.get('description') or '',
                'image_url': best.get('image_url') or '',
                'source_title': best.get('name') or '',
                'source_url': best.get('source_url') or '',
            }
        except Exception as e:
            print(f"Error fetching artist info from YouTube Music: {e}")
            return None

    def search_artist_candidates(self, artist_name, limit=5):
        """
        Search YouTube Music for an artist and return the top candidates, each with
        its full description and thumbnail pre-fetched in parallel.

        Returns a list of dicts:
            [{name, channel_id, image_url, description, source_url}, ...]
        Returns [] when there are no results.
        """
        try:
            ytm = _get_ytm()
            name = (artist_name or '').strip()
            if not name:
                return []

            results = ytm.search(name, filter="artists", limit=limit) or []
            if not results:
                return []

            def fetch_candidate(r):
                channel_id = (r.get('browseId') or '').strip()
                if not channel_id:
                    return None
                thumbs = r.get('thumbnails') or []
                candidate = {
                    'name': (r.get('artist') or '').strip(),
                    'channel_id': channel_id,
                    'image_url': (thumbs[-1].get('url') if thumbs else '') or '',
                    'description': '',
                    'source_url': f"https://music.youtube.com/channel/{channel_id}",
                }
                try:
                    page = ytm.get_artist(channel_id) or {}
                    desc = (page.get('description') or '').strip()
                    if desc:
                        paras = [p.strip() for p in desc.split('\n') if p.strip()]
                        candidate['description'] = '\n\n'.join(paras[:3])
                    if not candidate['image_url'] and page.get('thumbnails'):
                        candidate['image_url'] = page['thumbnails'][-1].get('url') or ''
                    if not candidate['name'] and page.get('name'):
                        candidate['name'] = page['name'].strip()
                except Exception as e:
                    print(f"Could not enrich artist candidate {channel_id}: {e}")
                return candidate

            candidates = []
            with ThreadPoolExecutor(max_workers=max(1, min(limit, 5))) as ex:
                for c in ex.map(fetch_candidate, results):
                    if c:
                        candidates.append(c)
            return candidates
        except Exception as e:
            print(f"Error searching artist candidates: {e}")
            return []

    def _parse_duration(self, duration_text):
        """Convert duration text (e.g., '3:45') to seconds."""
        try:
            parts = duration_text.split(':')
            if len(parts) == 2:
                return int(parts[0]) * 60 + int(parts[1])
            elif len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
            return 0
        except (ValueError, AttributeError):
            return 0
    
    def download_cover(self, url, save_dir, filename=None):
        """
        Download cover art from URL and save to specified directory.
        
        Args:
            url: URL of the cover image
            save_dir: Directory to save the image
            filename: Optional filename (without extension). If not provided, will use hash of URL.
            
        Returns:
            Path to saved file, or None if download failed
        """
        if not url:
            return None
            
        try:
            # Ensure we're downloading high-resolution images
            # Modify YouTube Music thumbnail URLs to request larger size
            download_url = resize_google_cover(url, size=1200)
            
            # Create covers directory if it doesn't exist
            covers_dir = os.path.join(save_dir, 'covers')
            os.makedirs(covers_dir, exist_ok=True)
            
            # Generate filename from URL hash if not provided
            if not filename:
                filename = hashlib.md5(url.encode()).hexdigest()
            
            # Determine file extension (default to jpg)
            ext = '.jpg'
            if '.png' in url.lower():
                ext = '.png'
            elif '.webp' in url.lower():
                ext = '.webp'
            
            filepath = os.path.join(covers_dir, f"{filename}{ext}")
            
            # Download the image
            response = requests.get(download_url, timeout=10)
            response.raise_for_status()
            
            with open(filepath, 'wb') as f:
                f.write(response.content)
            
            # Return relative path from save_dir
            return os.path.join('covers', f"{filename}{ext}")
            
        except Exception as e:
            print(f"Error downloading cover: {e}")
            return None
