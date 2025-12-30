import os
from datetime import datetime
from mutagen import File as MutagenFile
from mutagen.mp3 import MP3
from mutagen.flac import FLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.mp4 import MP4
from mutagen.wave import WAVE
from config import Config


class MusicScanner:
    def __init__(self, music_path):
        self.music_path = music_path
        self.supported_formats = Config.SUPPORTED_FORMATS
    
    def scan(self):
        """Scan the music directory and return a list of songs with metadata."""
        songs = []
        
        for root, dirs, files in os.walk(self.music_path):
            for filename in files:
                ext = os.path.splitext(filename)[1].lower()
                if ext in self.supported_formats:
                    full_path = os.path.join(root, filename)
                    relative_path = os.path.relpath(full_path, self.music_path)
                    
                    metadata = self._extract_metadata(full_path, filename)
                    metadata['id'] = relative_path.replace('\\', '/')
                    metadata['path'] = relative_path.replace('\\', '/')
                    
                    songs.append(metadata)
        
        # Sort by artist, then album, then track number
        songs.sort(key=lambda x: (
            x.get('artist', '').lower(),
            x.get('album', '').lower(),
            x.get('track', 0)
        ))
        
        return songs
    
    def scan_to_database(self, full_scan=False):
        """
        Scan music directory and save results to database.
        
        Args:
            full_scan: If True, delete all existing songs and rescan everything.
                      If False, only add new files and update modified ones.
        
        Returns:
            dict with scan statistics (files_found, files_added, files_updated, files_removed)
        """
        from models.song import SongModel, ScanHistoryModel
        
        scan_type = 'full' if full_scan else 'quick'
        scan_id = ScanHistoryModel.start_scan(scan_type)
        
        stats = {
            'files_found': 0,
            'files_added': 0,
            'files_updated': 0,
            'files_removed': 0
        }
        
        try:
            if full_scan:
                # Delete all existing songs for full rescan
                SongModel.delete_all_songs()
            
            # Get existing songs info for incremental scan
            existing_songs = {} if full_scan else SongModel.get_songs_with_file_info()
            found_paths = set()
            
            # Scan the music directory
            for root, dirs, files in os.walk(self.music_path):
                for filename in files:
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in self.supported_formats:
                        full_path = os.path.join(root, filename)
                        relative_path = os.path.relpath(full_path, self.music_path).replace('\\', '/')
                        
                        stats['files_found'] += 1
                        found_paths.add(relative_path)
                        
                        # Get file info
                        try:
                            file_stat = os.stat(full_path)
                            file_size = file_stat.st_size
                            file_modified = datetime.fromtimestamp(file_stat.st_mtime)
                        except OSError:
                            file_size = None
                            file_modified = None
                        
                        # Check if file needs to be added or updated
                        if relative_path in existing_songs:
                            # Check if file was modified
                            existing = existing_songs[relative_path]
                            existing_modified = existing.get('file_modified')
                            
                            # Compare modification times
                            if existing_modified and file_modified:
                                if file_modified > existing_modified:
                                    # File was modified, update it
                                    metadata = self._extract_metadata(full_path, filename)
                                    metadata['path'] = relative_path
                                    metadata['file_size'] = file_size
                                    metadata['file_modified'] = file_modified
                                    # Preserve existing manual metadata when extractor returns defaults/empties
                                    existing_row = SongModel.get_song_by_path(relative_path)
                                    if existing_row:
                                        default_title = os.path.splitext(filename)[0]
                                        if not metadata.get('title') or str(metadata.get('title')).strip() == '':
                                            metadata['title'] = existing_row.get('title')
                                        elif str(metadata.get('title')).strip() == default_title and existing_row.get('title'):
                                            metadata['title'] = existing_row.get('title')
                                        
                                        if not metadata.get('artist') or metadata.get('artist') == 'Unknown Artist':
                                            metadata['artist'] = existing_row.get('artist') or metadata.get('artist')
                                        
                                        if not metadata.get('album') or metadata.get('album') == 'Unknown Album':
                                            metadata['album'] = existing_row.get('album') or metadata.get('album')
                                        
                                        if metadata.get('track', 0) in (None, 0) and existing_row.get('track_number') is not None:
                                            try:
                                                metadata['track'] = int(existing_row.get('track_number'))
                                            except (TypeError, ValueError):
                                                pass
                                        
                                        if metadata.get('year') is None:
                                            metadata['year'] = existing_row.get('year')
                                        
                                        if metadata.get('genre') is None:
                                            metadata['genre'] = existing_row.get('genre')
                                        
                                        if not metadata.get('cover_path'):
                                            metadata['cover_path'] = existing_row.get('cover_path')
                                    
                                    SongModel.update_song(relative_path, metadata)
                                    stats['files_updated'] += 1
                        else:
                            # New file, add it
                            metadata = self._extract_metadata(full_path, filename)
                            metadata['path'] = relative_path
                            metadata['file_size'] = file_size
                            metadata['file_modified'] = file_modified
                            SongModel.add_song(metadata)
                            stats['files_added'] += 1
            
            # Remove songs that no longer exist on disk (only for quick scan)
            if not full_scan and existing_songs:
                for path in existing_songs:
                    if path not in found_paths:
                        SongModel.delete_song(path)
                        stats['files_removed'] += 1
            
            # Mark scan as completed
            ScanHistoryModel.complete_scan(
                scan_id,
                stats['files_found'],
                stats['files_added'],
                stats['files_updated'],
                stats['files_removed']
            )
            
            return stats
            
        except Exception as e:
            # Mark scan as failed
            ScanHistoryModel.fail_scan(scan_id, str(e))
            raise
    
    def _extract_metadata(self, file_path, filename):
        """Extract metadata from an audio file."""
        metadata = {
            'title': os.path.splitext(filename)[0],
            'artist': 'Unknown Artist',
            'album': 'Unknown Album',
            'duration': 0,
            'track': 0,
            'year': None,
            'genre': None
        }
        
        try:
            audio = MutagenFile(file_path, easy=True)
            
            if audio is None:
                return metadata
            
            # Try to get duration
            if hasattr(audio, 'info') and hasattr(audio.info, 'length'):
                metadata['duration'] = int(audio.info.length)
            
            # Extract common tags
            if audio:
                metadata['title'] = self._get_tag(audio, 'title', metadata['title'])
                metadata['artist'] = self._get_tag(audio, 'artist', metadata['artist'])
                metadata['album'] = self._get_tag(audio, 'album', metadata['album'])
                metadata['genre'] = self._get_tag(audio, 'genre', None)
                metadata['year'] = self._get_tag(audio, 'date', None)
                
                # Track number handling
                track = self._get_tag(audio, 'tracknumber', '0')
                if track:
                    # Handle format like "1/12"
                    if '/' in str(track):
                        track = str(track).split('/')[0]
                    try:
                        metadata['track'] = int(track)
                    except (ValueError, TypeError):
                        metadata['track'] = 0
        
        except Exception as e:
            # If metadata extraction fails, use filename-based metadata
            print(f"Warning: Could not extract metadata from {file_path}: {e}")
        
        return metadata
    
    def _get_tag(self, audio, tag_name, default=None):
        """Safely get a tag value from audio metadata."""
        try:
            if tag_name in audio:
                value = audio[tag_name]
                if isinstance(value, list) and len(value) > 0:
                    return str(value[0])
                return str(value)
        except:
            pass
        return default
    
    def scan_single_file(self, full_path):
        """Scan a single file and add it to the database."""
        from models.song import SongModel
        
        if not os.path.isfile(full_path):
            return None
        
        filename = os.path.basename(full_path)
        relative_path = os.path.relpath(full_path, self.music_path).replace('\\', '/')
        
        # Get file info
        try:
            file_stat = os.stat(full_path)
            file_size = file_stat.st_size
            file_modified = datetime.fromtimestamp(file_stat.st_mtime)
        except OSError:
            file_size = None
            file_modified = None
        
        # Extract metadata
        metadata = self._extract_metadata(full_path, filename)
        metadata['path'] = relative_path
        metadata['file_size'] = file_size
        metadata['file_modified'] = file_modified
        
        # Add to database and get the song ID
        song_id = SongModel.add_song(metadata)
        metadata['id'] = song_id
        
        return metadata
    
    def format_duration(self, seconds):
        """Format duration in seconds to MM:SS format."""
        if not seconds:
            return "0:00"
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes}:{secs:02d}"

