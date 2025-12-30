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
    
    def download_playlist(self, url, progress_callback=None):
        """
        Download all audio from a YouTube playlist.
        
        Args:
            url: YouTube or YouTube Music playlist URL
            progress_callback: Optional callback function(current, total, message)
            
        Returns:
            dict with success status, playlist_name, and list of songs
        """
        try:
            import yt_dlp
        except ImportError:
            return {
                'success': False,
                'error': 'yt-dlp not installed. Please run: pip install yt-dlp'
            }
        
        if not self._is_valid_youtube_playlist_url(url):
            return {
                'success': False,
                'error': 'Invalid YouTube playlist URL'
            }
        
        try:
            if progress_callback:
                progress_callback(0, 0, "Fetching playlist information...")
                
            playlist_info = self._extract_playlist_info(url)
            if not playlist_info:
                return {
                    'success': False,
                    'error': 'Could not fetch playlist information'
                }
            
            playlist_name = playlist_info.get('title', 'Imported Playlist')
            video_entries = playlist_info.get('entries', [])
            
            if not video_entries:
                return {
                    'success': False,
                    'error': 'Playlist is empty'
                }
            
            downloaded_songs = []
            total_videos = len(video_entries)
            
            for index, entry in enumerate(video_entries, 1):
                if not entry:
                    continue
                
                video_url = entry.get('url')
                if not video_url:
                    continue
                
                title = entry.get('title', 'Unknown Title')
                if progress_callback:
                    progress_callback(index, total_videos, f"Downloading: {title}")
                
                song_result = self._download_single_with_info(entry)
                
                if song_result.get('success') and song_result.get('file_path'):
                    downloaded_songs.append({
                        'file_path': song_result['file_path'],
                        'title': song_result.get('title'),
                        'artist': song_result.get('artist'),
                        'cover_path': song_result.get('cover_path')
                    })
            
            if not downloaded_songs:
                return {
                    'success': False,
                    'error': 'No songs were downloaded from the playlist'
                }
            
            return {
                'success': True,
                'playlist_name': playlist_name,
                'songs': downloaded_songs,
                'song_count': len(downloaded_songs)
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    def _download_single_with_info(self, info):
        """Download a single video using pre-extracted info (for playlist downloads)."""
        try:
            import yt_dlp
            
            title = info.get('title', 'Unknown Title')
            artist = info.get('artist') or info.get('uploader', 'Unknown Artist')
            thumbnail_url = info.get('thumbnail')
            
            safe_title = self._sanitize_filename(title)
            output_path = os.path.join(self.music_path, f"{safe_title}.mp3")
            
            cover_path = None
            if thumbnail_url:
                cover_path = self._download_thumbnail(thumbnail_url, safe_title)
            
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
            
            ydl_opts['postprocessors'].append({
                'key': 'FFmpegMetadata',
                'add_metadata': True,
            })
            
            video_url = info.get('url')
            if not video_url:
                return {'success': False, 'error': 'No video URL in entry'}
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([video_url])
            
            if os.path.exists(output_path):
                return {
                    'success': True,
                    'file_path': output_path,
                    'title': title,
                    'artist': artist,
                    'cover_path': cover_path
                }
            
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
            
            return {'success': False, 'error': 'File not found after download'}
            
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    def _download_single(self, url):
        """Download a single video (helper for playlist downloads)."""
        try:
            import yt_dlp
            
            with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
                info = ydl.extract_info(url, download=False)
            
            title = info.get('title', 'Unknown Title')
            artist = info.get('artist') or info.get('uploader', 'Unknown Artist')
            thumbnail_url = info.get('thumbnail')
            
            safe_title = self._sanitize_filename(title)
            output_path = os.path.join(self.music_path, f"{safe_title}.mp3")
            
            cover_path = None
            if thumbnail_url:
                cover_path = self._download_thumbnail(thumbnail_url, safe_title)
            
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
            
            ydl_opts['postprocessors'].append({
                'key': 'FFmpegMetadata',
                'add_metadata': True,
            })
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl2:
                ydl2.download([url])
            
            if os.path.exists(output_path):
                return {
                    'success': True,
                    'file_path': output_path,
                    'title': title,
                    'artist': artist,
                    'cover_path': cover_path
                }
            
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
            
            return {'success': False, 'error': 'File not found after download'}
            
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    def _extract_playlist_info(self, url):
        """Extract playlist title and video entries from a playlist URL."""
        try:
            import yt_dlp
            
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': True
            }
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            
            playlist_title = info.get('title', 'Imported Playlist')
            entries = info.get('entries', [])
            
            video_entries = []
            for entry in entries:
                if entry and entry.get('url'):
                    video_id = self._extract_video_id(entry['url'])
                    thumbnail_url = None
                    if video_id:
                        thumbnail_url = f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
                    
                    video_entries.append({
                        'url': entry['url'],
                        'title': entry.get('title'),
                        'thumbnail': thumbnail_url,
                        'uploader': entry.get('uploader'),
                        'artist': entry.get('artist'),
                        'video_id': video_id
                    })
            
            return {
                'title': playlist_title,
                'entries': video_entries
            }
            
        except Exception as e:
            print(f"Error extracting playlist info: {e}")
            return None
    
    def _is_valid_youtube_playlist_url(self, url):
        """Check if URL is a valid YouTube or YouTube Music playlist URL."""
        playlist_patterns = [
            r'(https?://)?(www\.)?youtube\.com/playlist\?list=[\w-]+',
            r'(https?://)?music\.youtube\.com/playlist\?list=[\w-]+',
        ]
        
        for pattern in playlist_patterns:
            if re.match(pattern, url):
                return True
        return False
    
    def _download_thumbnail(self, url, filename):
        """Download thumbnail and save to covers folder."""
        try:
            covers_dir = os.path.join(self.music_path, 'covers')
            os.makedirs(covers_dir, exist_ok=True)
            
            thumbnail_urls = []
            
            if 'i.ytimg.com' in url or 'img.youtube.com' in url:
                video_id = self._extract_video_id(url)
                if video_id:
                    thumbnail_urls = [
                        url,
                        f"https://img.youtube.com/vi/{video_id}/sddefault.jpg",
                        f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
                        f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
                        f"https://img.youtube.com/vi/{video_id}/default.jpg"
                    ]
            else:
                thumbnail_urls = [url]
            
            for thumbnail_url in thumbnail_urls:
                try:
                    response = requests.get(thumbnail_url, timeout=10)
                    if response.status_code == 200 and len(response.content) > 1000:
                        file_hash = hashlib.md5(filename.encode()).hexdigest()
                        cover_filename = f"{file_hash}.jpg"
                        cover_path = os.path.join(covers_dir, cover_filename)
                        
                        with open(cover_path, 'wb') as f:
                            f.write(response.content)
                        
                        return os.path.join('covers', cover_filename)
                except Exception:
                    continue
            
        except Exception as e:
            print(f"Error downloading thumbnail: {e}")
        
        return None
    
    def _extract_video_id(self, url):
        """Extract video ID from URL (video or thumbnail)."""
        # Try to extract from thumbnail URL like https://i.ytimg.com/vi/VIDEO_ID/...
        match = re.search(r'/vi/([a-zA-Z0-9_-]+)/', url)
        if match:
            return match.group(1)
            
        # Try to extract from video URL
        # v=VIDEO_ID
        match = re.search(r'[?&]v=([a-zA-Z0-9_-]+)', url)
        if match:
            return match.group(1)
            
        # youtu.be/VIDEO_ID
        match = re.search(r'youtu\.be/([a-zA-Z0-9_-]+)', url)
        if match:
            return match.group(1)
            
        # shorts/VIDEO_ID
        match = re.search(r'/shorts/([a-zA-Z0-9_-]+)', url)
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
