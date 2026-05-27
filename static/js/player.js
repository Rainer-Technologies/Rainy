/**
 * Rainy Music Player - Audio Player Controller
 * Handles audio playback, progress, volume, queue, and reactions
 */
import { Logger } from './helper/logger.js';
import { usePlaylistService } from './services/playlist.js';
import { useRatingService } from './services/rating.js';
import { useContext } from './helper/context.js';

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
                // Prevent opening if clicking play/pause or heart inside the container if any
                if (e.target.closest('button')) return;
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
        if (this.fsProgressBar) this.fsProgressBar.addEventListener('click', (e) => this.handleProgressClick(e, this.fsProgressBar));
        if (this.fsVolumeBtn) this.fsVolumeBtn.addEventListener('click', () => this.toggleFsVolumePopover());
        if (this.fsVolumeSlider) this.fsVolumeSlider.addEventListener('input', (e) => this.handleFsVolumeChange(e));
        if (this.fsLikeBtn) this.fsLikeBtn.addEventListener('click', () => this.toggleLike());
        if (this.fsDislikeBtn) this.fsDislikeBtn.addEventListener('click', () => this.toggleDislike());
        if (this.fsLightShowBtn) this.fsLightShowBtn.addEventListener('click', () => this.toggleLightShow());

        // Progress bar
        this.progressBar.addEventListener('click', (e) => this.handleProgressClick(e));

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
        this.nowPlayingArtist.textContent = song.artist;

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

        // Always use current text content as the original text
        element.dataset.originalText = element.textContent;

        // Reset classes and styles
        element.classList.remove('scrolling');
        element.style.removeProperty('--scroll-distance');
        element.style.removeProperty('--scroll-duration');

        if (element.scrollWidth > element.clientWidth) {
            // Add separator as part of base text (using non-breaking spaces for consistent width)
            const baseText = element.dataset.originalText + '\u00A0\u00A0\u00A0•\u00A0\u00A0\u00A0';
            element.textContent = baseText;

            // Measure the exact width of the base text
            const baseWidth = element.scrollWidth;

            // Now duplicate for seamless loop
            element.textContent = baseText + baseText;

            const duration = baseWidth / 30; // 30px per second speed

            element.style.setProperty('--scroll-duration', `${Math.max(duration, 5)}s`);
            element.classList.add('scrolling');

            // Add mask to parent when scrolling
            parent.style.maskImage = 'linear-gradient(to right, transparent 0px, black 12px, black calc(100% - 12px), transparent 100%)';
            parent.style.webkitMaskImage = 'linear-gradient(to right, transparent 0px, black 12px, black calc(100% - 12px), transparent 100%)';
        } else {
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
        // Don't update time display while buffering
        if (this.isBuffering) return;

        if (this.audio.duration) {
            const percent = (this.audio.currentTime / this.audio.duration) * 100;

            // Main bar
            this.progressFill.style.width = `${percent}%`;
            this.lastDisplayedTime = this.audio.currentTime;
            this.currentTimeEl.textContent = this.formatTime(this.audio.currentTime);

            // Fullscreen bar
            if (this.fsProgressFill) this.fsProgressFill.style.width = `${percent}%`;
            if (this.fsCurrentTimeEl) this.fsCurrentTimeEl.textContent = this.formatTime(this.audio.currentTime);

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

    handleProgressClick(e, progressBarElement) {
        if (!this.audio.duration) return;

        // Use the passed element (for fullscreen) or default to the main progress bar
        const bar = progressBarElement || this.progressBar;
        const rect = bar.getBoundingClientRect();

        // Calculate relative to the specific bar that was clicked
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

            // Resume light show loop if active
            if (this.lightShowActive) {
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    this.audioContext.resume();
                }
                this.drawLightShow();
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
            
            // Initialize audio context
            this.initAudioContext();
            
            if (this.audioContext && this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
            
            // Start light show loop
            this.drawLightShow();
            window.showToast?.('Light show enabled', 'success');
        } else {
            if (this.fsLightShowBtn) this.fsLightShowBtn.classList.remove('active');
            if (this.fsLightShowCanvas) this.fsLightShowCanvas.classList.add('hidden');
            
            // Reset backdrop to original styles
            if (this.fsBackdrop) {
                this.fsBackdrop.style.transform = 'none';
                this.fsBackdrop.style.opacity = '1';
            }
            window.showToast?.('Light show disabled', 'info');
        }
    }

    initLightShowState() {
        const width = window.innerWidth || 800;
        const height = window.innerHeight || 600;
        
        // Initialize stage spotlights (beams) with 8 concert locations (4 floor, 2 left-wall, 2 right-wall)
        this.lightBeams = [
            // 4 Bottom floor spotlights (index 0 - 3)
            { baseAngle: 0, angle: 0, targetAngle: 0, angularSpeed: 0.08, originX: width * 0.25, originY: height, colorOffset: 0, opacity: 0, recoil: 0, charge: 0, firing: false, fireTimer: 0, cooldown: 0, motionType: 'slow', currentLength: 0 },
            { baseAngle: 0, angle: 0, targetAngle: 0, angularSpeed: 0.08, originX: width * 0.4, originY: height, colorOffset: 1, opacity: 0, recoil: 0, charge: 0, firing: false, fireTimer: 0, cooldown: 0, motionType: 'slow', currentLength: 0 },
            { baseAngle: 0, angle: 0, targetAngle: 0, angularSpeed: 0.08, originX: width * 0.6, originY: height, colorOffset: 2, opacity: 0, recoil: 0, charge: 0, firing: false, fireTimer: 0, cooldown: 0, motionType: 'slow', currentLength: 0 },
            { baseAngle: 0, angle: 0, targetAngle: 0, angularSpeed: 0.08, originX: width * 0.75, originY: height, colorOffset: 3, opacity: 0, recoil: 0, charge: 0, firing: false, fireTimer: 0, cooldown: 0, motionType: 'slow', currentLength: 0 },
            
            // 2 Left-wall side spotlights (index 4 - 5)
            { baseAngle: Math.PI / 2, angle: Math.PI / 2, targetAngle: Math.PI / 2, angularSpeed: 0.08, originX: 0, originY: height * 0.3, colorOffset: 0, opacity: 0, recoil: 0, charge: 0, firing: false, fireTimer: 0, cooldown: 0, motionType: 'slow', currentLength: 0 },
            { baseAngle: Math.PI / 2, angle: Math.PI / 2, targetAngle: Math.PI / 2, angularSpeed: 0.08, originX: 0, originY: height * 0.7, colorOffset: 2, opacity: 0, recoil: 0, charge: 0, firing: false, fireTimer: 0, cooldown: 0, motionType: 'slow', currentLength: 0 },
            
            // 2 Right-wall side spotlights (index 6 - 7)
            { baseAngle: -Math.PI / 2, angle: -Math.PI / 2, targetAngle: -Math.PI / 2, angularSpeed: 0.08, originX: width, originY: height * 0.3, colorOffset: 1, opacity: 0, recoil: 0, charge: 0, firing: false, fireTimer: 0, cooldown: 0, motionType: 'slow', currentLength: 0 },
            { baseAngle: -Math.PI / 2, angle: -Math.PI / 2, targetAngle: -Math.PI / 2, angularSpeed: 0.08, originX: width, originY: height * 0.7, colorOffset: 3, opacity: 0, recoil: 0, charge: 0, firing: false, fireTimer: 0, cooldown: 0, motionType: 'slow', currentLength: 0 }
        ];
        
        // Initialize specialized rise particles with specific audio-band properties
        this.visualParticles = [];
        
        // 1. Bass Particles (slow, large, deep)
        for (let i = 0; i < 12; i++) {
            this.visualParticles.push({
                type: 'bass',
                x: Math.random() * width,
                y: Math.random() * height,
                baseSize: 6 + Math.random() * 6,
                size: 6,
                baseSpeedY: 0.2 + Math.random() * 0.4,
                speedY: 0.3,
                baseSpeedX: (Math.random() - 0.5) * 0.2,
                speedX: 0,
                alpha: 0.12 + Math.random() * 0.15,
                colorOffset: 0 // Main accent
            });
        }
        
        // 2. Mids Particles (medium, wavy, colorful)
        for (let i = 0; i < 22; i++) {
            this.visualParticles.push({
                type: 'mids',
                x: Math.random() * width,
                y: Math.random() * height,
                baseSize: 3 + Math.random() * 2,
                size: 3,
                baseSpeedY: 0.5 + Math.random() * 0.6,
                speedY: 0.6,
                baseSpeedX: (Math.random() - 0.5) * 0.3,
                speedX: 0,
                alpha: 0.2 + Math.random() * 0.3,
                colorOffset: 1 // Complementary purple/blue
            });
        }
        
        // 3. Treble Particles (fast, tiny, energetic stars)
        for (let i = 0; i < 16; i++) {
            this.visualParticles.push({
                type: 'treble',
                x: Math.random() * width,
                y: Math.random() * height,
                baseSize: 1.0 + Math.random() * 1.5,
                size: 1.5,
                baseSpeedY: 1.2 + Math.random() * 1.8,
                speedY: 1.5,
                baseSpeedX: (Math.random() - 0.5) * 0.8,
                speedX: 0,
                alpha: 0.35 + Math.random() * 0.45,
                colorOffset: 3 // Gold/White
            });
        }
        
        // Dynamic spark particles spawned from nozzles
        this.sparkParticles = [];
        
        // Beat detection history
        this.beatDetectHistory = [];
        this.beatThreshold = 1.15;
        this.beatCooldown = 0;
        
        // Expanding shockwaves
        this.shockwaves = [];
        
        // Corner frequency ripple waves
        this.cornerWaves = [];
        
        // Smoothed audio frequency parameters (Exponential LERP)
        this.smoothBass = 0;
        this.smoothMids = 0;
        this.smoothTreble = 0;
        this.smoothSynth = 0;     // Dedicated mid-high synth frequency band
        
        // Deltas for jump detection
        this.lastBass = 0;
        this.lastTreble = 0;
        
        // Music-Energy Choreographer variables
        this.lightShowMode = 'ambient'; // 'ambient' | 'chase' | 'crossover' | 'chorus'
        this.globalEnergy = 0;
        this.chaseIndex = 0;
        this.chaseTimer = 0;
        this.dropStep = 0;
        
        // Center synth visualizer state
        this.synthRotation = 0;   // Slowly rotating aura angle
        this.synthPulseRing = 0;  // Expanding ring triggered by synth spikes
    }

    initAudioContext() {
        if (this.audioContext) return;
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContextClass();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            
            // Allow same-origin stream capture cleanly
            this.audioSource = this.audioContext.createMediaElementSource(this.audio);
            this.audioSource.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
            Logger.log('AudioContext & Analyser Node initialized successfully.');
        } catch (e) {
            Logger.error('Could not initialize AudioContext (requires browser gesture):', e);
        }
    }

    drawLightShow() {
        if (!this.lightShowActive || !this.fsContainer || this.fsContainer.classList.contains('hidden')) {
            return;
        }
        
        const canvas = this.fsLightShowCanvas;
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const width = canvas.width = window.innerWidth;
        const height = canvas.height = window.innerHeight;
        
        // Auto-resume AudioContext if suspended while playing (e.g. after song transition)
        if (this.audioContext && this.audioContext.state === 'suspended' && this.isPlaying) {
            this.audioContext.resume().catch(e => Logger.error('Failed to resume AudioContext in loop:', e));
        }

        // Safe parameter guards to prevent NaN/undefined crash loops
        if (this.smoothBass === undefined || isNaN(this.smoothBass)) this.smoothBass = 0;
        if (this.smoothMids === undefined || isNaN(this.smoothMids)) this.smoothMids = 0;
        if (this.smoothTreble === undefined || isNaN(this.smoothTreble)) this.smoothTreble = 0;
        if (this.smoothEnergy === undefined || isNaN(this.smoothEnergy)) this.smoothEnergy = 0;
        if (this.lastBass === undefined || isNaN(this.lastBass)) this.lastBass = 0;
        if (this.lastTreble === undefined || isNaN(this.lastTreble)) this.lastTreble = 0;
        if (this.dropStep === undefined || isNaN(this.dropStep)) this.dropStep = 0;
        if (this.chaseIndex === undefined || isNaN(this.chaseIndex)) this.chaseIndex = 0;
        if (this.chaseTimer === undefined || isNaN(this.chaseTimer)) this.chaseTimer = 0;

        try {
            // Load user preferences for animations
            let disableLasers = false;
            let showBgBlur = false;
            if (window.app && window.app.user && window.app.user.preferences) {
                let prefs = window.app.user.preferences;
                if (typeof prefs === 'string') {
                    try {
                        prefs = JSON.parse(prefs);
                    } catch (e) { }
                }
                if (prefs) {
                    disableLasers = !!prefs.disable_lasers;
                    showBgBlur = !!prefs.show_bg_blur;
                }
            }

            // Apply background blur filter style to canvas
            if (canvas) {
                if (showBgBlur) {
                    canvas.style.filter = 'blur(40px) brightness(0.95)';
                } else {
                    canvas.style.filter = 'none';
                }
            }

            // Dark premium background with deep trail motion blur
            ctx.fillStyle = 'rgba(10, 10, 15, 0.12)';
            ctx.fillRect(0, 0, width, height);
            
            // Fetch current accent primary color dynamically
            let accentHex = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim() || '#fa586a';
            if (!accentHex.startsWith('#')) {
                accentHex = '#fa586a'; // fallback
            }
            
            // Helper to convert hex to rgba
            const rgba = (hex, alpha) => {
            const r = parseInt(hex.substring(1, 3), 16);
            const g = parseInt(hex.substring(3, 5), 16);
            const b = parseInt(hex.substring(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        };
        
        // Create coordinated color palette based on accent primary
        const palette = [
            rgba(accentHex, 1.0), // Main Accent
            accentHex === '#fa586a' ? 'rgba(175, 82, 222, 1.0)' : 'rgba(0, 191, 255, 1.0)', // Elegant Complementary
            accentHex === '#fa586a' ? 'rgba(0, 122, 255, 1.0)' : 'rgba(255, 127, 80, 1.0)', // Deep contrasting hue
            'rgba(255, 215, 0, 1.0)' // Bright highlight (Gold/Yellow)
        ];
        
        let bass = 0;
        let mids = 0;
        let treble = 0;
        
        if (this.analyser && this.isPlaying) {
            this.analyser.getByteFrequencyData(this.dataArray);
            
            // Bass: low indices 0 to 10
            let bassSum = 0;
            for (let i = 0; i < 10; i++) bassSum += this.dataArray[i];
            bass = bassSum / 10 / 255;
            
            // Mids: mid indices 10 to 45
            let midsSum = 0;
            for (let i = 10; i < 45; i++) midsSum += this.dataArray[i];
            mids = midsSum / 35 / 255;
            
            // Treble: high indices 45 to 100
            let trebleSum = 0;
            for (let i = 45; i < 100; i++) trebleSum += this.dataArray[i];
            treble = trebleSum / 55 / 255;
            
            // Synth: focused mid-high band (indices 25-70) capturing piano / synth / melodic instruments
            let synthSum = 0;
            for (let i = 25; i < 70; i++) synthSum += this.dataArray[i];
            const synth = synthSum / 45 / 255;
            this.smoothSynth += (synth - this.smoothSynth) * 0.15; // Slightly more responsive than bass
        } else if (this.isPlaying) {
            // Simulated premium rhythm if analyzer unavailable
            const time = Date.now() * 0.003;
            bass = 0.4 + 0.3 * Math.sin(time * 2.5);
            mids = 0.3 + 0.3 * Math.sin(time * 1.8 + 1.2);
            treble = 0.2 + 0.2 * Math.sin(time * 4.2 + 2.4);
        } else {
            // Idle ambient rhythm
            const time = Date.now() * 0.0005;
            bass = 0.2 + 0.1 * Math.sin(time);
            mids = 0.1 + 0.1 * Math.sin(time * 0.8 + 1.0);
            treble = 0.05 + 0.05 * Math.sin(time * 1.5 + 2.0);
        }
        
        // Apply exponential smoothing (interpolation / LERP)
        this.smoothBass += (bass - this.smoothBass) * 0.12;
        this.smoothMids += (mids - this.smoothMids) * 0.12;
        this.smoothTreble += (treble - this.smoothTreble) * 0.12;
        // smoothSynth is updated inline inside the analyser block above; initialize fallback here
        if (!this.analyser || !this.isPlaying) {
            const st = Date.now() * 0.001;
            const synthFallback = 0.3 + 0.3 * Math.sin(st * 2.1 + 0.7);
            this.smoothSynth += (synthFallback - this.smoothSynth) * 0.12;
        }
        
        // Initialize coordinated light show state if not set
        if (!this.lightBeams || !this.visualParticles) {
            this.initLightShowState();
        }
        
        // Dynamic bottom offset to sit perfectly above the player bar in standard mode
        const isStandard = this.fsContainer.classList.contains('mode-standard');
        const bottomOffset = isStandard ? 90 : 0;
        const originY = height - bottomOffset;
        
        // Update origin positions dynamically to support window resizing and custom layouts
        // 4 Floor Cannons (index 0 - 3)
        this.lightBeams[0].originX = width * 0.25;
        this.lightBeams[0].originY = originY;
        this.lightBeams[1].originX = width * 0.4;
        this.lightBeams[1].originY = originY;
        this.lightBeams[2].originX = width * 0.6;
        this.lightBeams[2].originY = originY;
        this.lightBeams[3].originX = width * 0.75;
        this.lightBeams[3].originY = originY;
        
        // 2 Left-wall Cannons (index 4 - 5)
        this.lightBeams[4].originX = 0;
        this.lightBeams[4].originY = originY * 0.3;
        this.lightBeams[5].originX = 0;
        this.lightBeams[5].originY = originY * 0.7;
        
        // 2 Right-wall Cannons (index 6 - 7)
        this.lightBeams[6].originX = width;
        this.lightBeams[6].originY = originY * 0.3;
        this.lightBeams[7].originX = width;
        this.lightBeams[7].originY = originY * 0.7;
        
        // ---------------- BEAT & FREQUENCY JUMP DETECTION ----------------
        let isBeat = false;
        if (this.beatCooldown > 0) this.beatCooldown--;
        
        // Record bass level
        this.beatDetectHistory.push(bass);
        if (this.beatDetectHistory.length > 30) this.beatDetectHistory.shift();
        
        // Calculate recent average bass
        const recentAvgBass = this.beatDetectHistory.reduce((sum, v) => sum + v, 0) / this.beatDetectHistory.length;
        
        // Beat trigger criteria (Bass energy jump)
        if (bass > recentAvgBass * this.beatThreshold && bass > 0.35 && this.beatCooldown === 0) {
            isBeat = true;
            this.beatCooldown = 15; // cooldown frames
            
            // Create expanding central shockwave
            this.shockwaves.push({
                x: width / 2,
                y: originY - (height - bottomOffset) / 2, // Centered vertically relative to visual area
                radius: 10,
                maxRadius: Math.min(width, height) * 0.6,
                alpha: 0.6,
                lineWidth: 4,
                color: palette[Math.floor(Math.random() * palette.length)]
            });
        }
        
        // Sharp frequency jumps detection (Delta triggers)
        const trebleDelta = treble - this.lastTreble;
        const bassDelta = bass - this.lastBass;
        this.lastTreble = treble;
        this.lastBass = bass;
        
        // High frequency (treble) delta triggers top corners
        if (trebleDelta > 0.16) {
            const color = palette[3]; // Bright gold/yellow highlight
            this.cornerWaves.push({
                corner: 0, // TL
                radius: 10,
                maxRadius: Math.max(width, height) * 0.85,
                alpha: 0.8,
                lineWidth: 2.5,
                color: color,
                type: 'treble'
            });
            this.cornerWaves.push({
                corner: 1, // TR
                radius: 10,
                maxRadius: Math.max(width, height) * 0.85,
                alpha: 0.8,
                lineWidth: 2.5,
                color: color,
                type: 'treble'
            });
        }
        
        // Low frequency (bass) delta triggers bottom corners
        if (bassDelta > 0.18) {
            const color = palette[Math.floor(Math.random() * 2)]; // Primary or secondary accent
            this.cornerWaves.push({
                corner: 2, // BL
                radius: 15,
                maxRadius: Math.max(width, height) * 0.95,
                alpha: 0.85,
                lineWidth: 4.5,
                color: color,
                type: 'bass'
            });
            this.cornerWaves.push({
                corner: 3, // BR
                radius: 15,
                maxRadius: Math.max(width, height) * 0.95,
                alpha: 0.85,
                lineWidth: 4.5,
                color: color,
                type: 'bass'
            });
        }
        
        // ---------------- DYNAMIC MUSIC-ENERGY CHOREOGRAPHER ----------------
        // Calculate global running energy
        this.globalEnergy = this.smoothBass * 0.4 + this.smoothMids * 0.45 + this.smoothTreble * 0.15;
        this.smoothEnergy = this.smoothEnergy || 0;
        this.smoothEnergy += (this.globalEnergy - this.smoothEnergy) * 0.04;
        
        // Dynamically transition visualizer modes based on running smoothed energy
        if (this.smoothEnergy < 0.18) {
            this.lightShowMode = 'ambient';
        } else if (this.smoothEnergy < 0.45) {
            this.lightShowMode = 'chase';
        } else if (this.smoothEnergy < 0.72) {
            this.lightShowMode = 'crossover';
        } else {
            this.lightShowMode = 'chorus';
        }
        
        // Update firing timers and cooldowns for all 8 spotlights
        // Cooldowns scale strongly with energy - high energy = almost no rest
        const maxCooldown = Math.max(4, 18 - this.smoothEnergy * 15);
        this.lightBeams.forEach((beam, idx) => {
            if (beam.cooldown > 0) beam.cooldown--;
            if (beam.firing) {
                beam.fireTimer--;
                // Re-target beams mid-flight for continuous animation (every ~20 frames for fast, continuous sway for slow)
                if (beam.motionType === 'fast' && beam.fireTimer % 22 === 0) {
                    // Sweep to a new target angle for dynamic in-flight movement
                    const spread = Math.PI / 3 + this.smoothEnergy * 0.4;
                    beam.targetAngle = beam.baseAngle + (Math.random() - 0.5) * spread;
                }
                if (beam.fireTimer <= 0) {
                    beam.firing = false;
                    // Short rest - energy-scaled: at full energy cooldown is nearly 0
                    beam.cooldown = Math.floor(maxCooldown + Math.random() * maxCooldown);
                }
            }
        });
        
        // Max simultaneous beams scales with energy: 1 ambient, 2 chase, 3 crossover/chorus
        const maxBeams = this.lightShowMode === 'ambient' ? 2 :
                         this.lightShowMode === 'chase' ? 2 : 3;

        // Helper: fire a beam with a given target angle and duration
        const fireBeam = (beam, targetAngle, duration, type = 'fast') => {
            beam.firing = true;
            beam.motionType = type;
            beam.fireTimer = duration;
            beam.targetAngle = targetAngle;
            beam.recoil = type === 'fast' ? 8 + Math.random() * 8 : 0;
            // Opening phase: fast beams sweep slowly to position before locking in at full power.
            // Duration scales inversely with energy so chill songs open longer, drops snap faster.
            if (type === 'fast') {
                beam.openTimer = Math.max(6, Math.round(18 - this.smoothEnergy * 12));
            } else {
                beam.openTimer = 0; // slow beams fade in naturally
            }
        };

        // Count currently active beams
        const activeCount = () => this.lightBeams.filter(b => b.firing).length;

        // Find a random available (not firing, cooldown 0) beam, optionally restricted to indices
        const pickAvailable = (indices = null) => {
            const pool = this.lightBeams.filter((b, i) =>
                !b.firing && (b.cooldown || 0) === 0 && (indices === null || indices.includes(i))
            );
            return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
        };

        // Trigger coordinated light show sync patterns
        if (this.lightShowMode === 'ambient') {
            // Ambient: up to 2 beams — at least 1 slow sweep always present, + 1 fast accent on beats
            const activeSlowBeams = this.lightBeams.filter(b => b.firing && b.motionType === 'slow');
            const activeFastBeams = this.lightBeams.filter(b => b.firing && b.motionType === 'fast');

            if (activeSlowBeams.length < 1) {
                // Pick from symmetrical ambient pairs, all 8 positions included
                const ambientCombos = [
                    [4, 6],   // upper wall cradle
                    [0, 3],   // floor outer
                    [1, 2],   // floor inner
                    [5, 7],   // lower wall
                    [1],      // solo lighthouse-left
                    [2],      // solo lighthouse-right
                    [4],      // solo left-wall
                    [6],      // solo right-wall
                ];
                const combo = ambientCombos[Math.floor(Math.random() * ambientCombos.length)];
                combo.forEach(i => {
                    const b = this.lightBeams[i];
                    if ((b.cooldown || 0) === 0 && !b.firing) {
                        fireBeam(b, b.baseAngle + (Math.random() - 0.5) * 0.5, 180 + Math.random() * 140, 'slow');
                    }
                });
            }

            // Add a snappy accent beam on beat (on top of slow sweep)
            if (isBeat && activeFastBeams.length === 0 && activeCount() < maxBeams) {
                const b = pickAvailable();
                if (b) fireBeam(b, b.baseAngle + (Math.random() - 0.5) * (Math.PI / 2.5), 22 + Math.random() * 14);
            }

        } else if (this.lightShowMode === 'chase') {
            // Chase: sequential waterfall, 1-2 beams active, fast spacing
            const chaseSeq = [4, 0, 6, 1, 5, 3, 7, 2];
            if (this.chaseTimer > 0) this.chaseTimer--;

            if ((trebleDelta > 0.08 || isBeat) && this.chaseTimer <= 0) {
                const beamIndex = chaseSeq[this.chaseIndex];
                this.chaseIndex = (this.chaseIndex + 1) % chaseSeq.length;
                const beam = this.lightBeams[beamIndex];

                if ((beam.cooldown || 0) === 0) {
                    if (activeCount() >= 2) {
                        // Drop the beam with least time left to make room
                        const oldest = this.lightBeams.filter(b => b.firing).sort((a, b) => a.fireTimer - b.fireTimer)[0];
                        if (oldest) oldest.firing = false;
                    }
                    const spread = Math.PI / 2.5 + this.smoothEnergy * 0.5;
                    fireBeam(beam, beam.baseAngle + (Math.random() - 0.5) * spread, 28 + Math.random() * 18);
                    this.chaseTimer = Math.max(4, 12 - this.smoothEnergy * 8);
                }
            }

            // Keep filling to 2 beams between beat triggers
            if (activeCount() < 2) {
                const b = pickAvailable();
                if (b) fireBeam(b, b.baseAngle + (Math.random() - 0.5) * (Math.PI / 2.5), 28 + Math.random() * 18);
            }

        } else if (this.lightShowMode === 'crossover') {
            // Crossover: elegant symmetrical pairs, up to 3, let them overlap for depth
            if (isBeat) {
                this.crossoverToggle = ((this.crossoverToggle || 0) + 1) % 4;
                const dur = 28 + Math.random() * 18;
                if (this.crossoverToggle === 0) {
                    const b0 = this.lightBeams[0], b3 = this.lightBeams[3];
                    if (!b0.firing) fireBeam(b0, Math.PI / 5, dur);
                    if (!b3.firing) fireBeam(b3, -Math.PI / 5, dur);
                } else if (this.crossoverToggle === 1) {
                    const b4 = this.lightBeams[4], b6 = this.lightBeams[6];
                    if (!b4.firing) fireBeam(b4, Math.PI / 2 - 0.35, dur);
                    if (!b6.firing) fireBeam(b6, -Math.PI / 2 + 0.35, dur);
                } else if (this.crossoverToggle === 2) {
                    const b1 = this.lightBeams[1], b2 = this.lightBeams[2];
                    if (!b1.firing) fireBeam(b1, -Math.PI / 7, dur);
                    if (!b2.firing) fireBeam(b2, Math.PI / 7, dur);
                } else {
                    const b5 = this.lightBeams[5], b7 = this.lightBeams[7];
                    if (!b5.firing) fireBeam(b5, Math.PI / 2 + 0.35, dur);
                    if (!b7.firing) fireBeam(b7, -Math.PI / 2 - 0.35, dur);
                }
            }
            // Fill up to maxBeams on treble hits
            if (trebleDelta > 0.09 && activeCount() < maxBeams) {
                const b = pickAvailable();
                if (b) fireBeam(b, b.baseAngle + (Math.random() - 0.5) * (Math.PI / 2), 20 + Math.random() * 14);
            }

        } else if (this.lightShowMode === 'chorus') {
            // Chorus (Drop): rolling pairs + fill up to 3 — full energy mode
            if (isBeat) {
                this.dropStep = (this.dropStep + 1) % 4;
                const dur = 24 + Math.random() * 16;
                const chorAngles = [
                    [[Math.PI / 5.2, 0], [-Math.PI / 5.2, 3]],
                    [[Math.PI / 2 - 0.3, 4], [-Math.PI / 2 + 0.3, 6]],
                    [[-Math.PI / 6, 1], [Math.PI / 6, 2]],
                    [[Math.PI / 2 + 0.4, 5], [-Math.PI / 2 - 0.4, 7]],
                ];
                chorAngles[this.dropStep].forEach(([angle, idx]) => {
                    fireBeam(this.lightBeams[idx], angle, dur);
                });
            }
            // Sharp accent bursts for the 3rd beam slot
            if ((trebleDelta > 0.1 || bassDelta > 0.12) && activeCount() < maxBeams) {
                const b = pickAvailable();
                if (b) fireBeam(b, b.baseAngle + (Math.random() - 0.5) * (Math.PI / 1.8), 16 + Math.random() * 12);
            }
            // Keep energy continuously high
            if (Math.random() < 0.07 && activeCount() < maxBeams) {
                const b = pickAvailable();
                if (b) fireBeam(b, b.baseAngle + (Math.random() - 0.5) * (Math.PI / 2), 18 + Math.random() * 14);
            }
        }

        // INTERCEPT DELTAS: frequency spike bursts in ALL modes (within maxBeams cap)
        if (trebleDelta > 0.15 || bassDelta > 0.17) {
            if (activeCount() < maxBeams) {
                const b = pickAvailable();
                if (b) {
                    fireBeam(b, b.baseAngle + (Math.random() - 0.5) * (Math.PI / 2), 18 + Math.random() * 14);
                    b.recoil = 14;
                }
            }
        }
        

        // Update angles with dynamic LERP speeds
        // During openTimer (sweep-in phase): slow lerp so the beam visibly travels to its destination.
        // After openTimer: fast snappy lerp when the beam locks in at full power.
        this.lightBeams.forEach((beam, index) => {
            // Safe fallback initialization for beam parameters to prevent NaN crashes in angle updates
            if (beam.angle === undefined || isNaN(beam.angle)) beam.angle = beam.baseAngle || 0;
            if (beam.targetAngle === undefined || isNaN(beam.targetAngle)) beam.targetAngle = beam.baseAngle || 0;
            if (beam.fireTimer === undefined || isNaN(beam.fireTimer)) beam.fireTimer = 0;
            if (beam.cooldown === undefined || isNaN(beam.cooldown)) beam.cooldown = 0;
            if (beam.openTimer === undefined || isNaN(beam.openTimer)) beam.openTimer = 0;

            if (beam.firing) {
                // Tick down the opening phase
                if (beam.openTimer > 0) beam.openTimer--;

                // During openTimer: creep slowly toward targetAngle (searching sweep feel)
                // After openTimer: snap quickly to the locked angle
                const isOpening = beam.openTimer > 0;
                let lSpeed;
                if (beam.motionType === 'slow') {
                    lSpeed = 0.007;
                } else if (isOpening) {
                    lSpeed = 0.04; // slow sweep-in
                } else {
                    lSpeed = 0.12; // snappy lock-in
                }

                // Slow emotional sweeps sway back and forth during their long duration
                if (beam.motionType === 'slow') {
                    const swayCycle = Math.sin(Date.now() * 0.0012 + index * Math.PI) * 0.35;
                    beam.targetAngle = beam.baseAngle + swayCycle;
                }

                // Mid-flight re-targeting for fast beams (only when already locked, not still opening)
                // This is now handled in the cooldown section above via fireTimer % 22

                beam.angle += (beam.targetAngle - beam.angle) * lSpeed;
            } else {
                // Idle drift: slow sinusoidal sways relative to base angle
                const driftFreq = 0.0008 + index * 0.0002;
                const driftAmp = 0.1 + (index % 4) * 0.03;
                beam.targetAngle = beam.baseAngle + Math.sin(Date.now() * driftFreq) * driftAmp;
                beam.angle += (beam.targetAngle - beam.angle) * 0.025;
            }
        });
        
        // ---------------- DRAW EXPANDING SHOCKWAVES & CORNER WAVES ----------------
        ctx.globalCompositeOperation = 'screen';
        
        // 1. Central Shockwaves
        for (let i = this.shockwaves.length - 1; i >= 0; i--) {
            const sw = this.shockwaves[i];
            sw.radius += (sw.maxRadius - sw.radius) * 0.06;
            sw.alpha *= 0.94;
            
            if (sw.alpha < 0.01 || sw.radius >= sw.maxRadius - 2) {
                this.shockwaves.splice(i, 1);
                continue;
            }
            
            ctx.beginPath();
            ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
            ctx.strokeStyle = sw.color.replace('1.0)', `${sw.alpha})`);
            ctx.lineWidth = sw.lineWidth * sw.alpha;
            ctx.stroke();
            
            ctx.beginPath();
            ctx.arc(sw.x, sw.y, sw.radius * 0.8, 0, Math.PI * 2);
            ctx.strokeStyle = sw.color.replace('1.0)', `${sw.alpha * 0.4})`);
            ctx.lineWidth = sw.lineWidth * 0.5 * sw.alpha;
            ctx.stroke();
        }
        
        // 2. Concentric Corner Waves (Treble = Top Corners, Bass = Bottom Corners)
        for (let i = this.cornerWaves.length - 1; i >= 0; i--) {
            const cw = this.cornerWaves[i];
            cw.radius += (cw.maxRadius - cw.radius) * 0.05;
            cw.alpha *= 0.94;
            
            if (cw.alpha < 0.01 || cw.radius >= cw.maxRadius - 2) {
                this.cornerWaves.splice(i, 1);
                continue;
            }
            
            let cx = 0, cy = 0;
            if (cw.corner === 1) cx = width;
            else if (cw.corner === 2) cy = originY;
            else if (cw.corner === 3) { cx = width; cy = originY; }
            
            // Draw 3 concentric rings per corner wave packet
            for (let rOffset = 0; rOffset < 3; rOffset++) {
                const ringRadius = cw.radius - rOffset * 50;
                if (ringRadius <= 0) continue;
                
                const ringAlpha = cw.alpha * (1.0 - rOffset * 0.25);
                if (ringAlpha <= 0.01) continue;
                
                ctx.beginPath();
                ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
                
                // High-tech premium audio-dashed styling
                if (cw.type === 'treble') {
                    ctx.setLineDash([8, 12]);
                } else {
                    ctx.setLineDash([25, 15]);
                }
                
                ctx.strokeStyle = cw.color.replace('1.0)', `${ringAlpha})`);
                ctx.lineWidth = cw.lineWidth * ringAlpha * (cw.type === 'bass' ? 1.4 : 0.9);
                ctx.stroke();
            }
        }
        ctx.setLineDash([]); // Always reset line dashes immediately after
        
        // ---------------- DRAW SWEEPING LASER CANNONS & BEAMS ----------------
        if (!disableLasers) {
            this.lightBeams.forEach((beam, index) => {
                // Safe fallback initialization for beam parameters to prevent NaN crashes
                if (beam.angle === undefined || isNaN(beam.angle)) beam.angle = beam.baseAngle || 0;
                if (beam.targetAngle === undefined || isNaN(beam.targetAngle)) beam.targetAngle = beam.baseAngle || 0;
                if (beam.opacity === undefined || isNaN(beam.opacity)) beam.opacity = 0;
                if (beam.currentLength === undefined || isNaN(beam.currentLength)) beam.currentLength = 0;
                if (beam.recoil === undefined || isNaN(beam.recoil)) beam.recoil = 0;
                if (beam.charge === undefined || isNaN(beam.charge)) beam.charge = 0;
                if (beam.fireTimer === undefined || isNaN(beam.fireTimer)) beam.fireTimer = 0;
                if (beam.cooldown === undefined || isNaN(beam.cooldown)) beam.cooldown = 0;

                // Calculate dynamic sweeps, widths, opacities, recoil, and charge (all 0 when not active)
                let sweepFactor = 0;
                let targetOpacity = 0;
                let activeWidth = 0;
                let targetRecoil = 0;
                let targetCharge = 0;
                
                if (beam.firing) {
                    const isOpening = (beam.openTimer || 0) > 0;

                    if (beam.motionType === 'slow') {
                        // Slow: soft emotional glow throughout
                        sweepFactor = 0;
                        targetOpacity = 0.14 + this.smoothEnergy * 0.22;
                        activeWidth = 75 + this.smoothEnergy * 65;
                        targetRecoil = 0;
                        targetCharge = 0.15 + this.smoothEnergy * 0.35;
                    } else if (isOpening) {
                        // Opening phase: beam is visibly sweeping to position — dim, narrow, like a spotlight searching
                        sweepFactor = 0;
                        targetOpacity = 0.06 + this.smoothEnergy * 0.08; // very dim
                        activeWidth = 14 + this.smoothEnergy * 18;        // narrow
                        targetRecoil = 0;
                        targetCharge = 0.05;
                    } else {
                        // Locked-in / full power
                        if (index === 0 || index === 4) {
                            sweepFactor = this.smoothBass;
                            targetOpacity = 0.28 + this.smoothBass * 0.65;
                            activeWidth = 40 + this.smoothBass * 110;
                            targetRecoil = this.smoothBass > 0.4 ? (this.smoothBass - 0.4) * 22 : 0;
                            targetCharge = this.smoothBass;
                        } else if (index === 1 || index === 2 || index === 5 || index === 7) {
                            sweepFactor = this.smoothMids;
                            targetOpacity = 0.3 + this.smoothMids * 0.6;
                            activeWidth = 50 + this.smoothMids * 90;
                            targetRecoil = this.smoothMids > 0.3 ? (this.smoothMids - 0.3) * 16 : 0;
                            targetCharge = this.smoothMids;
                        } else {
                            sweepFactor = this.smoothTreble;
                            targetOpacity = 0.35 + this.smoothTreble * 0.55;
                            activeWidth = 30 + this.smoothTreble * 130;
                            targetRecoil = this.smoothTreble > 0.25 ? (this.smoothTreble - 0.25) * 24 : 0;
                            targetCharge = this.smoothTreble;
                        }
                    }
                }
                
                // LERP parameters for smooth visual transitions
                // During opening phase use a faster lerp to reach dim quickly, then slow-rise to full once locked.
                const openPhaseActive = beam.firing && (beam.openTimer || 0) > 0;
                const opacityLerpRate = openPhaseActive
                    ? 0.25  // snap to dim quickly so the sweep is visible
                    : (targetOpacity > beam.opacity ? 0.18 : 0.10); // fade in fast, fade out slower
                beam.opacity += (targetOpacity - beam.opacity) * opacityLerpRate;
                beam.recoil += (targetRecoil - beam.recoil) * 0.22;
                beam.charge += (targetCharge - beam.charge) * 0.15;
                
                // LERP physical beam length projection growth
                const maxBeamLength = Math.max(width, height) * 1.3;
                const targetLength = beam.firing ? maxBeamLength : 0;
                beam.currentLength = beam.currentLength || 0;
                beam.currentLength += (targetLength - beam.currentLength) * 0.12;
                
                // Reset currentLength to 0 if fully off to prevent any weird instant-pops next time it triggers
                if (beam.opacity <= 0.01 && !beam.firing) {
                    beam.currentLength = 0;
                    return;
                }
                
                // Don't draw if laser is completely off
                if (beam.opacity <= 0.01) return;
                
                // Per-beam color: different hues for each spotlight for rich visual variety
                const emitterColor = palette[beam.colorOffset % palette.length];
                const recoil = beam.recoil || 0;
                const barrelTipDist = 28 - recoil;
                
                // Calculate start coordinates EXACTLY at the barrel nozzle tip
                const startX = beam.originX + Math.sin(beam.angle) * barrelTipDist;
                const startY = beam.originY - Math.cos(beam.angle) * barrelTipDist;
                
                const endX = startX + Math.sin(beam.angle) * beam.currentLength;
                const endY = startY - Math.cos(beam.angle) * beam.currentLength;
                
                // Draw colored outer laser glow starting at startX, startY
                const gradX = startX + Math.sin(beam.angle + Math.PI/2) * (activeWidth / 2);
                const gradY = startY - Math.cos(beam.angle + Math.PI/2) * (activeWidth / 2);
                const gradEndX = startX - Math.sin(beam.angle + Math.PI/2) * (activeWidth / 2);
                const gradEndY = startY + Math.cos(beam.angle + Math.PI/2) * (activeWidth / 2);
                
                const grad = ctx.createLinearGradient(gradX, gradY, gradEndX, gradEndY);
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                grad.addColorStop(0.5, emitterColor.replace('1.0)', `${beam.opacity})`));
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(gradX, gradY);
                ctx.lineTo(endX + Math.sin(beam.angle + Math.PI/2) * (activeWidth / 2), endY - Math.cos(beam.angle + Math.PI/2) * (activeWidth / 2));
                ctx.lineTo(endX - Math.sin(beam.angle + Math.PI/2) * (activeWidth / 2), endY + Math.cos(beam.angle + Math.PI/2) * (activeWidth / 2));
                ctx.lineTo(gradEndX, gradEndY);
                ctx.closePath();
                ctx.fill();
                
                // Draw high-intensity glowing white core
                const coreWidth = 6 + (sweepFactor * 10);
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(startX + Math.sin(beam.angle + Math.PI/2) * (coreWidth / 2), startY - Math.cos(beam.angle + Math.PI/2) * (coreWidth / 2));
                ctx.lineTo(endX + Math.sin(beam.angle + Math.PI/2) * (coreWidth / 4), endY - Math.cos(beam.angle + Math.PI/2) * (coreWidth / 4));
                ctx.lineTo(endX - Math.sin(beam.angle + Math.PI/2) * (coreWidth / 4), endY + Math.cos(beam.angle + Math.PI/2) * (coreWidth / 4));
                ctx.lineTo(startX - Math.sin(beam.angle + Math.PI/2) * (coreWidth / 2), startY + Math.cos(beam.angle + Math.PI/2) * (coreWidth / 2));
                ctx.closePath();
                
                const coreGrad = ctx.createLinearGradient(
                    startX + Math.sin(beam.angle + Math.PI/2) * (coreWidth / 2), startY - Math.cos(beam.angle + Math.PI/2) * (coreWidth / 2),
                    startX - Math.sin(beam.angle + Math.PI/2) * (coreWidth / 2), startY + Math.cos(beam.angle + Math.PI/2) * (coreWidth / 2)
                );
                coreGrad.addColorStop(0, 'rgba(255,255,255,0)');
                coreGrad.addColorStop(0.5, `rgba(255, 255, 255, ${beam.opacity * 0.95})`);
                coreGrad.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = coreGrad;
                ctx.fill();
                
                // Dynamic Spark Emitters from nozzles:
                // Spawn spark streaks ONLY during fast snappy bursts
                if (beam.motionType === 'fast' && beam.opacity > 0.1 && Math.random() < 0.2 + sweepFactor * 0.4) {
                    const sparkAngle = beam.angle + (Math.random() - 0.5) * 0.16;
                    const speed = 4 + Math.random() * 8 + (sweepFactor * 9);
                    this.sparkParticles.push({
                        x: startX,
                        y: startY,
                        vx: Math.sin(sparkAngle) * speed,
                        vy: -Math.cos(sparkAngle) * speed,
                        size: 1.5 + Math.random() * 2,
                        alpha: 0.9,
                        color: emitterColor,
                        decay: 0.015 + Math.random() * 0.02
                    });
                }
            });
        }

        // ---------------- DRAW DETAILED LASER CANNONS (ROBOTIC FIXTURES) ----------------
        if (!disableLasers) {
            this.lightBeams.forEach((beam) => {
                // Per-beam color matching the beam itself
                const emitterColor = palette[beam.colorOffset % palette.length];
                const recoil = beam.recoil || 0;
                const charge = beam.charge || 0;
                
                ctx.save();
                ctx.translate(beam.originX, beam.originY);
                ctx.rotate(beam.angle);
                
                // 1. Draw solid pivot base turret (semi-circle dome)
                ctx.fillStyle = 'rgba(20, 20, 26, 0.96)';
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(0, 0, 18, Math.PI, 0); // half circle facing up relative to rotation
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                
                // Dual pivot screws on the turret sides
                ctx.fillStyle = 'rgba(70, 70, 80, 0.9)';
                ctx.beginPath();
                ctx.arc(-11, -3, 3, 0, Math.PI * 2);
                ctx.arc(11, -3, 3, 0, Math.PI * 2);
                ctx.fill();
                
                // 2. Draw elongated techy cannon barrel with Recoil!
                ctx.fillStyle = 'rgba(38, 38, 46, 0.96)';
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.rect(-5.5, -28 + recoil, 11, 28 - recoil);
                ctx.fill();
                ctx.stroke();
                
                // 3. Draw cooling vents/side struts on the barrel (recoil adjusted)
                ctx.fillStyle = 'rgba(75, 75, 88, 0.9)';
                ctx.fillRect(-8.5, -19 + recoil, 3, 10);
                ctx.fillRect(5.5, -19 + recoil, 3, 10);
                
                // 4. Glowing core charge chamber indicator (glows based on charge)
                ctx.fillStyle = emitterColor.replace('1.0)', `${Math.min(1.0, charge * 1.5)})`);
                ctx.fillRect(-2.5, -16 + recoil, 5, 8);
                
                // 5. Draw glowing energy nozzle tip (glows softly when not firing)
                const nozzleOpacity = beam.firing ? Math.min(1.0, beam.opacity * 2.8) : 0.15;
                ctx.fillStyle = emitterColor.replace('1.0)', `${nozzleOpacity})`);
                ctx.beginPath();
                ctx.arc(0, -28 + recoil, 6, 0, Math.PI * 2);
                ctx.closePath();
                ctx.fill();
                
                // 6. Emitter lens core hot-spot flare
                const flareSize = beam.firing ? 15 : 6;
                const lensGlow = ctx.createRadialGradient(0, -28 + recoil, 0, 0, -28 + recoil, flareSize);
                lensGlow.addColorStop(0, beam.firing ? 'rgba(255, 255, 255, 0.95)' : emitterColor.replace('1.0)', '0.3'));
                lensGlow.addColorStop(0.3, emitterColor.replace('1.0)', beam.firing ? '0.5' : '0.1'));
                lensGlow.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = lensGlow;
                ctx.beginPath();
                ctx.arc(0, -28 + recoil, flareSize, 0, Math.PI * 2);
                ctx.fill();
                
                ctx.restore();
            });
        }
        
        // ---------------- DRAW DYNAMIC SPARK PARTICLES ----------------
        ctx.globalCompositeOperation = 'screen';
        for (let i = this.sparkParticles.length - 1; i >= 0; i--) {
            const sp = this.sparkParticles[i];
            sp.x += sp.vx;
            sp.y += sp.vy;
            sp.alpha -= sp.decay;
            
            // Physical drag & minor downward gravity drift
            sp.vy += 0.04;
            sp.vx *= 0.98;
            sp.vy *= 0.98;
            
            if (sp.alpha <= 0.01 || sp.y < -20 || sp.x < -20 || sp.x > width + 20) {
                this.sparkParticles.splice(i, 1);
                continue;
            }
            
            // Draw spark as an energetic streak line
            ctx.beginPath();
            ctx.moveTo(sp.x, sp.y);
            ctx.lineTo(sp.x - sp.vx * 1.5, sp.y - sp.vy * 1.5);
            ctx.strokeStyle = sp.color.replace('1.0)', `${sp.alpha})`);
            ctx.lineWidth = sp.size;
            ctx.lineCap = 'round';
            ctx.stroke();
        }
        
        // ---------------- DRAW FLOATING MUSIC-COORD PARTICLES ----------------
        this.visualParticles.forEach(p => {
            // Apply a radial push force from center on high-energy beats!
            if (isBeat) {
                const dx = p.x - width / 2;
                const dy = p.y - originY / 2;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const force = p.type === 'bass' ? 4.0 : (p.type === 'mids' ? 7.5 : 12.0);
                p.speedX += (dx / dist) * force;
                p.speedY += (dy / dist) * force * -1; // speedY is negative for upward
            }
            
            // Laser beam alignment attraction:
            // Find the nearest active laser beam
            let nearestBeam = null;
            let minDist = 999999;
            this.lightBeams.forEach(beam => {
                if (beam.opacity > 0.05) {
                    // Compute projection on the laser ray (dx = sin(angle), dy = -cos(angle))
                    const ldx = Math.sin(beam.angle);
                    const ldy = -Math.cos(beam.angle);
                    const px = p.x - beam.originX;
                    const py = p.y - beam.originY;
                    
                    const projection = px * ldx + py * ldy;
                    
                    const projX = beam.originX + ldx * projection;
                    const projY = beam.originY + ldy * projection;
                    
                    const distDX = p.x - projX;
                    const distDY = p.y - projY;
                    const dist = Math.sqrt(distDX * distDX + distDY * distDY);
                    
                    if (dist < minDist && projection > 0 && projection < Math.max(width, height) * 1.3) {
                        minDist = dist;
                        nearestBeam = {
                            beam: beam,
                            projX: projX,
                            projY: projY,
                            dist: dist,
                            projection: projection,
                            distDX: distDX,
                            distDY: distDY
                        };
                    }
                }
            });
            
            // Apply magnetics: pull toward and flow along active laser beams
            if (nearestBeam && nearestBeam.dist < 200) {
                const pullStrength = (1.0 - nearestBeam.dist / 200) * 0.12 * nearestBeam.beam.opacity;
                
                // Pull towards the laser beam axis
                p.speedX -= (nearestBeam.distDX / nearestBeam.dist) * pullStrength * 4.0;
                p.speedY -= (nearestBeam.distDY / nearestBeam.dist) * pullStrength * 4.0;
                
                // Flow along the laser direction outwards
                const ldx = Math.sin(nearestBeam.beam.angle);
                const ldy = -Math.cos(nearestBeam.beam.angle);
                const flowStrength = (1.0 - nearestBeam.dist / 200) * 0.18 * nearestBeam.beam.opacity;
                
                p.speedX += ldx * flowStrength * 6.5;
                p.speedY -= ldy * flowStrength * 6.5;
            }
            
            // Decay speeds back to base speed
            p.speedX *= 0.92;
            p.speedY += (p.baseSpeedY - p.speedY) * 0.08;
            
            // Move particle
            p.y -= p.speedY;
            p.x += p.speedX;
            
            // Recycle particle when it goes off screen
            if (p.y < -20 || p.x < -20 || p.x > width + 20) {
                p.y = originY + 10;
                p.x = Math.random() * width;
                p.speedY = p.baseSpeedY;
                p.speedX = p.baseSpeedX;
            }
            
            let currentSize = p.baseSize;
            let currentOpacity = p.alpha;
            const color = palette[p.colorOffset % palette.length];
            
            // ---------------- AUDIO BAND SPECIFIC BEHAVIORS ----------------
            if (p.type === 'bass') {
                // Bass particles pulse in size and opacity deeply
                currentSize = p.baseSize * (1.0 + this.smoothBass * 2.2);
                currentOpacity = p.alpha * (1.0 + this.smoothBass * 1.2);
                p.y -= this.smoothBass * 1.0;
            } else if (p.type === 'mids') {
                // Mids particles weave in a sine wave whose amplitude & speed reflect mids activity
                const waveAmp = 0.5 + this.smoothMids * 4.2;
                const waveFreq = 0.015 + this.smoothMids * 0.02;
                p.x += Math.sin(p.y * waveFreq + Date.now() * 0.003) * waveAmp;
                currentOpacity = p.alpha * (1.0 + this.smoothMids * 1.2);
                currentSize = p.baseSize * (1.0 + this.smoothMids * 0.6);
            } else if (p.type === 'treble') {
                // Treble particles shootout rapidly, flickering like energetic stars
                p.y -= this.smoothTreble * 5.0;
                p.x += (Math.random() - 0.5) * (this.smoothTreble * 3.5);
                currentOpacity = p.alpha * (0.2 + Math.random() * 0.8 * (1.0 + this.smoothTreble * 2.5));
                currentSize = p.baseSize * (1.0 + this.smoothTreble * 1.5);
            }
            
            // Draw particle as a gorgeous glowing circle
            const radial = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, currentSize * 2.5);
            radial.addColorStop(0, color.replace('1.0)', `${currentOpacity})`));
            radial.addColorStop(0.3, color.replace('1.0)', `${currentOpacity * 0.4})`));
            radial.addColorStop(1.0, 'rgba(0,0,0,0)');
            
            ctx.fillStyle = radial;
            ctx.beginPath();
            ctx.arc(p.x, p.y, currentSize * 2.5, 0, Math.PI * 2);
            ctx.fill();
        });
        
        // ---------------- SYNTH-REACTIVE CENTER VISUALIZER ----------------
        const cx = width / 2;
        const cy = originY - (height - bottomOffset) / 2;
        const centerColor = palette[0];  // Accent color
        const centerColor2 = palette[1]; // Complementary
        
        // Parse accent hex to r,g,b for rgba construction
        const acR = parseInt(accentHex.substring(1,3),16);
        const acG = parseInt(accentHex.substring(3,5),16);
        const acB = parseInt(accentHex.substring(5,7),16);
        
        // -- Outer ambient halo (breathes with mids) --
        const haloRadius = Math.min(width, height) * 0.28 * (0.7 + this.smoothMids * 0.6);
        const haloGrad = ctx.createRadialGradient(cx, cy, haloRadius * 0.35, cx, cy, haloRadius);
        haloGrad.addColorStop(0, `rgba(${acR},${acG},${acB},${0.10 + this.smoothMids * 0.10})`);
        haloGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = haloGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, haloRadius, 0, Math.PI * 2);
        ctx.fill();
        
        // -- Frequency bar ring (48 bars mapped to synth FFT bins 25..70) --
        if (this.analyser && this.isPlaying && this.dataArray) {
            const barCount = 48;
            const ringRadius = Math.min(width, height) * 0.11 + this.smoothSynth * Math.min(width,height) * 0.03;
            const maxBarHeight = Math.min(width, height) * 0.09;
            
            for (let i = 0; i < barCount; i++) {
                // Map bar index to FFT bins 25..70 (45 bins total)
                const binIdx = 25 + Math.round(i * 45 / barCount);
                const binVal = this.dataArray[Math.min(binIdx, this.dataArray.length - 1)] / 255;
                const barH = binVal * maxBarHeight;
                if (barH < 0.5) continue; // skip silent bars
                
                const angle = (i / barCount) * Math.PI * 2 + this.synthRotation;
                const innerX = cx + Math.cos(angle) * ringRadius;
                const innerY = cy + Math.sin(angle) * ringRadius;
                const outerX = cx + Math.cos(angle) * (ringRadius + barH);
                const outerY = cy + Math.sin(angle) * (ringRadius + barH);
                
                // Color shifts across the ring — accent at top, complementary at sides
                const colorT = (Math.sin(angle * 2 + this.synthRotation) + 1) / 2;
                const barAlpha = 0.5 + binVal * 0.5;
                
                ctx.beginPath();
                ctx.moveTo(innerX, innerY);
                ctx.lineTo(outerX, outerY);
                ctx.strokeStyle = colorT < 0.5
                    ? `rgba(${acR},${acG},${acB},${barAlpha})`
                    : centerColor2.replace('1.0)', `${barAlpha})`);
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.stroke();
            }
        } else {
            // Fallback idle ring — gentle glow circle
            const idleRadius = Math.min(width, height) * 0.11 * (0.9 + 0.1 * Math.sin(Date.now() * 0.002));
            ctx.beginPath();
            ctx.arc(cx, cy, idleRadius, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${acR},${acG},${acB},0.28)`;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        
        // -- Rotating aura arc (spins faster during synth spikes) --
        this.synthRotation += 0.003 + this.smoothSynth * 0.025;
        const auraRadius = Math.min(width, height) * 0.10;
        const arcLen = (0.5 + this.smoothSynth * 1.1) * Math.PI; // arc length grows with synth
        
        // Use stroke arc as a glowing sweep
        ctx.beginPath();
        ctx.arc(cx, cy, auraRadius, this.synthRotation, this.synthRotation + arcLen);
        ctx.strokeStyle = `rgba(${acR},${acG},${acB},${0.35 + this.smoothSynth * 0.55})`;
        ctx.lineWidth = 5 + this.smoothSynth * 7;
        ctx.lineCap = 'round';
        ctx.stroke();
        
        // Mirror arc on opposite side for symmetry during chorus
        if (this.lightShowMode === 'chorus' || this.lightShowMode === 'crossover') {
            ctx.beginPath();
            ctx.arc(cx, cy, auraRadius, this.synthRotation + Math.PI, this.synthRotation + Math.PI + arcLen);
            ctx.strokeStyle = centerColor2.replace('1.0)', `${0.28 + this.smoothSynth * 0.45})`);
            ctx.lineWidth = 4 + this.smoothSynth * 5;
            ctx.stroke();
        }
        
        // -- Core orb (tight, bright, accent-colored, synth-driven) --
        const coreRadius = Math.min(width, height) * 0.042 * (0.8 + this.smoothSynth * 0.55 + (isBeat ? 0.4 : 0));
        const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius);
        coreGrad.addColorStop(0, `rgba(255,255,255,${0.70 + this.smoothSynth * 0.30})`);
        coreGrad.addColorStop(0.2, `rgba(${acR},${acG},${acB},${0.85 + this.smoothSynth * 0.15})`);
        coreGrad.addColorStop(0.65, `rgba(${acR},${acG},${acB},${0.30 + this.smoothSynth * 0.25})`);
        coreGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = coreGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
        ctx.fill();
        
        // Beat pulse ring (expands on isBeat)
        if (isBeat) this.synthPulseRing = coreRadius * 1.5;
        if (this.synthPulseRing > 0) {
            this.synthPulseRing += Math.min(width, height) * 0.006; // expand speed
            const ringAlpha = Math.max(0, 0.85 - this.synthPulseRing / (Math.min(width, height) * 0.18));
            if (ringAlpha > 0.01) {
                ctx.beginPath();
                ctx.arc(cx, cy, this.synthPulseRing, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(${acR},${acG},${acB},${ringAlpha})`;
                ctx.lineWidth = 3;
                ctx.stroke();
            } else {
                this.synthPulseRing = 0;
            }
        }
        
        // ---------------- SYNC BACKDROP SCALE ----------------
        if (this.fsBackdrop) {
            const scaleVal = 1.0 + this.smoothBass * 0.05 + (isBeat ? 0.02 : 0);
            const opacityVal = 0.12 + (1.0 - this.smoothBass) * 0.24; // Dim background during high energy to emphasize the light show!
            this.fsBackdrop.style.transform = `scale(${scaleVal})`;
            this.fsBackdrop.style.opacity = `${opacityVal}`;
        }
        
        } catch (error) {
            Logger.error("Error in drawLightShow loop:", error);
        }
        
        // Queue next frame
        requestAnimationFrame(() => this.drawLightShow());
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
