import os
import hashlib
from datetime import datetime
from mutagen import File as MutagenFile
from mutagen.mp3 import MP3
from mutagen.flac import FLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.mp4 import MP4
from mutagen.wave import WAVE
from config import Config


def normalize_artist(raw):
    """Deduplicate a comma-separated artist string (case-insensitive, preserve order)."""
    if not raw or not str(raw).strip():
        return 'Unknown Artist'
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
    return ', '.join(out) if out else 'Unknown Artist'


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
            full_scan: If True, re-read the tags of every file (modified or
                      not). If False, only add new files and update modified
                      ones. Either way rows are updated in place, so song ids
                      and everything keyed on them (playlists, ratings,
                      history, per-account library access) survive.
        
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
            existing_songs = SongModel.get_songs_with_file_info()
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
                            
                            # Compare modification times (a full scan
                            # re-reads every file regardless).
                            if full_scan or (existing_modified and file_modified):
                                if full_scan or file_modified > existing_modified:
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
                            song_id = SongModel.add_song(metadata)
                            stats['files_added'] += 1
                            # Scanned songs go to the admin library; regular
                            # accounts get them once a sysadmin publishes them.
                            try:
                                from models.library_access import LibraryAccessModel
                                LibraryAccessModel.on_scan_added([song_id])
                            except Exception:
                                pass
                            # Queue background enrichment (audio analysis +
                            # local genre classification + external tags).
                            # Best-effort — never let it break a scan.
                            try:
                                from models.enrichment_job import EnrichmentJobModel
                                from utils import enrichment_worker
                                EnrichmentJobModel.enqueue_song(song_id)
                                enrichment_worker.notify()
                            except Exception as e:  # noqa: BLE001
                                print(f"[scanner] failed to queue enrichment for song {song_id}: {e}")
                            # Light show score (beat grid, sections, drops…).
                            from utils import lightshow_worker
                            lightshow_worker.enqueue_song(song_id)
                            # Lyrics: look them up on LRCLIB and time every word.
                            from utils import lyrics_worker
                            lyrics_worker.enqueue_song(song_id)
            
            # Remove songs that no longer exist on disk
            if existing_songs:
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
                raw_artist = self._get_tag(audio, 'artist', metadata['artist'])
                metadata['artist'] = normalize_artist(raw_artist)
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
        
        # Extract embedded cover art
        try:
            cover_path = self._extract_cover_art(file_path)
            if cover_path:
                metadata['cover_path'] = cover_path
        except Exception as e:
            print(f"Warning: Could not extract cover art from {file_path}: {e}")
        
        return metadata
    
    def _extract_cover_art(self, file_path):
        """Extract embedded cover art from an audio file and save it to the covers directory.
        
        Supports ID3 APIC (MP3), FLAC pictures, MP4 covr atoms, and OGG metadata blocks.
        Returns a relative path like 'covers/<hash>.jpg' or None if no art is found.
        """
        audio = MutagenFile(file_path)
        if audio is None:
            return None
        
        image_data = None
        mime = 'image/jpeg'
        
        ext = os.path.splitext(file_path)[1].lower()
        
        if ext == '.mp3' or ext == '.wav':
            # ID3 APIC frames
            if hasattr(audio, 'tags') and audio.tags:
                for key in audio.tags:
                    if key.startswith('APIC'):
                        apic = audio.tags[key]
                        image_data = apic.data
                        mime = apic.mime or 'image/jpeg'
                        break
        
        elif ext == '.flac':
            # FLAC pictures
            if hasattr(audio, 'pictures') and audio.pictures:
                pic = audio.pictures[0]
                image_data = pic.data
                mime = pic.mime or 'image/jpeg'
        
        elif ext in ('.m4a', '.mp4', '.aac'):
            # MP4 covr atom
            if hasattr(audio, 'tags') and audio.tags:
                covr = audio.tags.get('covr')
                if covr:
                    image_data = bytes(covr[0])
                    # Detect format from magic bytes
                    if image_data[:8] == b'\x89PNG\r\n\x1a\n':
                        mime = 'image/png'
                    elif image_data[:4] == b'RIFF':
                        mime = 'image/webp'
                    else:
                        mime = 'image/jpeg'
        
        elif ext == '.ogg':
            # OGG metadata_block_picture (base64-encoded)
            if hasattr(audio, 'tags') and audio.tags:
                import base64 as b64
                pictures = audio.tags.get('metadata_block_picture')
                if pictures:
                    from mutagen.flac import Picture
                    pic = Picture(b64.b64decode(pictures[0]))
                    image_data = pic.data
                    mime = pic.mime or 'image/jpeg'
        
        if not image_data:
            return None
        
        # Determine file extension from MIME type
        ext_map = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/webp': '.webp',
            'image/gif': '.gif',
        }
        img_ext = ext_map.get(mime, '.jpg')
        
        # Use hash of the audio file path as the cover filename for uniqueness
        relative_audio = os.path.relpath(file_path, self.music_path).replace('\\', '/')
        cover_filename = hashlib.md5(relative_audio.encode()).hexdigest()
        
        # Save to covers directory
        covers_dir = os.path.join(self.music_path, 'covers')
        os.makedirs(covers_dir, exist_ok=True)
        
        cover_filepath = os.path.join(covers_dir, f"{cover_filename}{img_ext}")
        
        # Skip writing if the file already exists with the same content
        if os.path.isfile(cover_filepath):
            try:
                with open(cover_filepath, 'rb') as f:
                    if f.read() == image_data:
                        return os.path.join('covers', f"{cover_filename}{img_ext}").replace('\\', '/')
            except OSError:
                pass
        
        with open(cover_filepath, 'wb') as f:
            f.write(image_data)
        
        return os.path.join('covers', f"{cover_filename}{img_ext}").replace('\\', '/')
    
    def _get_tag(self, audio, tag_name, default=None):
        """Safely get a tag value from audio metadata.

        For `artist` we join *all* list entries with ', ' so multi-artist
        collaborations (multiple ARTIST frames / TPE1 values) are preserved.
        Callers are expected to de-duplicate the resulting comma-separated
        string via normalize_artist().
        """
        try:
            if tag_name in audio:
                value = audio[tag_name]
                if isinstance(value, list) and len(value) > 0:
                    # Join every non-empty entry instead of silently dropping
                    # all but the first — otherwise collaborations lose artists
                    # and duplicate frames are not visible for deduplication.
                    parts = [str(v).strip() for v in value if str(v).strip()]
                    if parts:
                        return ', '.join(parts)
                elif value is not None:
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

        # Queue background metadata enrichment (audio analysis + free external
        # tags). Best-effort — never let enrichment break a scan/import.
        try:
            from models.enrichment_job import EnrichmentJobModel
            from utils import enrichment_worker
            EnrichmentJobModel.enqueue_song(song_id)
            enrichment_worker.notify()
        except Exception as e:  # noqa: BLE001
            print(f"[scanner] failed to queue enrichment for song {song_id}: {e}")

        # Queue the light show analysis so the show is synced from the first
        # play. Best-effort (enqueue_song never raises).
        from utils import lightshow_worker
        lightshow_worker.enqueue_song(song_id)

        # Same for lyrics: fetch them from LRCLIB and time every word, so
        # freshly imported / downloaded songs come with synced lyrics.
        from utils import lyrics_worker
        lyrics_worker.enqueue_song(song_id)

        return metadata
    
    def format_duration(self, seconds):
        """Format duration in seconds to MM:SS format."""
        if not seconds:
            return "0:00"
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes}:{secs:02d}"

