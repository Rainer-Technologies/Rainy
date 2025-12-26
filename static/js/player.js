/**
 * Rainy Music Player - Audio Player Controller
 * Handles audio playback, progress, volume, and queue
 */

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

        // Progress bar
        this.progressBar.addEventListener('click', (e) => this.handleProgressClick(e));

        // Volume
        this.volumeSlider.addEventListener('input', (e) => this.handleVolumeChange(e));

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));
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
    }

    updateVolumeGradient() {
        const percent = this.volumeSlider.value;
        this.volumeSlider.style.setProperty('--volume-percent', `${percent}%`);
    }

    playSong(index, playlist = null) {
        if (playlist) {
            this.playlist = playlist;
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

        // Play
        this.audio.play().catch(err => {
            console.error('Playback error:', err);
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
            this.audio.play().catch(err => console.error('Play error:', err));
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
        console.error('Audio error:', e);
        this.isBuffering = false;
    }

    handleWaiting() {
        // Audio is waiting for data (buffering)
        this.isBuffering = true;
        console.log('Audio buffering...');
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
                break;
            case 'ArrowDown':
                e.preventDefault();
                this.audio.volume = Math.max(0, this.audio.volume - 0.1);
                this.volumeSlider.value = this.audio.volume * 100;
                this.updateVolumeGradient();
                break;
        }
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
            this.fsContainer.classList.remove('hidden');
            // Trigger reflow
            void this.fsContainer.offsetWidth;
            this.fsContainer.classList.add('active');
            this.updateFullscreenView();
        } else {
            this.fsContainer.classList.remove('active');
            // Wait for transition to finish
            setTimeout(() => {
                this.fsContainer.classList.add('hidden');
            }, 300);
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
        
        // Optimization: If list length matches and we just need to update active state
        // This is a naive check but helps prevent flickering on every song change if playlist is same
        // For now, let's just re-render to be safe and simple
        
        const html = this.playlist.map((song, index) => {
            const isActive = index === this.currentIndex;
            const coverHtml = song.cover_path
                ? `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}" alt="Cover" loading="lazy">`
                : `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
                
            return `
                <div class="fs-queue-item ${isActive ? 'active' : ''}" data-index="${index}" onclick="window.player.playSong(${index})">
                    <div class="fs-queue-cover">${coverHtml}</div>
                    <div class="fs-queue-info">
                        <div class="fs-queue-title">${window.escapeHtml ? window.escapeHtml(song.title) : song.title}</div>
                        <div class="fs-queue-artist">${window.escapeHtml ? window.escapeHtml(song.artist) : song.artist}</div>
                    </div>
                    <div class="fs-queue-duration">${this.formatTime(song.duration)}</div>
                </div>
            `;
        }).join('');
        
        this.fsQueueList.innerHTML = html;
        
        // Scroll to current song
        const activeItem = this.fsQueueList.querySelector('.active');
        if (activeItem) {
            setTimeout(() => {
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }
    }
}
