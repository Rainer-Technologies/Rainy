/**
 * Rainy Music Player - Audio Player Controller
 * Handles audio playback, progress, volume, queue, and reactions
 */
import { Logger } from './helper/logger.js';
import { LightShowEngine } from './lightshow.js';
import { usePlaylistService } from './services/playlist.js';
import { useRatingService } from './services/rating.js';
import { useContext } from './helper/context.js';
import { Utils } from './modules/utils.js';

export class AudioPlayer {
    constructor() {
        this.audio = document.getElementById('audio-player');
        this.playlist = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        this.isShuffle = false;
        this.repeatMode = 'none'; // 'none', 'all', 'one'
        this.isBuffering = false;
        this.lastDisplayedTime = 0;
        this.isDraggingProgress = false;
        this.activeProgressBar = null;

        // Playback context tracking
        this.playbackContext = { type: 'library', id: null };
        this.lastSaveTime = 0;
        this.saveThrottleMs = 5000; // Save every 5 seconds
        this.queueModified = false; // Track if queue has been manually modified
        this.queueOperations = []; // Track add/remove operations for efficient storage

        // Likes / Dislikes
        this.likedPlaylistId = null;
        this.likedSongIds = new Set();
        this.likedInitDone = false;
        this.dislikedSongIds = new Set();

        // Lyrics
        this.lyricsActive = false;
        this.lyricsData = null;
        this.lyricsSongId = null;
        this.activeLyricIndex = -1;

        this.init();
    }

    init() {
        this.bindElements();
        this.bindEvents();
        this.loadSettings();
    }

    bindElements() {
        // Buttons
        this.playPauseBtn = document.getElementById('play-pause-btn');
        this.prevBtn = document.getElementById('prev-btn');
        this.nextBtn = document.getElementById('next-btn');
        this.shuffleBtn = document.getElementById('shuffle-btn');
        this.repeatBtn = document.getElementById('repeat-btn');

        // Progress
        this.progressBar = document.getElementById('progress-bar');
        this.progressFill = document.getElementById('progress-fill');
        this.currentTimeEl = document.getElementById('current-time');
        this.totalTimeEl = document.getElementById('total-time');

        // Volume
        this.volumeSlider = document.getElementById('volume-slider');

        // Now playing
        this.nowPlayingTitle = document.getElementById('now-playing-title');
        this.nowPlayingArtist = document.getElementById('now-playing-artist');
        this.nowPlayingArtwork = document.getElementById('now-playing-artwork');
        this.nowPlayingContainer = document.querySelector('.now-playing');
        this.likeBtn = document.getElementById('like-btn');
        this.dislikeBtn = document.getElementById('dislike-btn');

        // Fullscreen Player
        this.fsContainer = document.getElementById('fullscreen-player');
        this.fsBackdrop = document.getElementById('fs-backdrop');
        this.fsCloseBtn = document.getElementById('fs-close-btn');
        this.fsQueueList = document.getElementById('fs-queue-list');
        this.fsArtwork = document.getElementById('fs-artwork');
        this.fsTitle = document.getElementById('fs-title');
        this.fsArtist = document.getElementById('fs-artist');

        // Fullscreen Controls
        this.fsPlayPauseBtn = document.getElementById('fs-play-pause-btn');
        this.fsPrevBtn = document.getElementById('fs-prev-btn');
        this.fsNextBtn = document.getElementById('fs-next-btn');
        this.fsShuffleBtn = document.getElementById('fs-shuffle-btn');
        this.fsRepeatBtn = document.getElementById('fs-repeat-btn');
        this.fsProgressBar = document.getElementById('fs-progress-bar');
        this.fsProgressFill = document.getElementById('fs-progress-fill');
        this.fsCurrentTimeEl = document.getElementById('fs-current-time');
        this.fsTotalTimeEl = document.getElementById('fs-total-time');

        if (this.fsPlayPauseBtn) {
            this.fsIconPlay = this.fsPlayPauseBtn.querySelector('.icon-play');
            this.fsIconPause = this.fsPlayPauseBtn.querySelector('.icon-pause');
        }

        this.fsVolumeBtn = document.getElementById('fs-volume-btn');
        this.fsVolumePopover = document.getElementById('fs-volume-popover');
        this.fsVolumeSlider = document.getElementById('fs-volume-slider');
        this.fsLikeBtn = document.getElementById('fs-like-btn');
        this.fsDislikeBtn = document.getElementById('fs-dislike-btn');
        this.fsLightShowBtn = document.getElementById('fs-lightshow-btn');
        this.fsLightShowCanvas = document.getElementById('fs-lightshow-canvas');
        this.fsLyricsContainer = document.getElementById('fs-lyrics-container');
        this.fsLyricsScroll = document.getElementById('fs-lyrics-scroll');
        this.fsLyricsContent = document.getElementById('fs-lyrics-content');
        this.fsTabQueue = document.getElementById('fs-tab-queue');
        this.fsTabLyrics = document.getElementById('fs-tab-lyrics');

        // Icons
        this.iconPlay = this.playPauseBtn.querySelector('.icon-play');
        this.iconPause = this.playPauseBtn.querySelector('.icon-pause');
        this.iconLoading = this.playPauseBtn.querySelector('.icon-loading');
    }

    bindEvents() {
        // Audio events
        this.audio.addEventListener('timeupdate', () => this.handleTimeUpdate());
        this.audio.addEventListener('loadedmetadata', () => this.handleMetadataLoaded());
        this.audio.addEventListener('ended', () => this.handleEnded());
        this.audio.addEventListener('play', () => this.handlePlay());
        this.audio.addEventListener('pause', () => this.handlePause());
        this.audio.addEventListener('error', (e) => this.handleError(e));

        // Buffering events
        this.audio.addEventListener('waiting', () => this.handleWaiting());
        this.audio.addEventListener('stalled', () => this.handleWaiting());
        this.audio.addEventListener('seeking', () => this.handleWaiting());
        this.audio.addEventListener('canplay', () => this.handleCanPlay());
        this.audio.addEventListener('playing', () => this.handleCanPlay());
        this.audio.addEventListener('seeked', () => this.handleCanPlay());

        // Control buttons
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.prevBtn.addEventListener('click', () => this.playPrevious());
        this.nextBtn.addEventListener('click', () => this.playNext());
        this.shuffleBtn.addEventListener('click', () => this.toggleShuffle());
        this.repeatBtn.addEventListener('click', () => this.toggleRepeat());
        if (this.likeBtn) this.likeBtn.addEventListener('click', () => this.toggleLike());
        if (this.dislikeBtn) this.dislikeBtn.addEventListener('click', () => this.toggleDislike());

        // Fullscreen events
        if (this.nowPlayingContainer) {
            this.nowPlayingContainer.addEventListener('click', (e) => {
                // Prevent opening if clicking buttons or artist links inside the container
                if (e.target.closest('button')) return;
                if (e.target.closest('.now-playing-artist')) return;
                this.toggleFullscreen();
            });
        }
        if (this.fsCloseBtn) {
            this.fsCloseBtn.addEventListener('click', () => this.toggleFullscreen());
        }
        if (this.fsArtwork) {
            this.fsArtwork.addEventListener('click', () => this.toggleFullscreen());
        }

        // Fullscreen Controls Events
        if (this.fsPlayPauseBtn) this.fsPlayPauseBtn.addEventListener('click', () => this.togglePlayPause());
        if (this.fsPrevBtn) this.fsPrevBtn.addEventListener('click', () => this.playPrevious());
        if (this.fsNextBtn) this.fsNextBtn.addEventListener('click', () => this.playNext());
        if (this.fsShuffleBtn) this.fsShuffleBtn.addEventListener('click', () => this.toggleShuffle());
        if (this.fsRepeatBtn) this.fsRepeatBtn.addEventListener('click', () => this.toggleRepeat());
        const startDrag = (e, bar) => {
            if (!this.audio.duration) return;
            this.isDraggingProgress = true;
            this.activeProgressBar = bar;
            bar.classList.add('dragging');
            updateDrag(e);
            e.preventDefault();
        };

        const updateDrag = (e) => {
            if (!this.isDraggingProgress || !this.activeProgressBar || !this.audio.duration) return;
            const percent = this.getProgressPercent(e, this.activeProgressBar);
            const dragTime = percent * this.audio.duration;
            this.lastDisplayedTime = dragTime;

            const fill = this.activeProgressBar.querySelector('.progress-fill') || 
                         this.activeProgressBar.querySelector('.fs-progress-fill');
            if (fill) fill.style.width = `${percent * 100}%`;

            const timeEl = this.activeProgressBar === this.fsProgressBar ? this.fsCurrentTimeEl : this.currentTimeEl;
            if (timeEl) timeEl.textContent = this.formatTime(dragTime);
        };

        const endDrag = (e) => {
            if (!this.isDraggingProgress || !this.activeProgressBar || !this.audio.duration) return;
            const percent = this.getProgressPercent(e, this.activeProgressBar);
            this.audio.currentTime = percent * this.audio.duration;
            this.activeProgressBar.classList.remove('dragging');
            this.isDraggingProgress = false;
            this.activeProgressBar = null;
        };

        this.progressBar.addEventListener('mousedown', (e) => startDrag(e, this.progressBar));
        this.progressBar.addEventListener('touchstart', (e) => startDrag(e, this.progressBar));

        if (this.fsProgressBar) {
            this.fsProgressBar.addEventListener('mousedown', (e) => startDrag(e, this.fsProgressBar));
            this.fsProgressBar.addEventListener('touchstart', (e) => startDrag(e, this.fsProgressBar));
        }

        window.addEventListener('mousemove', updateDrag);
        window.addEventListener('touchmove', updateDrag);
        window.addEventListener('mouseup', endDrag);
        window.addEventListener('touchend', endDrag);

        if (this.fsVolumeBtn) this.fsVolumeBtn.addEventListener('click', () => this.toggleFsVolumePopover());
        if (this.fsVolumeSlider) this.fsVolumeSlider.addEventListener('input', (e) => this.handleFsVolumeChange(e));
        if (this.fsLikeBtn) this.fsLikeBtn.addEventListener('click', () => this.toggleLike());
        if (this.fsDislikeBtn) this.fsDislikeBtn.addEventListener('click', () => this.toggleDislike());
        if (this.fsLightShowBtn) this.fsLightShowBtn.addEventListener('click', () => this.toggleLightShow());
        if (this.fsTabQueue) this.fsTabQueue.addEventListener('click', () => {
            if (this.lyricsActive) this.toggleLyrics();
        });
        if (this.fsTabLyrics) this.fsTabLyrics.addEventListener('click', () => {
            if (!this.lyricsActive) this.toggleLyrics();
        });

        // Volume
        this.volumeSlider.addEventListener('input', (e) => this.handleVolumeChange(e));

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!this.fsContainer || this.fsContainer.classList.contains('hidden')) return;
            if (!this.fsVolumePopover || this.fsVolumePopover.classList.contains('hidden')) return;
            if (target.closest('#fs-volume-popover') || target.closest('#fs-volume-btn')) return;
            this.fsVolumePopover.classList.add('hidden');
        });
    }

    loadSettings() {
        // Load volume from localStorage
        const savedVolume = localStorage.getItem('rainy_volume');
        if (savedVolume !== null) {
            this.audio.volume = parseFloat(savedVolume);
            this.volumeSlider.value = parseFloat(savedVolume) * 100;
        } else {
            this.audio.volume = 0.8;
        }
        // Set initial volume gradient
        this.updateVolumeGradient();
        if (this.fsVolumeSlider) {
            this.fsVolumeSlider.value = this.volumeSlider.value;
            this.updateFsVolumeGradient();
        }

        // Dislikes are now loaded from database via rating service
        // No localStorage loading needed
    }

    updateVolumeGradient() {
        const percent = this.volumeSlider.value;
        this.volumeSlider.style.setProperty('--volume-percent', `${percent}%`);
    }
    updateFsVolumeGradient() {
        if (!this.fsVolumeSlider) return;
        const percent = this.fsVolumeSlider.value;
        this.fsVolumeSlider.style.setProperty('--volume-percent', `${percent}%`);
    }

    playSong(index, playlist = null, context = null) {
        if (playlist) {
            this.playlist = playlist;
            // Reset queue modifications when switching to a new playlist/context
            this.queueModified = false;
            this.queueOperations = [];
        }

        // Update playback context if provided
        if (context) {
            this.playbackContext = context;
        }

        if (index < 0 || index >= this.playlist.length) {
            return;
        }

        this.currentIndex = index;
        const song = this.playlist[index];

        // Update audio source - API now uses database ID
        const streamUrl = `/api/music/stream/${song.id}`;
        this.audio.src = streamUrl;

        // Update now playing info
        this.updateNowPlaying(song);

        // Refresh lyrics for the new song if the panel is open
        if (this.lyricsActive) {
            this.loadLyrics(song.id);
        }

        // Save playback state immediately on song change
        this.savePlaybackState();

        // Play
        this.audio.play().catch(err => {
            Logger.error('Playback error:', err);
        });
    }

    updateNowPlaying(song) {
        this.currentSong = song;
        this.nowPlayingTitle.textContent = song.title;

        // Swap in the choreographed light show for this song, if one exists
        if (this.lightShow) this.lightShow.loadScript(song.id);

        // Render clickable artist links in player bar
        const artistNames = (song.artist || 'Unknown Artist').split(',').map(s => s.trim()).filter(Boolean);
        const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${Utils.escapeHtml(name)}">${Utils.escapeHtml(name)}</span>`).join(', ');
        this.nowPlayingArtist.innerHTML = artistLinksHtml;

        // Update cover art if available
        if (song.cover_path) {
            this.nowPlayingArtwork.innerHTML = `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}?t=${Date.now()}" alt="Cover" loading="lazy">`;
        } else {
            this.nowPlayingArtwork.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>`;
        }

        // Use setTimeout to ensure DOM has updated before checking overflow
        setTimeout(() => {
            this.nowPlayingTitle.originalHTML = null;
            this.nowPlayingArtist.originalHTML = null;
            this.checkOverflow(this.nowPlayingTitle);
            this.checkOverflow(this.nowPlayingArtist);
        }, 0);

        // Update document title
        document.title = `${song.title} - ${song.artist} | Rainy`;

        // Update fullscreen view if active
        if (this.fsContainer && !this.fsContainer.classList.contains('hidden')) {
            this.updateFullscreenView();
        }

        // Update playing state in library
        if (window.app) {
            window.app.updatePlayingState(song.id);
        }

        // Update reaction buttons (init if needed, then update)
        this.ensureLikedDataInitialized().then(() => {
            this.updateReactionButtons();
        }).catch(() => {
            // Even on error, try to update buttons with whatever state we have
            this.updateReactionButtons();
        });
    }

    checkOverflow(element) {
        const parent = element.parentElement;

        // Reset classes and styles
        element.classList.remove('scrolling');
        element.style.removeProperty('--scroll-distance');
        element.style.removeProperty('--scroll-duration');

        // Restore original HTML content
        if (!element.originalHTML) {
            element.originalHTML = element.innerHTML;
        } else {
            element.innerHTML = element.originalHTML;
        }

        if (element.scrollWidth > element.clientWidth) {
            // Add separator as part of base text (using non-breaking spaces for consistent width)
            const baseHtml = element.originalHTML + '&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;';
            element.innerHTML = baseHtml;

            // Measure the exact width of the base text
            const baseWidth = element.scrollWidth;

            // Now duplicate for seamless loop
            element.innerHTML = baseHtml + baseHtml;

            const duration = baseWidth / 30; // 30px per second speed

            element.style.setProperty('--scroll-duration', `${Math.max(duration, 5)}s`);
            element.classList.add('scrolling');

            // Add mask to parent when scrolling
            parent.style.maskImage = 'linear-gradient(to right, transparent 0px, black 12px, black calc(100% - 12px), transparent 100%)';
            parent.style.webkitMaskImage = 'linear-gradient(to right, transparent 0px, black 12px, black calc(100% - 12px), transparent 100%)';
        } else {
            element.originalHTML = null;
            // Remove mask when not scrolling
            parent.style.removeProperty('mask-image');
            parent.style.removeProperty('-webkit-mask-image');
        }
    }

    togglePlayPause() {
        if (this.currentIndex === -1 && this.playlist.length > 0) {
            this.playSong(0);
            return;
        }

        if (this.isPlaying) {
            this.audio.pause();
        } else {
            this.audio.play().catch(err => Logger.error('Play error:', err));
        }
    }

    playPrevious() {
        if (this.audio.currentTime > 3) {
            // If more than 3 seconds into song, restart it
            this.audio.currentTime = 0;
            return;
        }

        let newIndex = this.currentIndex - 1;

        if (newIndex < 0) {
            if (this.repeatMode === 'all') {
                newIndex = this.playlist.length - 1;
            } else {
                newIndex = 0;
            }
        }

        this.playSong(newIndex);
    }

    playNext() {
        let newIndex = this.currentIndex + 1;

        if (this.isShuffle) {
            newIndex = Math.floor(Math.random() * this.playlist.length);
        }

        if (newIndex >= this.playlist.length) {
            if (this.repeatMode === 'all') {
                newIndex = 0;
            } else {
                // End of playlist
                return;
            }
        }

        this.playSong(newIndex);
    }

    toggleShuffle() {
        this.isShuffle = !this.isShuffle;
        const color = this.isShuffle ? 'var(--accent-primary)' : '';
        const fill = this.isShuffle ? 'var(--accent-primary)' : '';

        this.shuffleBtn.style.color = color;
        this.shuffleBtn.querySelector('svg').style.fill = fill;

        if (this.fsShuffleBtn) {
            this.fsShuffleBtn.style.color = color;
            this.fsShuffleBtn.querySelector('svg').style.fill = fill;
        }
    }

    toggleRepeat() {
        const modes = ['none', 'all', 'one'];
        const currentModeIndex = modes.indexOf(this.repeatMode);
        this.repeatMode = modes[(currentModeIndex + 1) % modes.length];

        // Update button appearance
        const updateBtn = (btn) => {
            if (!btn) return;
            const svg = btn.querySelector('svg');
            const baseLoopPath = 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z';

            switch (this.repeatMode) {
                case 'none':
                    svg.style.fill = '';
                    btn.title = 'Repeat Off';
                    svg.innerHTML = `<path d="${baseLoopPath}" />`;
                    break;
                case 'all':
                    svg.style.fill = 'var(--accent-primary)';
                    btn.title = 'Repeat All';
                    svg.innerHTML = `<path d="${baseLoopPath}" /><circle cx="12" cy="12" r="2" />`;
                    break;
                case 'one':
                    svg.style.fill = 'var(--accent-primary)';
                    btn.title = 'Repeat One';
                    // Add the "1" inside
                    svg.innerHTML = `<path d="${baseLoopPath}" /><path d="M13 15V9h-1l-2 1v1h1.5v4H13z" />`;
                    break;
            }
        };

        updateBtn(this.repeatBtn);
        updateBtn(this.fsRepeatBtn);
    }

    handleTimeUpdate() {
        // Don't update time display while buffering or dragging progress
        if (this.isBuffering || this.isDraggingProgress) return;

        if (this.audio.duration) {
            const percent = (this.audio.currentTime / this.audio.duration) * 100;

            // Main bar
            this.progressFill.style.width = `${percent}%`;
            this.lastDisplayedTime = this.audio.currentTime;
            this.currentTimeEl.textContent = this.formatTime(this.audio.currentTime);

            // Fullscreen bar
            if (this.fsProgressFill) this.fsProgressFill.style.width = `${percent}%`;
            if (this.fsCurrentTimeEl) this.fsCurrentTimeEl.textContent = this.formatTime(this.audio.currentTime);

            // Lyrics sync
            this.updateActiveLyricLine();

            // Throttled save of playback state
            const now = Date.now();
            if (now - this.lastSaveTime > this.saveThrottleMs) {
                this.savePlaybackState();
                this.lastSaveTime = now;
            }
        }
    }

    async ensureLikedDataInitialized() {
        if (this.likedInitDone) {
            // If already initialized but Sets are empty, reload (edge case)
            if (this.likedSongIds.size === 0 && this.dislikedSongIds.size === 0) {
                Logger.log('ensureLikedDataInitialized: Sets are empty, reloading...');
                this.likedInitDone = false;
            } else {
                return;
            }
        }
        try {
            Logger.log('ensureLikedDataInitialized: Loading from API...');
            
            // Load liked and disliked songs from ratings API (source of truth)
            const [likedData, dislikedData] = await Promise.all([
                useRatingService().getLikedIds(),
                useRatingService().getDislikedIds()
            ]);

            Logger.log('ensureLikedDataInitialized: likedData:', likedData);
            Logger.log('ensureLikedDataInitialized: dislikedData:', dislikedData);

            if (!likedData.error && likedData.value && likedData.value.song_ids) {
                // Ensure song_ids are numbers
                this.likedSongIds = new Set(likedData.value.song_ids.map(id => Number(id)));
                Logger.log(`Loaded ${this.likedSongIds.size} liked songs`);
            }
            if (!dislikedData.error && dislikedData.value && dislikedData.value.song_ids) {
                // Ensure song_ids are numbers
                this.dislikedSongIds = new Set(dislikedData.value.song_ids.map(id => Number(id)));
                Logger.log(`Loaded ${this.dislikedSongIds.size} disliked songs`);
            }

            // Also ensure Liked Music playlist exists for UI compatibility
            const playlistData = await usePlaylistService().all();
            if (playlistData.error || !Array.isArray(playlistData.value)) {
                this.likedInitDone = true;
                return;
            }
            const playlists = playlistData.value;
            const liked = playlists.find(p => typeof p.name === 'string' && p.name.toLowerCase() === 'liked music');
            if (liked) {
                this.likedPlaylistId = liked.id;
            } else {
                const created = await usePlaylistService().create('Liked Music', 'like', '#fa586a', true);
                if (created.error) {
                    this.likedInitDone = true;
                    return;
                }
                this.likedPlaylistId = created.value?.id;
                if (window.app) {
                    window.app.loadPlaylists?.();
                }
            }

            this.likedInitDone = true;
            Logger.log('ensureLikedDataInitialized: Done, likedInitDone=true');
        } catch (e) {
            Logger.error('Failed to initialize liked data:', e);
        }
    }

    /**
     * Refresh liked/disliked data from server (useful after playlist changes)
     */
    async refreshLikedData() {
        this.likedInitDone = false;
        await this.ensureLikedDataInitialized();
        this.updateReactionButtons();
    }

    async refreshLikedViewIfNeeded() {
        if (!window.app || !this.likedPlaylistId) return;
        const viewType = useContext().get('current-view-type');
        if (viewType === 'playlist' && window.app.currentPlaylistId === this.likedPlaylistId) {
            await window.app.openPlaylist(this.likedPlaylistId);
        }
    }

    updateReactionButtons() {
        const songId = this.currentSong ? Number(this.currentSong.id) : null;
        const isLiked = songId && this.likedSongIds.has(songId);
        const isDisliked = songId && this.dislikedSongIds.has(songId);

        const setBtnState = (btn, activeColor, active) => {
            if (!btn) return;
            const svg = btn.querySelector('svg');
            if (!svg) return;
            svg.style.fill = active ? activeColor : '';
        };

        setBtnState(this.likeBtn, 'var(--accent-primary)', !!isLiked);
        setBtnState(this.fsLikeBtn, 'var(--accent-primary)', !!isLiked);
        setBtnState(this.dislikeBtn, 'var(--error)', !!isDisliked);
        setBtnState(this.fsDislikeBtn, 'var(--error)', !!isDisliked);
    }

    async toggleLike() {
        const song = this.getCurrentSong();
        if (!song) return;
        await this.ensureLikedDataInitialized();
        if (!this.likedPlaylistId) return;

        // Ensure consistent number type for comparison
        const songId = Number(song.id);
        const isLiked = this.likedSongIds.has(songId);
        const isDisliked = this.dislikedSongIds.has(songId);

        Logger.log(`toggleLike: songId=${songId}, isLiked=${isLiked}, isDisliked=${isDisliked}`);

        try {
            if (isLiked) {
                // Optimistically update UI
                this.likedSongIds.delete(songId);
                this.updateReactionButtons();
                
                // API call - remove from playlist
                Logger.log('Calling playlist.removeSong...');
                const res = await usePlaylistService().removeSong(this.likedPlaylistId, songId);
                if (res.error) {
                    Logger.error('Playlist remove failed:', res.error);
                    // Revert on error
                    this.likedSongIds.add(songId);
                    this.updateReactionButtons();
                    return;
                }
                
                // Sync to ratings table
                Logger.log('Calling ratingService.setRating(null)...');
                const ratingRes = await useRatingService().setRating(songId, null);
                if (ratingRes.error) {
                    Logger.error('Rating removal failed:', ratingRes.error);
                } else {
                    Logger.log('Rating removed successfully');
                }
                window.showToast?.('Removed from Liked Music', 'success');
            } else {
                // Optimistically update UI
                if (isDisliked) {
                    this.dislikedSongIds.delete(songId);
                }
                this.likedSongIds.add(songId);
                this.updateReactionButtons();
                
                // API call - add to playlist
                Logger.log('Calling playlist.addSong...');
                const res = await usePlaylistService().addSong(this.likedPlaylistId, songId);
                if (res.error) {
                    Logger.error('Playlist add failed:', res.error);
                    // Revert on error
                    this.likedSongIds.delete(songId);
                    if (isDisliked) {
                        this.dislikedSongIds.add(songId);
                    }
                    this.updateReactionButtons();
                    return;
                }
                
                // Sync to ratings table
                Logger.log('Calling ratingService.setRating(like)...');
                const ratingRes = await useRatingService().setRating(songId, 'like');
                if (ratingRes.error) {
                    Logger.error('Rating set failed:', ratingRes.error);
                } else {
                    Logger.log('Rating set successfully');
                }
                window.showToast?.(isDisliked ? 'Added to Liked Music and removed dislike' : 'Added to Liked Music', 'success');
            }
            
            if (window.app) window.app.loadPlaylists?.();
            await this.refreshLikedViewIfNeeded();
        } catch (e) {
            Logger.error('Toggle like error:', e);
            // Refresh state from server on error
            await this.ensureLikedDataInitialized();
            this.updateReactionButtons();
        }
    }

    async toggleDislike() {
        const song = this.getCurrentSong();
        if (!song) return;
        await this.ensureLikedDataInitialized();
        
        // Ensure consistent number type for comparison
        const songId = Number(song.id);
        const isDisliked = this.dislikedSongIds.has(songId);
        const isLiked = this.likedSongIds.has(songId);

        Logger.log(`toggleDislike: songId=${songId}, isDisliked=${isDisliked}, isLiked=${isLiked}`);

        try {
            if (isDisliked) {
                // Optimistically update UI
                this.dislikedSongIds.delete(songId);
                this.updateReactionButtons();
                
                // API call - remove rating
                Logger.log('Calling ratingService.removeRating...');
                await useRatingService().removeRating(songId);
                Logger.log('Dislike removed successfully');
                window.showToast?.('Removed dislike', 'success');
            } else {
                // Optimistically update UI
                if (isLiked) {
                    this.likedSongIds.delete(songId);
                }
                this.dislikedSongIds.add(songId);
                this.updateReactionButtons();
                
                // API call - set dislike rating
                Logger.log('Calling ratingService.setRating(dislike)...');
                await useRatingService().setRating(songId, 'dislike');
                Logger.log('Dislike set successfully');
                
                // Also remove from playlist if liked
                if (isLiked && this.likedPlaylistId) {
                    Logger.log('Also removing from liked playlist...');
                    await usePlaylistService().removeSong(this.likedPlaylistId, songId);
                }
                
                window.showToast?.(isLiked ? 'Marked as disliked and removed from Liked Music' : 'Marked as disliked', 'success');
            }
            
            if (window.app) window.app.loadPlaylists?.();
            this.refreshLikedViewIfNeeded();
        } catch (e) {
            Logger.error('Toggle dislike error:', e);
            // Refresh state from server on error
            await this.ensureLikedDataInitialized();
            this.updateReactionButtons();
        }
    }

    async toggleLikeForSong(song) {
        if (!song) return;
        await this.ensureLikedDataInitialized();
        if (!this.likedPlaylistId) return;

        const songId = Number(song.id);
        const isLiked = this.likedSongIds.has(songId);
        const isDisliked = this.dislikedSongIds.has(songId);

        try {
            if (isLiked) {
                // Optimistically update UI
                this.likedSongIds.delete(songId);
                this.updateReactionButtons();
                
                // API call
                const res = await usePlaylistService().removeSong(this.likedPlaylistId, songId);
                if (res.error) {
                    // Revert on error
                    this.likedSongIds.add(songId);
                    this.updateReactionButtons();
                    return;
                }
                
                // Sync to ratings table
                const ratingRes = await useRatingService().setRating(songId, null);
                if (ratingRes.error) {
                    Logger.error('Failed to sync rating removal:', ratingRes.error);
                }
                window.showToast?.('Removed from Liked Music', 'success');
            } else {
                // Optimistically update UI
                if (isDisliked) {
                    this.dislikedSongIds.delete(songId);
                }
                this.likedSongIds.add(songId);
                this.updateReactionButtons();
                
                // API call
                const res = await usePlaylistService().addSong(this.likedPlaylistId, songId);
                if (res.error) {
                    // Revert on error
                    this.likedSongIds.delete(songId);
                    if (isDisliked) {
                        this.dislikedSongIds.add(songId);
                    }
                    this.updateReactionButtons();
                    return;
                }
                
                // Sync to ratings table
                const ratingRes = await useRatingService().setRating(songId, 'like');
                if (ratingRes.error) {
                    Logger.error('Failed to sync rating:', ratingRes.error);
                }
                window.showToast?.(isDisliked ? 'Added to Liked Music and removed dislike' : 'Added to Liked Music', 'success');
            }
            
            if (window.app) window.app.loadPlaylists?.();
            await this.refreshLikedViewIfNeeded();
        } catch (e) {
            Logger.error('Toggle like for song error:', e);
            // Refresh state from server on error
            await this.ensureLikedDataInitialized();
            this.updateReactionButtons();
        }
    }

    async toggleDislikeForSong(song) {
        if (!song) return;
        await this.ensureLikedDataInitialized();
        
        const songId = Number(song.id);
        const isDisliked = this.dislikedSongIds.has(songId);
        const isLiked = this.likedSongIds.has(songId);

        try {
            if (isDisliked) {
                // Optimistically update UI
                this.dislikedSongIds.delete(songId);
                this.updateReactionButtons();
                
                // API call
                await useRatingService().removeRating(songId);
                window.showToast?.('Removed dislike', 'success');
            } else {
                // Optimistically update UI
                if (isLiked) {
                    this.likedSongIds.delete(songId);
                }
                this.dislikedSongIds.add(songId);
                this.updateReactionButtons();
                
                // API call
                await useRatingService().setRating(songId, 'dislike');
                
                // Also remove from playlist if liked
                if (isLiked && this.likedPlaylistId) {
                    await usePlaylistService().removeSong(this.likedPlaylistId, songId);
                }
                
                window.showToast?.(isLiked ? 'Marked as disliked and removed from Liked Music' : 'Marked as disliked', 'success');
            }
            
            if (window.app) window.app.loadPlaylists?.();
            this.refreshLikedViewIfNeeded();
        } catch (e) {
            Logger.error('Toggle dislike for song error:', e);
            // Refresh state from server on error
            await this.ensureLikedDataInitialized();
            this.updateReactionButtons();
        }
    }

    handleMetadataLoaded() {
        const timeStr = this.formatTime(this.audio.duration);
        this.totalTimeEl.textContent = timeStr;
        if (this.fsTotalTimeEl) this.fsTotalTimeEl.textContent = timeStr;
    }

    handleEnded() {
        if (this.repeatMode === 'one') {
            this.audio.currentTime = 0;
            this.audio.play();
        } else {
            this.playNext();
        }
    }

    handlePlay() {
        this.isPlaying = true;
        this.iconPlay.classList.add('hidden');
        this.iconPause.classList.remove('hidden');
        this.nowPlayingArtwork.classList.add('playing');

        // Pause discover preview audio if it exists and is playing
        const discoverPreviewAudio = document.getElementById('discover-preview-audio');
        if (discoverPreviewAudio && !discoverPreviewAudio.paused) {
            discoverPreviewAudio.pause();
            const previewPlayBtn = document.getElementById('preview-play-btn');
            if (previewPlayBtn) {
                previewPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            }
        }

        // Fullscreen update
        if (this.fsIconPlay) this.fsIconPlay.classList.add('hidden');
        if (this.fsIconPause) this.fsIconPause.classList.remove('hidden');
    }

    handlePause() {
        this.isPlaying = false;
        this.iconPlay.classList.remove('hidden');
        this.iconPause.classList.add('hidden');
        this.nowPlayingArtwork.classList.remove('playing');

        // Fullscreen update
        if (this.fsIconPlay) this.fsIconPlay.classList.remove('hidden');
        if (this.fsIconPause) this.fsIconPause.classList.add('hidden');
    }

    handleError(e) {
        Logger.error('Audio error:', e);
        this.isBuffering = false;
    }

    handleWaiting() {
        // Audio is waiting for data (buffering)
        this.isBuffering = true;
        Logger.log('Audio buffering...');
        this.nowPlayingArtwork.classList.add('buffering');
        // Show loading spinner, hide play/pause icons
        this.iconPlay.classList.add('hidden');
        this.iconPause.classList.add('hidden');
        this.iconLoading.classList.remove('hidden');
        // Freeze time display
        this.currentTimeEl.textContent = this.formatTime(this.lastDisplayedTime);
    }

    handleCanPlay() {
        // Audio has enough data to play
        if (this.isBuffering) {
            this.isBuffering = false;
            // Hide spinner, restore appropriate icon
            this.iconLoading.classList.add('hidden');
            if (this.isPlaying) {
                this.iconPause.classList.remove('hidden');
            } else {
                this.iconPlay.classList.remove('hidden');
            }
            this.currentTimeEl.textContent = this.formatTime(this.lastDisplayedTime);
        }
        this.nowPlayingArtwork.classList.remove('buffering');
    }

    getProgressPercent(e, bar) {
        const rect = bar.getBoundingClientRect();
        let clientX = e.clientX;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
        }
        const offset = clientX - rect.left;
        return Math.max(0, Math.min(1, offset / rect.width));
    }

    handleProgressClick(e, progressBarElement) {
        if (!this.audio.duration) return;

        const bar = progressBarElement || this.progressBar;
        const rect = bar.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        this.audio.currentTime = percent * this.audio.duration;
    }

    handleVolumeChange(e) {
        const volume = e.target.value / 100;
        this.audio.volume = volume;
        localStorage.setItem('rainy_volume', volume.toString());
        this.updateVolumeGradient();
        if (this.fsVolumeSlider) {
            this.fsVolumeSlider.value = e.target.value;
            this.updateFsVolumeGradient();
        }
    }

    handleKeyboard(e) {
        // Don't handle if typing in input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                this.togglePlayPause();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.audio.currentTime = Math.max(0, this.audio.currentTime - 10);
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.audio.currentTime = Math.min(this.audio.duration, this.audio.currentTime + 10);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.audio.volume = Math.min(1, this.audio.volume + 0.1);
                this.volumeSlider.value = this.audio.volume * 100;
                this.updateVolumeGradient();
                if (this.fsVolumeSlider) {
                    this.fsVolumeSlider.value = this.volumeSlider.value;
                    this.updateFsVolumeGradient();
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                this.audio.volume = Math.max(0, this.audio.volume - 0.1);
                this.volumeSlider.value = this.audio.volume * 100;
                this.updateVolumeGradient();
                if (this.fsVolumeSlider) {
                    this.fsVolumeSlider.value = this.volumeSlider.value;
                    this.updateFsVolumeGradient();
                }
                break;
        }
    }

    toggleFsVolumePopover() {
        if (!this.fsVolumePopover) return;
        const isHidden = this.fsVolumePopover.classList.contains('hidden');
        if (isHidden) {
            this.fsVolumePopover.classList.remove('hidden');
        } else {
            this.fsVolumePopover.classList.add('hidden');
        }
    }

    handleFsVolumeChange(e) {
        const volume = e.target.value / 100;
        this.audio.volume = volume;
        localStorage.setItem('rainy_volume', volume.toString());
        this.updateFsVolumeGradient();
        this.volumeSlider.value = e.target.value;
        this.updateVolumeGradient();
    }

    formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    getCurrentSong() {
        if (this.currentIndex >= 0 && this.currentIndex < this.playlist.length) {
            return this.playlist[this.currentIndex];
        }
        return null;
    }

    toggleFullscreen() {
        if (!this.fsContainer) return;

        const isHidden = this.fsContainer.classList.contains('hidden');
        if (isHidden) {
            // Apply mode class
            let mode = 'standard'; // Default
            let swap = false;
            if (window.app && window.app.user && window.app.user.preferences) {
                let prefs = window.app.user.preferences;
                if (typeof prefs === 'string') {
                    try {
                        prefs = JSON.parse(prefs);
                    } catch (e) { }
                }
                if (prefs && prefs.fullscreen_mode) {
                    mode = prefs.fullscreen_mode;
                }
                if (prefs && typeof prefs.fullscreen_swap_sides !== 'undefined') {
                    swap = !!prefs.fullscreen_swap_sides;
                }
            }

            // Remove existing mode classes
            this.fsContainer.classList.remove('mode-modern', 'mode-standard');
            this.fsContainer.classList.add(`mode-${mode}`);
            this.fsContainer.classList.toggle('layout-swapped', swap);

            this.fsContainer.classList.remove('hidden');
            // Trigger reflow
            void this.fsContainer.offsetWidth;
            this.fsContainer.classList.add('active');
            if (this.fsVolumePopover) this.fsVolumePopover.classList.add('hidden');
            this.updateFullscreenView();

            // Resume light show if it was active
            if (this.lightShowActive && this.lightShow) {
                this.lightShow.resume();
            }
        } else {
            this.fsContainer.classList.remove('active');
            // Wait for transition to finish
            setTimeout(() => {
                this.fsContainer.classList.add('hidden');
                // Clean up classes
                this.fsContainer.classList.remove('mode-modern', 'mode-standard');
                this.fsContainer.classList.remove('layout-swapped');
            }, 300);
            if (this.fsVolumePopover) this.fsVolumePopover.classList.add('hidden');
        }
    }

    toggleLightShow() {
        this.lightShowActive = !this.lightShowActive;

        if (this.lightShowActive) {
            if (this.fsLightShowBtn) this.fsLightShowBtn.classList.add('active');
            if (this.fsLightShowCanvas) this.fsLightShowCanvas.classList.remove('hidden');

            if (!this.lightShow) {
                this.lightShow = new LightShowEngine({
                    canvas: this.fsLightShowCanvas,
                    backdrop: this.fsBackdrop,
                    container: this.fsContainer,
                    isPlaying: () => this.isPlaying
                });
            }
            this.lightShow.start(this.audio);
            if (this.currentSong) this.lightShow.loadScript(this.currentSong.id);
            window.showToast?.('Light show enabled', 'success');
        } else {
            if (this.fsLightShowBtn) this.fsLightShowBtn.classList.remove('active');
            if (this.lightShow) this.lightShow.stop();
            if (this.fsLightShowCanvas) this.fsLightShowCanvas.classList.add('hidden');

            // Reset backdrop to original styles
            if (this.fsBackdrop) {
                this.fsBackdrop.style.transform = 'none';
                this.fsBackdrop.style.opacity = '1';
            }
            window.showToast?.('Light show disabled', 'info');
        }
    }

    toggleLyrics() {
        this.lyricsActive = !this.lyricsActive;

        if (this.fsContainer) this.fsContainer.classList.toggle('lyrics-active', this.lyricsActive);

        if (this.lyricsActive) {
            if (this.currentSong) {
                if (this.lyricsSongId === this.currentSong.id && this.lyricsData) {
                    this.renderLyrics();
                } else {
                    this.loadLyrics(this.currentSong.id);
                }
            }
        }
    }

    _showLyricsEmpty(message) {
        if (!this.fsLyricsContent) return;
        this.fsLyricsContent.innerHTML =
            `<div class="fs-lyrics-empty">${message}</div>` +
            `<button class="fs-lyrics-retry" type="button">Retry search</button>`;
        const btn = this.fsLyricsContent.querySelector('.fs-lyrics-retry');
        if (btn) {
            btn.addEventListener('click', () => {
                if (this.lyricsSongId != null) this.loadLyrics(this.lyricsSongId, true);
            });
        }
    }

    async loadLyrics(songId, refresh = false) {
        this.lyricsSongId = songId;
        this.lyricsData = null;
        this.activeLyricIndex = -1;

        if (this.fsLyricsContent) {
            this.fsLyricsContent.innerHTML = '<div class="fs-lyrics-loading">Loading lyrics…</div>';
        }
        if (this.fsLyricsScroll) this.fsLyricsScroll.scrollTop = 0;

        try {
            const url = `/api/music/song/${songId}/lyrics${refresh ? '?refresh=1' : ''}`;
            const res = await fetch(url);
            if (this.lyricsSongId !== songId) return; // Song changed mid-request

            if (!res.ok) {
                this._showLyricsEmpty('No lyrics found for this song');
                return;
            }

            const data = await res.json();
            if (this.lyricsSongId !== songId) return;

            this.lyricsData = data.lyrics || null;
            this.renderLyrics();
        } catch (err) {
            Logger.error('Lyrics load error:', err);
            if (this.lyricsSongId === songId) {
                this._showLyricsEmpty('Could not load lyrics');
            }
        }
    }

    renderLyrics() {
        if (!this.fsLyricsContent) return;

        const data = this.lyricsData;
        if (!data) return;

        const escape = window.escapeHtml || ((s) => s);

        if (Array.isArray(data.synced) && data.synced.length) {
            this.fsLyricsContent.innerHTML = data.synced.map((line, i) =>
                `<div class="fs-lyric-line" data-index="${i}" data-time="${line.time}">${escape(line.text || '♪')}</div>`
            ).join('');

            this.fsLyricsContent.querySelectorAll('.fs-lyric-line').forEach(el => {
                el.addEventListener('click', () => {
                    const t = parseFloat(el.dataset.time);
                    if (!isNaN(t)) {
                        this.audio.currentTime = t;
                        this.audio.play().catch(() => {});
                    }
                });
            });

            this.activeLyricIndex = -1;
            this.updateActiveLyricLine();
        } else if (data.plain) {
            this.fsLyricsContent.innerHTML = escape(data.plain)
                .split('\n')
                .map(line => `<div class="fs-lyric-line static">${line || '&nbsp;'}</div>`)
                .join('');
        } else {
            this._showLyricsEmpty('No lyrics found for this song');
        }
    }

    updateActiveLyricLine() {
        if (!this.lyricsActive || !this.lyricsData || !this.fsLyricsContent) return;
        const lines = this.lyricsData.synced;
        if (!Array.isArray(lines) || !lines.length) return;

        const t = this.audio.currentTime;
        let lo = 0, hi = lines.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lines[mid].time <= t) {
                idx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        if (idx === this.activeLyricIndex) return;
        this.activeLyricIndex = idx;

        const els = this.fsLyricsContent.children;
        for (let i = 0; i < els.length; i++) {
            els[i].classList.toggle('active', i === idx);
        }

        const scrollEl = this.fsLyricsScroll;
        const lineEl = idx >= 0 ? els[idx] : null;
        if (scrollEl && lineEl) {
            const scrollRect = scrollEl.getBoundingClientRect();
            const lineRect = lineEl.getBoundingClientRect();
            const target = scrollEl.scrollTop + (lineRect.top - scrollRect.top)
                - scrollEl.clientHeight / 2 + lineRect.height / 2;
            scrollEl.scrollTo({ top: target, behavior: 'smooth' });
        }
    }

    updateFullscreenView() {
        if (!this.currentSong) return;

        const song = this.currentSong;

        // Update Info
        if (this.fsTitle) this.fsTitle.textContent = song.title;
        if (this.fsArtist) this.fsArtist.textContent = song.artist;

        // Update Artwork
        if (this.fsArtwork) {
            if (song.cover_path) {
                const imgHtml = `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}?t=${Date.now()}" alt="Cover">`;
                this.fsArtwork.innerHTML = imgHtml;
                // Update backdrop
                if (this.fsBackdrop) {
                    this.fsBackdrop.style.backgroundImage = `url('/api/music/cover/${encodeURIComponent(song.cover_path)}?t=${Date.now()}')`;
                }
            } else {
                this.fsArtwork.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
                if (this.fsBackdrop) {
                    this.fsBackdrop.style.backgroundImage = 'none';
                    this.fsBackdrop.style.backgroundColor = 'var(--bg-primary)';
                }
            }
        }

        // Render Queue
        this.renderFullscreenQueue();
    }

    renderFullscreenQueue() {
        if (!this.fsQueueList) return;

        const html = this.playlist.map((song, index) => {
            const isActive = index === this.currentIndex;
            const coverHtml = song.cover_path
                ? `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}" alt="Cover" loading="lazy">`
                : `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

            return `
                <div class="fs-queue-item ${isActive ? 'active' : ''}" data-index="${index}" data-song-id="${song.id}" draggable="true">
                    <div class="fs-queue-drag-handle" title="Drag to reorder">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                        </svg>
                    </div>
                    <div class="fs-queue-cover">${coverHtml}</div>
                    <div class="fs-queue-info">
                        <div class="fs-queue-title">${window.escapeHtml ? window.escapeHtml(song.title) : song.title}</div>
                        <div class="fs-queue-artist">${window.escapeHtml ? window.escapeHtml(song.artist) : song.artist}</div>
                    </div>
                    <div class="fs-queue-duration">${this.formatTime(song.duration)}</div>
                    <button class="fs-queue-menu-btn" data-index="${index}" title="More options">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');

        this.fsQueueList.innerHTML = html;

        // Bind click events for queue items
        this.fsQueueList.querySelectorAll('.fs-queue-item').forEach(item => {
            // Play song on click (but not on menu button or drag handle)
            item.addEventListener('click', (e) => {
                if (e.target.closest('.fs-queue-menu-btn') || e.target.closest('.fs-queue-drag-handle')) return;
                const index = parseInt(item.dataset.index);
                this.playSong(index);
            });

            // Right-click context menu
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const index = parseInt(item.dataset.index);
                this.showQueueContextMenu(e, index);
            });

            // Drag and drop events
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.dataset.index);
                item.classList.add('dragging');
                this.draggedIndex = parseInt(item.dataset.index);
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                this.fsQueueList.querySelectorAll('.fs-queue-item').forEach(i => {
                    i.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
                });
                this.draggedIndex = null;
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';

                const rect = item.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;

                // Remove previous indicators
                item.classList.remove('drag-over-top', 'drag-over-bottom');

                // Show indicator based on position
                if (e.clientY < midY) {
                    item.classList.add('drag-over-top');
                } else {
                    item.classList.add('drag-over-bottom');
                }
            });

            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');

                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                let toIndex = parseInt(item.dataset.index);

                // Adjust drop position based on where the cursor is
                const rect = item.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY > midY && toIndex < this.playlist.length - 1) {
                    toIndex++;
                }

                if (fromIndex !== toIndex) {
                    this.moveSongInQueue(fromIndex, toIndex);
                }
            });
        });

        // Bind menu button clicks
        this.fsQueueList.querySelectorAll('.fs-queue-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(btn.dataset.index);
                this.showQueueContextMenu(e, index);
            });
        });

        // Scroll to current song
        const activeItem = this.fsQueueList.querySelector('.active');
        if (activeItem) {
            setTimeout(() => {
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }
    }

    /**
     * Show context menu for queue item
     * @param {Event} e - The click/contextmenu event
     * @param {number} index - Index of the song in the queue
     */
    showQueueContextMenu(e, index) {
        this.hideQueueContextMenu();

        const song = this.playlist[index];
        if (!song) return;

        const songId = Number(song.id);
        const isLiked = this.likedSongIds.has(songId);
        const isDisliked = this.dislikedSongIds.has(songId);

        const menu = document.createElement('div');
        menu.id = 'fs-queue-context-menu';
        menu.className = 'fs-queue-context-menu';
        menu.innerHTML = `
            <div class="fs-queue-menu-item" data-action="play" data-index="${index}">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                </svg>
                <span>Play Now</span>
            </div>
            <div class="fs-queue-menu-item ${isLiked ? 'active liked' : ''}" data-action="like" data-index="${index}">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 7.83V19c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73z"/>
                </svg>
                <span>${isLiked ? 'Unlike' : 'Like'}</span>
            </div>
            <div class="fs-queue-menu-item ${isDisliked ? 'active disliked' : ''}" data-action="dislike" data-index="${index}">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 7.83V19c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73z" transform="rotate(180 12 12)"/>
                </svg>
                <span>${isDisliked ? 'Undislike' : 'Dislike'}</span>
            </div>
            <div class="fs-queue-menu-item danger" data-action="remove" data-index="${index}">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 13H5v-2h14v2z"/>
                </svg>
                <span>Remove from Queue</span>
            </div>
        `;

        menu.style.position = 'fixed';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.style.zIndex = '3000';

        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${window.innerHeight - rect.height - 10}px`;
        }

        menu.querySelectorAll('.fs-queue-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                const idx = parseInt(item.dataset.index);
                const songItem = this.playlist[idx];

                if (action === 'play') {
                    this.playSong(idx);
                } else if (action === 'like') {
                    this.toggleLikeForSong(songItem);
                } else if (action === 'dislike') {
                    this.toggleDislikeForSong(songItem);
                } else if (action === 'remove') {
                    this.removeFromQueue(idx);
                }

                this.hideQueueContextMenu();
            });
        });

        setTimeout(() => {
            document.addEventListener('click', this.hideQueueContextMenu.bind(this), { once: true });
        }, 10);
    }

    /**
     * Hide the queue context menu
     */
    hideQueueContextMenu() {
        const menu = document.getElementById('fs-queue-context-menu');
        if (menu) {
            menu.remove();
        }
    }

    /**
     * Move a song in the queue (for drag and drop reordering)
     * @param {number} fromIndex - Current index of the song
     * @param {number} toIndex - Target index to move to
     */
    moveSongInQueue(fromIndex, toIndex) {
        if (fromIndex < 0 || fromIndex >= this.playlist.length) return;
        if (toIndex < 0 || toIndex >= this.playlist.length) return;
        if (fromIndex === toIndex) return;

        // Get the song being moved
        const song = this.playlist[fromIndex];

        // Record the operation
        this.queueOperations.push({
            action: 'move',
            songId: song.id,
            fromPosition: fromIndex,
            toPosition: toIndex
        });

        // Remove from old position
        this.playlist.splice(fromIndex, 1);

        // Insert at new position
        this.playlist.splice(toIndex, 0, song);

        // Adjust current index if needed
        if (fromIndex === this.currentIndex) {
            // Moved the currently playing song
            this.currentIndex = toIndex;
        } else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
            // Moved a song from before current to after current
            this.currentIndex--;
        } else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
            // Moved a song from after current to before current
            this.currentIndex++;
        }

        // Mark queue as modified
        this.queueModified = true;
        this.savePlaybackState();

        // Re-render the queue
        this.renderFullscreenQueue();

        Logger.log(`Moved song from position ${fromIndex} to ${toIndex}`);
    }

    /**
     * Remove a song from the queue
     * @param {number} index - Index of the song to remove
     */
    removeFromQueue(index) {
        if (index < 0 || index >= this.playlist.length) return;
        if (this.playlist.length <= 1) {
            // Don't remove the last song
            Logger.warn('Cannot remove the only song in queue');
            return;
        }

        // Record the operation before removing
        const removedSong = this.playlist[index];
        this.queueOperations.push({
            action: 'remove',
            songId: removedSong.id,
            position: index
        });

        // Remove the song from playlist
        this.playlist.splice(index, 1);

        // Adjust current index if needed
        if (index < this.currentIndex) {
            // Removed song was before current, shift index down
            this.currentIndex--;
        } else if (index === this.currentIndex) {
            // Removed the current song
            if (this.currentIndex >= this.playlist.length) {
                this.currentIndex = this.playlist.length - 1;
            }
            // Start playing the song that took its place
            if (this.playlist.length > 0) {
                this.playSong(this.currentIndex);
            }
        }

        // Mark queue as modified (for localStorage persistence)
        this.queueModified = true;

        // Save the modified queue
        this.savePlaybackState();

        // Re-render the queue
        this.renderFullscreenQueue();

        Logger.log('Removed song at index', index, 'from queue');
    }

    /**
     * Save current playback state to localStorage
     * Stores essential data (song ID, context, time)
     * For modified queues, stores only the operations (add/remove) for space efficiency
     */
    savePlaybackState() {
        if (this.currentIndex < 0 || !this.playlist.length) return;

        const song = this.playlist[this.currentIndex];
        if (!song) return;

        const state = {
            songId: song.id,
            currentTime: this.audio.currentTime || 0,
            currentIndex: this.currentIndex,
            context: this.playbackContext
        };

        // If queue has been modified, save only the operations (much smaller than full queue)
        if (this.queueModified && this.queueOperations.length > 0) {
            state.queueOperations = this.queueOperations;
        }

        try {
            localStorage.setItem('rainy_playback_state', JSON.stringify(state));
        } catch (e) {
            Logger.warn('Failed to save playback state:', e);
        }
    }

    /**
     * Restore playback state from localStorage
     * @returns {Object|null} The restored state object, or null if none exists
     */
    getStoredPlaybackState() {
        try {
            const stored = localStorage.getItem('rainy_playback_state');
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {
            Logger.warn('Failed to restore playback state:', e);
        }
        return null;
    }

    /**
     * Restore a song from saved state (does not auto-play)
     * @param {Object} state - The playback state object (songId, currentTime, context)
     * @param {Array} queue - The queue/playlist to use
     * @param {boolean} autoPlay - Whether to auto-play the song
     */
    restoreFromState(state, queue, autoPlay = false) {
        if (!state || !state.songId || !queue || !queue.length) return;

        this.playlist = queue;
        this.playbackContext = state.context || { type: 'library', id: null };

        // Use stored currentIndex if available (for modified queues with possible duplicates)
        // Fall back to findIndex for normal cases
        let songIndex;
        if (typeof state.currentIndex === 'number' && state.currentIndex >= 0 && state.currentIndex < queue.length) {
            // Verify the song at the stored index matches
            if (queue[state.currentIndex] && queue[state.currentIndex].id === state.songId) {
                songIndex = state.currentIndex;
            } else {
                // Index doesn't match, fall back to findIndex
                songIndex = queue.findIndex(s => s.id === state.songId);
            }
        } else {
            songIndex = queue.findIndex(s => s.id === state.songId);
        }

        if (songIndex === -1) return; // Song not found in queue

        this.currentIndex = songIndex;
        const song = this.playlist[this.currentIndex];

        // Set up audio source
        const streamUrl = `/api/music/stream/${song.id}`;
        this.audio.src = streamUrl;

        // Restore position when metadata is loaded
        const savedTime = state.currentTime || 0;
        if (savedTime > 0) {
            const onLoadedMetadata = () => {
                if (savedTime < this.audio.duration) {
                    this.audio.currentTime = savedTime;
                }
                this.audio.removeEventListener('loadedmetadata', onLoadedMetadata);
            };
            this.audio.addEventListener('loadedmetadata', onLoadedMetadata);
        }

        // Update UI
        this.updateNowPlaying(song);

        if (autoPlay) {
            this.audio.play().catch(err => {
                Logger.log('Auto-play blocked, waiting for user interaction');
            });
        }
    }

    /**
     * Clear saved playback state
     */
    clearPlaybackState() {
        localStorage.removeItem('rainy_playback_state');
    }
}
