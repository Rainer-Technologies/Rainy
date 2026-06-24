"""
Metadata search utility using ytmusicapi
Provides song metadata search from YouTube Music
"""

from ytmusicapi import YTMusic
import requests
import os
import hashlib



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


class MetadataSearcher:
    def __init__(self):
        """Initialize the YouTube Music API client."""
        self.ytmusic = YTMusic()
    
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
                    
                # Extract artist names
                artists = result.get('artists', [])
                artist_names = ', '.join([a.get('name', '') for a in artists if a.get('name')])
                
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
