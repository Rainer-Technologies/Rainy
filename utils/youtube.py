"""YouTube downloader utility for importing music from YouTube/YouTube Music."""

import os
import re
import hashlib
import requests


class YouTubeDownloader:
    def __init__(self, music_path):
        self.music_path = music_path
    
    def download(self, url):
        """
        Download audio from a YouTube URL.
        
        Args:
            url: YouTube or YouTube Music URL
            
        Returns:
            dict with success status, file_path, title, artist, cover_path
        """
        try:
            import yt_dlp
        except ImportError:
            return {
                'success': False,
                'error': 'yt-dlp not installed. Please run: pip install yt-dlp'
            }
        
        if not self._is_valid_youtube_url(url):
            return {
                'success': False,
                'error': 'Invalid YouTube URL'
            }
        
        try:
            # First extract info to get metadata and thumbnail
            with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
                info = ydl.extract_info(url, download=False)
            
            title = info.get('title', 'Unknown Title')
            artist = info.get('artist') or info.get('uploader', 'Unknown Artist')
            thumbnail_url = info.get('thumbnail')
            
            # Clean filename
            safe_title = self._sanitize_filename(title)
            output_path = os.path.join(self.music_path, f"{safe_title}.mp3")
            
            # Download thumbnail to covers folder
            cover_path = None
            if thumbnail_url:
                cover_path = self._download_thumbnail(thumbnail_url, safe_title)
            
            # Configure yt-dlp options for audio download
            ydl_opts = {
                'format': 'bestaudio/best',
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '320',
                }],
                'outtmpl': os.path.join(self.music_path, f"{safe_title}.%(ext)s"),
                'quiet': True,
                'no_warnings': True,
            }
            
            # Add metadata embedding
            ydl_opts['postprocessors'].append({
                'key': 'FFmpegMetadata',
                'add_metadata': True,
            })
            
            # Download audio
            with yt_dlp.YoutubeDL(ydl_opts) as ydl2:
                ydl2.download([url])
            
            # Find the downloaded file
            if os.path.exists(output_path):
                return {
                    'success': True,
                    'file_path': output_path,
                    'title': title,
                    'artist': artist,
                    'cover_path': cover_path
                }
            else:
                # Try to find the downloaded file with different extensions
                for ext in ['.mp3', '.m4a', '.webm', '.opus']:
                    check_path = os.path.join(self.music_path, f"{safe_title}{ext}")
                    if os.path.exists(check_path):
                        return {
                            'success': True,
                            'file_path': check_path,
                            'title': title,
                            'artist': artist,
                            'cover_path': cover_path
                        }
                
                return {
                    'success': False,
                    'error': 'Download completed but file not found'
                }
                    
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    def _download_thumbnail(self, url, filename):
        """Download thumbnail and save to covers folder."""
        try:
            # Create covers directory
            covers_dir = os.path.join(self.music_path, 'covers')
            os.makedirs(covers_dir, exist_ok=True)
            
            # Get high-resolution thumbnail
            # YouTube thumbnails can be modified to get higher res
            high_res_url = url
            if 'i.ytimg.com' in url or 'img.youtube.com' in url:
                # Try to get maxresdefault
                video_id = self._extract_video_id(url)
                if video_id:
                    high_res_url = f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
            
            # Download the image
            response = requests.get(high_res_url, timeout=10)
            
            # If maxres fails, try the original URL
            if response.status_code != 200:
                response = requests.get(url, timeout=10)
            
            if response.status_code == 200:
                # Generate filename from hash
                file_hash = hashlib.md5(url.encode()).hexdigest()
                cover_filename = f"{file_hash}.jpg"
                cover_path = os.path.join(covers_dir, cover_filename)
                
                with open(cover_path, 'wb') as f:
                    f.write(response.content)
                
                # Return relative path from music_path
                return os.path.join('covers', cover_filename)
            
        except Exception as e:
            print(f"Error downloading thumbnail: {e}")
        
        return None
    
    def _extract_video_id(self, url):
        """Extract video ID from thumbnail URL."""
        # Try to extract from URL like https://i.ytimg.com/vi/VIDEO_ID/...
        match = re.search(r'/vi/([a-zA-Z0-9_-]+)/', url)
        if match:
            return match.group(1)
        return None
    
    def _is_valid_youtube_url(self, url):
        """Check if URL is a valid YouTube or YouTube Music URL."""
        youtube_patterns = [
            r'(https?://)?(www\.)?youtube\.com/watch\?v=[\w-]+',
            r'(https?://)?(www\.)?youtu\.be/[\w-]+',
            r'(https?://)?music\.youtube\.com/watch\?v=[\w-]+',
            r'(https?://)?(www\.)?youtube\.com/shorts/[\w-]+',
        ]
        
        for pattern in youtube_patterns:
            if re.match(pattern, url):
                return True
        return False
    
    def _sanitize_filename(self, filename):
        """Remove invalid characters from filename."""
        # Remove invalid characters for Windows/Linux/Mac
        invalid_chars = '<>:"/\\|?*'
        for char in invalid_chars:
            filename = filename.replace(char, '')
        
        # Remove leading/trailing spaces and dots
        filename = filename.strip(' .')
        
        # Limit length
        if len(filename) > 200:
            filename = filename[:200]
        
        return filename
