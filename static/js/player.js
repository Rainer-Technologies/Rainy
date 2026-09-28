/**
 * Rainy Music Player - Audio Player Controller
 * Handles audio playback, progress, volume, queue, and reactions
 */
import { Logger } from './helper/logger.js';
import { LightShowEngine } from './lightshow.js';
import { usePlaylistService } from './services/playlist.js';
import { useRatingService } from './services/rating.js';
import { usePlaybackService } from './services/playback.js';
import { useConnectService } from './services/connect.js';
import { useMusicService } from './services/music.js';
import { useContext } from './helper/context.js';
import { Utils } from './modules/utils.js';
import { pickBpmAwareShuffleIndex } from './modules/bpmShuffle.js';
import { MediaSessionController } from './modules/mediaSession.js';
import { SleepTimer } from './modules/sleepTimer.js';

export class AudioPlayer {
    constructor() {
        this.audio = document.getElementById('audio-player');
        this.playlist = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        this.isShuffle = false;
        this.repeatMode = 'none'; // 'none', 'all', 'one'
        this.tempoBySongId = new Map();
        this._tempoMapLoaded = false;
        this._tempoMapPromise = null;
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
        this.lyricsEffect = 'default';
        this.lyricsAudioSync = false;
        this._activeWordEls = null;
        this._activeWordLit = -1;
        this._slideWordFracs = null;
        this._slideFracsDirty = true;
        this._slideP = null;
        this._slideSnap = true;
        this._lyricsWordTimes = null;
        this._lyricsWordEnds = null;
        this._lyricsAnalysis = null;
        this._lyricsAnalysisSongId = null;
        this._lyricsAnalysisPromise = null;

        // A-B Repeat (section loop)
        this.abPointA = null; // seconds
        this.abPointB = null; // seconds

        // Equalizer (Web Audio API)
        this._eqContext = null;
        this._eqSource = null;
        this._eqFilters = [];
        this._eqEnabled = false;
        this._eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 10 bands

        // Crossfade
        this.crossfadeAudio = null; // secondary <audio> element
        this._crossfadeEnabled = false;
        this._crossfadeDuration = 5; // seconds
        this._crossfading = false;
        this._crossfadeRaf = null;
        this._crossfadeTriggered = false; // prevent re-trigger within same song
        this._activeBlobUrl = null; // blob URL currently assigned to this.audio.src

        // Rainy Connect (cross-device control)
        this._connectDeviceId = null; // persistent id, generated in _initConnect()
        this._connectDeviceName = 'Web Player';
        this._connectHeartbeatTimer = null;
        this._connectPollTimer = null;

        // Controller mode: this player acts as a remote for another device
        this._controllerTarget = null; // { device_id, device_name } when controlling
        this._controllerPollTimer = null;
        this._controllerState = null; // last known remote state snapshot
        this._controllerBanner = null; // DOM element
        this._controllerPollFailures = 0;
        this._lastControllerCommandMs = 0;

        this.init();
    }

    init() {
        this.bindElements();
        this.bindEvents();
        this.loadSettings();
        this.restorePlaybackSpeed();
        this.restoreEq();
        this.restoreCrossfade();

        // Media Session API (lock screen / media keys)
        this.mediaSession = new MediaSessionController(this);
        // Sleep timer with fade-out
        this.sleepTimer = new SleepTimer(this);
        // Real listening-time tracker (replaces instant play recording)
        this._listenTracker = null;

        // Rainy Connect — register this player as a controllable device
        this._initConnect();
    }

    bindElements() {
        // Buttons
        this.playPauseBtn = document.getElementById('play-pause-btn');
        this.prevBtn = document.getElementById('prev-btn');
        this.nextBtn = document.getElementById('next-btn');
        this.shuffleBtn = document.getElementById('shuffle-btn');
        this.repeatBtn = document.getElementById('repeat-btn');

        // A-B Repeat
        this.abRepeatBtn = document.getElementById('ab-repeat-btn');
        this.abLoopRegion = document.getElementById('ab-loop-region');

        // Playback Speed
        this.speedBtn = document.getElementById('speed-btn');
        this.speedLabel = document.getElementById('speed-label');

        // Equalizer
        this.eqBtn = document.getElementById('eq-btn');

        // Crossfade
        this.crossfadeBtn = document.getElementById('crossfade-btn');
        this.crossfadeAudio = document.getElementById('crossfade-audio');

        // Progress
        this.progressBar = document.getElementById('progress-bar');
        this.progressFill = document.getElementById('progress-fill');
        this.currentTimeEl = document.getElementById('current-time');
        this.totalTimeEl = document.getElementById('total-time');

        // Volume
        this.volumeSlider = document.getElementById('volume-slider');
        this.volumeReadout = document.getElementById('volume-readout');

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
        this.fsLightShowCanvas3d = document.getElementById('fs-lightshow-canvas-3d');
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

        window.addEventListener('resize', () => {
            this._slideFracsDirty = true;
        });

        // Flush listening stats when the page/tab is closed (beacon survives unload)
        window.addEventListener('beforeunload', () => this._flushListenTracking(true));

        // Reset listen-tracker clock when tab visibility changes so hidden gaps
        // don't inflate or get rejected by the >5s guard
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                if (this._listenTracker) this._listenTracker.lastTick = Date.now();
                // Browsers suspend AudioContexts when the tab is hidden.
                // Resume so audio isn't silent when the user returns.
                if (this._eqContext && this._eqContext.state === 'suspended' && !this.audio.paused) {
                    this._eqContext.resume();
                }
            }
        });

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
        if (this.abRepeatBtn) this.abRepeatBtn.addEventListener('click', () => this.handleAbRepeatClick());
        if (this.speedBtn) this.speedBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showSpeedMenu(this.speedBtn); });
        if (this.eqBtn) this.eqBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showEqMenu(this.eqBtn); });
        if (this.crossfadeBtn) this.crossfadeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showCrossfadeMenu(this.crossfadeBtn); });
        if (this.likeBtn) this.likeBtn.addEventListener('click', () => this.toggleLike());
        if (this.dislikeBtn) this.dislikeBtn.addEventListener('click', () => this.toggleDislike());

        // Sleep timer button
        const sleepBtn = document.getElementById('sleep-timer-btn');
        if (sleepBtn) sleepBtn.addEventListener('click', () => this.showSleepTimerMenu(sleepBtn));

        // Queue button — toggle fullscreen player queue tab
        const queueBtn = document.getElementById('queue-btn');
        if (queueBtn) queueBtn.addEventListener('click', () => {
            this.toggleFullscreen();
            // Switch to queue tab if available
            const queueTab = document.querySelector('.fs-tab[data-tab="queue"]');
            if (queueTab) queueTab.click();
        });

        // Fullscreen events
        if (this.nowPlayingContainer) {
            this.nowPlayingContainer.addEventListener('click', (e) => {
                // Prevent opening if clicking buttons or artist links inside the container
                if (e.target.closest('button')) return;
                if (e.target.closest('.now-playing-artist')) return;
                this.toggleFullscreen();
            });
            this.nowPlayingContainer.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target.closest('button')) return;
                e.preventDefault();
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
        if (this.fsVolumeSlider) this._bindVolumeWheel(this.fsVolumeSlider);
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
        this._bindVolumeWheel(this.volumeSlider);

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
            this.volumeSlider.value = Math.round(parseFloat(savedVolume) * 1000) / 10;
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
        if (this.volumeReadout) this.volumeReadout.textContent = this._formatVolumePercent(percent);
    }

    /**
     * Format a 0-100 volume value for the live readout. Whole numbers render
     * as "80%"; fractional (fine-tuned) values keep one decimal, e.g. "80.5%".
     */
    _formatVolumePercent(percent) {
        const n = Number(percent);
        if (!Number.isFinite(n)) return '—';
        return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`;
    }

    /**
     * Re-sync the volume slider(s), gradient fill, and readout from the current
     * audio state (used after mute toggles / external volume changes). Does NOT
     * touch audio.volume or localStorage.
     */
    syncVolumeUI() {
        if (!this.audio || !this.volumeSlider) return;
        const pct = this.audio.muted ? 0 : Math.round(this.audio.volume * 1000) / 10;
        this.volumeSlider.value = pct;
        this.updateVolumeGradient();
        if (this.fsVolumeSlider) {
            this.fsVolumeSlider.value = pct;
            this.updateFsVolumeGradient();
        }
    }

    /**
     * Add scroll-wheel fine-tuning to a volume slider: ±1% per notch, or ±0.1%
     * while holding Shift. Routes through setVolume so everything stays in sync.
     */
    _bindVolumeWheel(slider) {
        if (!slider) return;
        slider.addEventListener('wheel', (e) => {
            e.preventDefault();
            const dir = e.deltaY < 0 ? 1 : -1; // scroll up = louder
            const step = e.shiftKey ? 0.1 : 1;
            const next = Math.max(0, Math.min(100, parseFloat(slider.value) + dir * step));
            // Mirror handleVolumeChange: in controller mode send to the remote
            // device instead of changing local volume.
            if (this.isControllerMode) { this._controllerCommand('volume', { volume: next }); return; }
            this.setVolume(next / 100);
        }, { passive: false });
    }
    updateFsVolumeGradient() {
        if (!this.fsVolumeSlider) return;
        const percent = this.fsVolumeSlider.value;
        this.fsVolumeSlider.style.setProperty('--volume-percent', `${percent}%`);
    }

    playSong(index, playlist = null, context = null) {
        // Controller mode: route playback to the remote device
        // BUT: if this is a Connect command (context.type === 'connect'), 
        // we're the target — play locally, don't forward.
        if (this.isControllerMode && context?.type !== 'connect') {
            const pl = playlist || this.playlist;
            if (pl && pl.length > 0) {
                const queue = pl.slice(0, 200).map(s => ({
                    id: s?.id ?? null,
                    title: s?.title ?? null,
                    artist: s?.artist ?? null,
                    album: s?.album ?? null,
                    duration: s?.duration ?? 0,
                    cover_path: s?.cover_path ?? null,
                })).filter(s => s.id != null);
                this._controllerCommand('play_queue', { queue, index });
            }
            return;
        }

        // Cancel any in-progress crossfade
        if (this._crossfading) this._cancelCrossfade();
        this._crossfadeTriggered = false;

        if (playlist) {
            this.playlist = playlist;
            // Reset queue modifications when switching to a new playlist/context
            this.queueModified = false;
            this.queueOperations = [];
        }

        if (this.playlist.length > 1) {
            this._ensureTempoMap();
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

        // Clear any A-B section loop from the previous song
        this.clearAbRepeat();

        // Update audio source - API now uses database ID; preview/discover
        // songs use the YouTube preview proxy instead.
        const streamUrl = song.videoId
            ? `/api/music/discover/preview/${song.videoId}`
            : `/api/music/stream/${song.id}`;
        // Revoke any blob URL from a previous crossfade before replacing src
        if (this._activeBlobUrl) {
            URL.revokeObjectURL(this._activeBlobUrl);
            this._activeBlobUrl = null;
        }
        this.audio.src = streamUrl;

        // Update now playing info
        this.updateNowPlaying(song);

        // Refresh lyrics for the new song if the panel is open (library only)
        if (this.lyricsActive && !song.videoId) {
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
        // (library songs only — preview tracks have no choreography)
        if (this.lightShow && !song.videoId) this.lightShow.loadScript(song.id);

        // Render clickable artist links in player bar (deduplicated)
        const _splitP = (window.Utils && window.Utils.splitArtists) ? window.Utils.splitArtists : (raw) => { const seen=new Set(); const out=[]; for(const p of String(raw||'Unknown Artist').split(',')){const n=p.trim(); if(!n)continue; const k=n.toLowerCase(); if(!seen.has(k)){seen.add(k); out.push(n);} } return out.length?out:['Unknown Artist']; };
        const artistNames = _splitP(song.artist || 'Unknown Artist');
        const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${Utils.escapeHtml(name)}">${Utils.escapeHtml(name)}</span>`).join(', ');
        this.nowPlayingArtist.innerHTML = artistLinksHtml;

        // Update cover art if available
        if (song.cover_path) {
            this.nowPlayingArtwork.innerHTML = `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}?t=${Date.now()}" alt="Cover" loading="lazy">`;
        } else if (song.cover_url) {
            // Preview/discover tracks carry a remote cover URL
            this.nowPlayingArtwork.innerHTML = `<img src="${song.cover_url}" alt="Cover" loading="lazy" referrerpolicy="no-referrer">`;
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

        // Push to Media Session API (lock screen / OS media controls)
        if (this.mediaSession) this.mediaSession.updateMetadata(song);

        // Start tracking real listening time for this song (library only —
        // preview tracks don't write play history)
        if (!song.videoId) this._startListenTracking(song);

        // Update fullscreen view if active
        if (this.fsContainer && !this.fsContainer.classList.contains('hidden')) {
            this.updateFullscreenView();
        }

        // Update playing state in library
        if (window.app && !song.videoId && !song.djTalk) {
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
        if (this.isControllerMode) { this._controllerCommand('play_pause'); return; }
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
        if (this.isControllerMode) { this._controllerCommand('previous'); return; }
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

    async playNext() {
        if (this.isControllerMode) { this._controllerCommand('next'); return; }
        if (!this.playlist.length) return;

        if (this.isShuffle) {
            await this._ensureTempoMap();
        }

        let newIndex = this.currentIndex + 1;

        if (this.isShuffle) {
            newIndex = this._pickShuffleIndex();
        }

        if (newIndex < 0) return;

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

    _pickShuffleIndex() {
        return pickBpmAwareShuffleIndex(
            this.playlist,
            this.currentIndex,
            this.tempoBySongId,
        );
    }

    async _ensureTempoMap() {
        if (this._tempoMapLoaded) return this.tempoBySongId;
        if (this._tempoMapPromise) return this._tempoMapPromise;

        this._tempoMapPromise = useMusicService().tempoMap()
            .then(result => {
                if (result.error) {
                    Logger.warn('Tempo map unavailable, using normal shuffle:', result.error);
                    return this.tempoBySongId;
                }

                for (const entry of (result.value?.tempos || [])) {
                    const bpm = Number(entry?.tempo_bpm);
                    if (entry?.song_id != null && Number.isFinite(bpm) && bpm > 0) {
                        this.tempoBySongId.set(String(entry.song_id), bpm);
                    }
                }
                return this.tempoBySongId;
            })
            .catch(error => {
                Logger.warn('Tempo map unavailable, using normal shuffle:', error);
                return this.tempoBySongId;
            })
            .finally(() => {
                // Do not keep retrying on every timeupdate if an older server
                // has no feature table yet. Missing data already has a safe
                // random-shuffle fallback.
                this._tempoMapLoaded = true;
                this._tempoMapPromise = null;
            });

        return this._tempoMapPromise;
    }

    toggleShuffle() {
        if (this.isControllerMode) { this._controllerCommand('shuffle', { enabled: !(this._controllerState?.is_shuffled) }); return; }
        this.isShuffle = !this.isShuffle;
        if (this.isShuffle) this._ensureTempoMap();
        const color = this.isShuffle ? 'var(--accent-primary)' : '';
        const fill = this.isShuffle ? 'var(--accent-primary)' : '';

        this.shuffleBtn.style.color = color;
        this.shuffleBtn.querySelector('svg').style.fill = fill;
        this.shuffleBtn.setAttribute('aria-pressed', String(this.isShuffle));

        if (this.fsShuffleBtn) {
            this.fsShuffleBtn.style.color = color;
            this.fsShuffleBtn.querySelector('svg').style.fill = fill;
            this.fsShuffleBtn.setAttribute('aria-pressed', String(this.isShuffle));
        }
    }

    toggleRepeat() {
        if (this.isControllerMode) {
            const order = ['none', 'all', 'one'];
            const current = this._controllerState?.repeat_mode || 'none';
            const next = order[(order.indexOf(current) + 1) % order.length];
            this._controllerCommand('repeat', { mode: next });
            return;
        }
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
                    btn.setAttribute('aria-pressed', 'false');
                    btn.setAttribute('aria-label', 'Repeat off');
                    svg.innerHTML = `<path d="${baseLoopPath}" />`;
                    break;
                case 'all':
                    svg.style.fill = 'var(--accent-primary)';
                    btn.title = 'Repeat All';
                    btn.setAttribute('aria-pressed', 'true');
                    btn.setAttribute('aria-label', 'Repeat all');
                    svg.innerHTML = `<path d="${baseLoopPath}" /><circle cx="12" cy="12" r="2" />`;
                    break;
                case 'one':
                    svg.style.fill = 'var(--accent-primary)';
                    btn.title = 'Repeat One';
                    btn.setAttribute('aria-pressed', 'true');
                    btn.setAttribute('aria-label', 'Repeat one');
                    // Add the "1" inside
                    svg.innerHTML = `<path d="${baseLoopPath}" /><path d="M13 15V9h-1l-2 1v1h1.5v4H13z" />`;
                    break;
            }
        };

        updateBtn(this.repeatBtn);
        updateBtn(this.fsRepeatBtn);
    }

    /* ========================================================================
       A-B Repeat (Section Loop)
       Click once to set point A (start), again to set point B (end) and start
       looping, a third time to clear. Great for practicing a solo/riff or
       replaying a favorite section of a song.
       ======================================================================== */
    handleAbRepeatClick() {
        if (!this.audio || !this.audio.duration) {
            window.showToast?.('Play a song first to use A-B repeat', 'info');
            return;
        }

        const t = this.audio.currentTime;

        if (this.abPointA === null) {
            // First click: set point A
            this.abPointA = t;
            this.abPointB = null;
            window.showToast?.(`A-B repeat: start set at ${this.formatTime(t)}`, 'info');
        } else if (this.abPointB === null) {
            // Second click: set point B
            if (t <= this.abPointA + 0.5) {
                // Too close / before A — treat as resetting A
                this.abPointA = t;
                window.showToast?.(`A-B repeat: start moved to ${this.formatTime(t)}`, 'info');
            } else {
                this.abPointB = t;
                // Jump back to A so the loop starts cleanly
                this.audio.currentTime = this.abPointA;
                if (this.audio.paused) this.audio.play().catch(() => {});
                window.showToast?.(
                    `Looping ${this.formatTime(this.abPointA)} → ${this.formatTime(this.abPointB)}`,
                    'success'
                );
            }
        } else {
            // Third click: clear the loop
            this.clearAbRepeat();
            window.showToast?.('A-B repeat cleared', 'info');
            return;
        }

        this.updateAbRepeatUI();
    }

    clearAbRepeat() {
        this.abPointA = null;
        this.abPointB = null;
        this.updateAbRepeatUI();
    }

    updateAbRepeatUI() {
        const active = this.abPointA !== null && this.abPointB !== null;

        // Toggle active class on the button
        if (this.abRepeatBtn) {
            this.abRepeatBtn.classList.toggle('active', active);
        }

        // Position the loop-region overlay on the progress bar
        if (this.abLoopRegion) {
            if (active && this.audio.duration) {
                const startPct = (this.abPointA / this.audio.duration) * 100;
                const widthPct = ((this.abPointB - this.abPointA) / this.audio.duration) * 100;
                this.abLoopRegion.style.left = `${startPct}%`;
                this.abLoopRegion.style.width = `${widthPct}%`;
                this.abLoopRegion.classList.remove('hidden');
            } else {
                this.abLoopRegion.classList.add('hidden');
            }
        }
    }

    /**
     * Enforce the A-B loop boundary during playback. Called from timeupdate.
     * When currentTime reaches/exceeds point B, jump back to point A.
     */
    _enforceAbLoop() {
        if (this.abPointA === null || this.abPointB === null) return;
        if (this.audio.currentTime >= this.abPointB) {
            this.audio.currentTime = this.abPointA;
        }
    }

    handleTimeUpdate() {
        // Don't update time display while buffering or dragging progress
        if (this.isBuffering || this.isDraggingProgress) return;

        // Accumulate real listening time (only counts while actually playing)
        if (this.isPlaying) this._tickListenTracking();

        // Enforce A-B loop boundary before updating the progress display
        this._enforceAbLoop();

        // Check if we should trigger a crossfade
        this._checkCrossfade();

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
        this.likeBtn?.setAttribute('aria-pressed', String(!!isLiked));
        this.dislikeBtn?.setAttribute('aria-pressed', String(!!isDisliked));
        this.fsLikeBtn?.setAttribute('aria-pressed', String(!!isLiked));
        this.fsDislikeBtn?.setAttribute('aria-pressed', String(!!isDisliked));
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
        // Flush listening stats for the song that just ended
        this._flushListenTracking();

        // If a crossfade is in progress, the secondary audio is already
        // playing the next song — don't call playNext() again.
        if (this._crossfading) return;

        // If a crossfade just completed, the primary's src was already
        // swapped to the next song and the old song's `ended` event fires
        // late. Swallow it so playNext() doesn't restart from position 0.
        if (this._crossfadeTriggered) {
            this._crossfadeTriggered = false;
            return;
        }

        if (this.repeatMode === 'one') {
            this.audio.currentTime = 0;
            this.audio.play();
        } else {
            this.playNext();
        }
    }

    handlePlay() {
        this.isPlaying = true;
        // Reset listen-tracker clock so the pause gap isn't counted as listening
        if (this._listenTracker) this._listenTracker.lastTick = Date.now();

        // Resume the EQ AudioContext if it was suspended (browsers suspend it
        // on pause/tab-switch). Once createMediaElementSource is wired, ALL
        // audio routes through the graph — a suspended context = silence.
        if (this._eqContext && this._eqContext.state === 'suspended') {
            this._eqContext.resume();
        }

        this.iconPlay.classList.add('hidden');
        this.iconPause.classList.remove('hidden');
        this.playPauseBtn?.setAttribute('aria-label', 'Pause');
        this.playPauseBtn?.setAttribute('aria-pressed', 'true');
        this.nowPlayingArtwork.classList.add('playing');

        // Sync Media Session playback state
        if (this.mediaSession) this.mediaSession.updatePlaybackState();

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
        // Cancel any in-progress crossfade so the secondary audio doesn't
        // keep playing while the user has paused.
        // But DON'T cancel if the song ended naturally — the browser fires
        // `pause` right before `ended`, and the crossfade is handling the
        // transition. audio.ended is true in that case.
        if (this._crossfading && !this.audio.ended) this._cancelCrossfade();
        // Reset listen-tracker clock so the resume gap isn't counted as listening
        if (this._listenTracker) this._listenTracker.lastTick = Date.now();
        this.iconPlay.classList.remove('hidden');
        this.iconPause.classList.add('hidden');
        this.playPauseBtn?.setAttribute('aria-label', 'Play');
        this.playPauseBtn?.setAttribute('aria-pressed', 'false');
        this.nowPlayingArtwork.classList.remove('playing');

        // Sync Media Session playback state
        if (this.mediaSession) this.mediaSession.updatePlaybackState();

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
        if (this.isControllerMode) {
            const bar = progressBarElement || this.progressBar;
            const rect = bar.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const duration = this._controllerState?.duration || 0;
            if (duration > 0) this._controllerCommand('seek', { position: Math.floor(percent * duration) });
            return;
        }
        if (!this.audio.duration) return;

        // Manual seek cancels any in-progress crossfade — the user is
        // taking control of the timeline.
        if (this._crossfading) this._cancelCrossfade();

        const bar = progressBarElement || this.progressBar;
        const rect = bar.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        this.audio.currentTime = percent * this.audio.duration;
    }

    handleVolumeChange(e) {
        if (this.isControllerMode) { this._controllerCommand('volume', { volume: Number(e.target.value) }); return; }
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
                this.setVolume(this.audio.volume + 0.1);
                break;
            case 'ArrowDown':
                e.preventDefault();
                this.setVolume(this.audio.volume - 0.1);
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
            let mode = 'standard'; // Default for new/no-pref accounts — keep in sync with settings default
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
                if (prefs && prefs.lyrics_effect) {
                    this.lyricsEffect = prefs.lyrics_effect;
                }
                if (prefs && typeof prefs.lyrics_audio_sync !== 'undefined') {
                    this.lyricsAudioSync = !!prefs.lyrics_audio_sync;
                }
            }

            // Remove existing mode classes
            this.fsContainer.classList.remove('mode-modern', 'mode-standard');
            this.fsContainer.classList.add(`mode-${mode}`);
            this.fsContainer.classList.toggle('layout-swapped', swap);
            this._applyLyricsFxClass();

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

            // Resume the lyrics karaoke fill loop if the panel is open
            if (this.lyricsActive) this._startLyricsFillLoop();
        } else {
            this.fsContainer.classList.remove('active');
            this._stopLyricsFillLoop();
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
                    canvas3d: this.fsLightShowCanvas3d,
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
            if (this.fsLightShowCanvas3d) this.fsLightShowCanvas3d.classList.add('hidden');

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
            this._applyLyricsFxClass();
            if (this.currentSong) {
                if (this.lyricsSongId === this.currentSong.id && this.lyricsData) {
                    this.renderLyrics();
                } else {
                    this.loadLyrics(this.currentSong.id);
                }
            }
        } else {
            this._stopLyricsFillLoop();
        }
    }

    _showLyricsEmpty(message, buttonLabel = 'Retry search') {
        if (!this.fsLyricsContent) return;
        this.fsLyricsContent.innerHTML =
            `<div class="fs-lyrics-empty">${message}</div>` +
            `<button class="fs-lyrics-retry" type="button">${buttonLabel}</button>`;
        const btn = this.fsLyricsContent.querySelector('.fs-lyrics-retry');
        if (btn) {
            btn.addEventListener('click', () => {
                if (this.lyricsSongId != null) this.loadLyrics(this.lyricsSongId, true);
            });
        }
    }

    _showLyricsNotFetched() {
        this._showLyricsEmpty('Lyrics haven’t been fetched yet', 'Fetch lyrics');
    }

    async loadLyrics(songId, refresh = false) {
        this.lyricsSongId = songId;
        this.lyricsData = null;
        this.activeLyricIndex = -1;
        this._lyricsWordTimes = null;
        this._lyricsWordEnds = null;

        if (this.fsLyricsContent) {
            this.fsLyricsContent.innerHTML = '<div class="fs-lyrics-loading">Loading lyrics…</div>';
        }
        if (this.fsLyricsScroll) this.fsLyricsScroll.scrollTop = 0;

        try {
            const url = `/api/music/song/${songId}/lyrics${refresh ? '?refresh=1' : ''}`;
            const res = await fetch(url);
            if (this.lyricsSongId !== songId) return; // Song changed mid-request

            if (!res.ok) {
                let state = 'not_found';
                try {
                    const err = await res.json();
                    if (err && err.state) state = err.state;
                } catch (_) { }
                if (state === 'not_fetched' && !refresh) {
                    this._showLyricsNotFetched();
                } else {
                    this._showLyricsEmpty('No lyrics found for this song');
                }
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
            const synced = data.synced;
            for (let i = 0; i < synced.length; i++) {
                synced[i].end = i + 1 < synced.length
                    ? synced[i + 1].time
                    : synced[i].time + 4;
            }

            const wordMode = this.lyricsEffect === 'word' || this.lyricsEffect === 'slide';
            const lineInner = (text) => {
                if (!wordMode) return escape(text || '♪');
                return this._lineWords(text)
                    .map(w => `<span class="fs-lyric-word">${escape(w)}</span>`)
                    .join(' ');
            };

            this.fsLyricsContent.innerHTML = synced.map((line, i) =>
                `<div class="fs-lyric-line" data-index="${i}" data-time="${line.time}">${lineInner(line.text)}</div>`
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
            if (this.lyricsActive) this._startLyricsFillLoop();
            this._maybeStartAudioAnalysis();
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

        const activeEl = idx >= 0 ? els[idx] : null;
        this._activeWordEls = activeEl
            ? Array.from(activeEl.querySelectorAll('.fs-lyric-word'))
            : null;
        this._activeWordLit = -1;
        this._slideWordFracs = null;
        this._slideFracsDirty = true;
        this._slideSnap = true;

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

    updateLyricFill() {
        if (!this.lyricsActive || !this.lyricsData || !this.fsLyricsContent) return;
        if (this.lyricsEffect === 'default') return;

        const idx = this.activeLyricIndex;
        const lines = this.lyricsData.synced;
        if (!Array.isArray(lines) || idx < 0 || idx >= lines.length) return;

        const line = lines[idx];
        const start = line.time;
        const end = line.end != null ? line.end : start + 4;
        const dur = end - start;
        const t = this.audio.currentTime;
        let p = dur > 0 ? (t - start) / dur : 1;
        if (p < 0) p = 0;
        else if (p > 1) p = 1;

        const el = this.fsLyricsContent.children[idx];
        if (!el) return;

        if (this.lyricsEffect === 'slide') {
            let target = p;
            if (this.lyricsAudioSync) {
                const synced = this._slideSyncedProgress(idx, t, line);
                if (synced != null) target = synced;
            }
            let cur = this._slideP;
            if (cur == null || this._slideSnap) {
                cur = target;
                this._slideSnap = false;
            } else {
                cur += (target - cur) * 0.3;
                if (Math.abs(target - cur) < 0.0005) cur = target;
            }
            this._slideP = cur;
            el.style.setProperty('--p', `${(cur * 100).toFixed(2)}%`);
        } else if (this.lyricsEffect === 'word') {
            const words = this._activeWordEls;
            if (!words || !words.length) return;

            let lit;
            const wt = this._lyricsWordTimes && this._lyricsWordTimes[idx];
            if (wt && wt.length === words.length) {
                lit = 0;
                for (let i = 0; i < wt.length; i++) {
                    if (t >= wt[i]) lit = i + 1;
                    else break;
                }
            } else {
                lit = Math.min(words.length, Math.round(p * words.length));
            }

            if (lit === this._activeWordLit) return;
            this._activeWordLit = lit;
            for (let i = 0; i < words.length; i++) {
                words[i].classList.toggle('lit', i < lit);
            }
        }
    }

    _slideSyncedProgress(idx, t, line) {
        const wt = this._lyricsWordTimes && this._lyricsWordTimes[idx];
        const words = this._activeWordEls;
        if (!Array.isArray(wt) || !words || wt.length !== words.length) return null;

        if (this._slideFracsDirty || !this._slideWordFracs || this._slideWordFracs.length !== words.length) {
            this._measureSlideWordFracs();
            if (!this._slideWordFracs) return null;
        }
        const fracs = this._slideWordFracs;
        const n = wt.length;
        const ends = this._lyricsWordEnds && this._lyricsWordEnds[idx];

        if (t <= wt[0]) return 0;
        let i = 0;
        while (i + 1 < n && t >= wt[i + 1]) i++;

        let nextT;
        if (ends && Number.isFinite(ends[i]) && ends[i] > wt[i]) {
            nextT = ends[i];
        } else if (i + 1 < n) {
            nextT = wt[i + 1];
        } else {
            nextT = wt[i] + this._estimateWordSpan(wt);
        }
        if (line.end != null && nextT > line.end) nextT = line.end;
        if (nextT <= wt[i]) nextT = wt[i] + 0.001;

        const from = i > 0 ? fracs[i - 1] : 0;
        const to = i === n - 1 ? 1 : fracs[i];
        let u = (t - wt[i]) / (nextT - wt[i]);
        if (u < 0) u = 0;
        else if (u > 1) u = 1;
        return from + (to - from) * u;
    }

    _estimateWordSpan(wt) {
        const n = wt.length;
        if (n < 2) return 0.6;
        const gaps = [];
        for (let k = 1; k < n; k++) gaps.push(wt[k] - wt[k - 1]);
        gaps.sort((a, b) => a - b);
        const med = gaps[Math.floor(gaps.length / 2)];
        return med > 0 ? med : 0.6;
    }

    _measureSlideWordFracs() {
        this._slideWordFracs = null;
        this._slideFracsDirty = false;
        const words = this._activeWordEls;
        const el = this.activeLyricIndex >= 0 && this.fsLyricsContent
            ? this.fsLyricsContent.children[this.activeLyricIndex]
            : null;
        if (!el || !words || !words.length) return;
        const lineRect = el.getBoundingClientRect();
        if (!lineRect.width) return;
        const fracs = new Array(words.length);
        let prev = 0;
        for (let i = 0; i < words.length; i++) {
            const r = words[i].getBoundingClientRect();
            let f = (r.right - lineRect.left) / lineRect.width;
            if (f < prev) f = prev;
            if (f > 1) f = 1;
            fracs[i] = f;
            prev = f;
        }
        this._slideWordFracs = fracs;
    }

    _applyLyricsFxClass() {
        if (!this.fsContainer) return;
        this.fsContainer.classList.remove('lyrics-fx-default', 'lyrics-fx-word', 'lyrics-fx-slide');
        this.fsContainer.classList.add(`lyrics-fx-${this.lyricsEffect || 'default'}`);
    }

    setLyricsEffect(mode) {
        const next = (mode === 'word' || mode === 'slide') ? mode : 'default';
        if (next === this.lyricsEffect) {
            this._applyLyricsFxClass();
            return;
        }
        this.lyricsEffect = next;
        this._applyLyricsFxClass();
        if (this.lyricsActive && this.lyricsData && Array.isArray(this.lyricsData.synced)) {
            this.renderLyrics();
        }
    }

    setLyricsAudioSync(on) {
        on = !!on;
        if (on === this.lyricsAudioSync) return;
        this.lyricsAudioSync = on;
        if (!on) {
            this._clearAudioAnalysis();
            return;
        }
        this._maybeStartAudioAnalysis();
    }

    _lineWords(text) {
        const words = (text || '').trim().split(/\s+/).filter(Boolean);
        return words.length ? words : ['♪'];
    }

    _lineWordCount(text) {
        return this._lineWords(text).length;
    }

    _clearAudioAnalysis() {
        this._lyricsAnalysis = null;
        this._lyricsAnalysisSongId = null;
        this._lyricsAnalysisPromise = null;
        this._lyricsWordTimes = null;
        this._lyricsWordEnds = null;
    }

    _maybeStartAudioAnalysis() {
        if (!this.lyricsAudioSync || (this.lyricsEffect !== 'word' && this.lyricsEffect !== 'slide')) return;
        if (!this.currentSong || !this.lyricsData || !Array.isArray(this.lyricsData.synced)) return;
        this._ensureAudioAnalysis();
    }

    _ensureAudioAnalysis() {
        const id = this.currentSong && this.currentSong.id;
        if (id == null) return;
        if (this._lyricsAnalysisSongId === id) return;
        if (this._lyricsAnalysisPromise) return;

        this._lyricsAnalysisPromise = (async () => {
            try {
                // Best: server-side forced alignment (Whisper). Fallback: client envelope.
                Logger.log(`[lyrics] song ${id}: requesting server word-times (effect=${this.lyricsEffect}, audioSync=${this.lyricsAudioSync})`);
                const ok = await this._fetchServerWordTimes(id);
                if (ok) {
                    Logger.log(`[lyrics] song ${id}: using server (Whisper) word-times`);
                } else {
                    Logger.log(`[lyrics] song ${id}: server word-times unavailable — falling back to client envelope analyzer`);
                    await this._fetchEnvelopeAnalysis(id);
                }
            } finally {
                if (this.currentSong?.id === id) this._lyricsAnalysisSongId = id;
                this._lyricsAnalysisPromise = null;
            }
        })();
    }

    async _fetchServerWordTimes(id) {
        if (this.currentSong?.id !== id) return false;
        try {
            const res = await fetch(`/api/music/song/${id}/lyrics-words`);
            if (!res.ok) {
                Logger.log(`[lyrics] song ${id}: /lyrics-words HTTP ${res.status}`);
                return false;
            }
            const data = await res.json();
            const words = data && data.words;
            const lines = this.lyricsData && this.lyricsData.synced;
            if (this.currentSong?.id !== id) return false;
            if (!Array.isArray(words) || !Array.isArray(lines) || words.length !== lines.length) {
                Logger.log(`[lyrics] song ${id}: server shape mismatch (words=${Array.isArray(words) ? words.length : 'n/a'}, lines=${Array.isArray(lines) ? lines.length : 'n/a'})`);
                return false;
            }
            this._ingestWordTimes(words);
            this._lyricsAnalysis = { source: 'whisper' };
            return true;
        } catch (err) {
            Logger.log(`[lyrics] song ${id}: /lyrics-words fetch error:`, err && err.message ? err.message : err);
            return false;
        }
    }

    async _fetchEnvelopeAnalysis(id) {
        try {
            const res = await fetch(`/api/music/stream/${id}`);
            if (!res.ok) throw new Error(`stream ${res.status}`);
            const buf = await res.arrayBuffer();
            if (this.currentSong?.id !== id) return;
            const analysis = await this._computeEnvelope(buf);
            if (this.currentSong?.id !== id) return;
            this._lyricsAnalysis = analysis;
            if (analysis) {
                this._buildAllWordTimes();
                Logger.log(`[lyrics] song ${id}: client envelope analyzer ready`);
            } else {
                Logger.log(`[lyrics] song ${id}: client envelope analyzer produced nothing`);
            }
        } catch (err) {
            Logger.log('[lyrics] envelope analysis unavailable:', err && err.message ? err.message : err);
        }
    }

    async _computeEnvelope(arrayBuffer) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        const ctx = new Ctx();
        let audioBuffer;
        try {
            audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        } catch (e) {
            try { ctx.close(); } catch (_) { }
            return null;
        }

        const sr = audioBuffer.sampleRate;
        const ch = audioBuffer.getChannelData(0);
        const hop = 1024;
        const n = Math.floor(ch.length / hop);
        const env = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const off = i * hop;
            const endP = Math.min(off + hop, ch.length);
            let sum = 0;
            for (let j = off; j < endP; j++) {
                const v = ch[j];
                sum += v * v;
            }
            env[i] = Math.sqrt(sum / (endP - off));
        }
        try { ctx.close(); } catch (_) { }

        const sm = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            let s = 0, c = 0;
            for (let k = -1; k <= 1; k++) {
                const ii = i + k;
                if (ii >= 0 && ii < n) { s += env[ii]; c++; }
            }
            sm[i] = s / c;
        }
        return { env: sm, hop, sr };
    }

    _ingestWordTimes(words) {
        const starts = new Array(words.length);
        const ends = new Array(words.length);
        let hasEnds = false;
        for (let i = 0; i < words.length; i++) {
            const line = words[i];
            if (Array.isArray(line) && line.length && Array.isArray(line[0])) {
                starts[i] = line.map(p => p[0]);
                ends[i] = line.map(p => p[1]);
                hasEnds = true;
            } else {
                starts[i] = line;
                ends[i] = null;
            }
        }
        this._lyricsWordTimes = starts;
        this._lyricsWordEnds = hasEnds ? ends : null;
        this._normalizeWordTimes();
    }

    _normalizeWordTimes() {
        const synced = this.lyricsData && this.lyricsData.synced;
        const all = this._lyricsWordTimes;
        if (!Array.isArray(synced) || !Array.isArray(all)) return;
        const endsAll = this._lyricsWordEnds;
        const MARGIN = 0.25;
        const GAP = 0.03;
        for (let i = 0; i < all.length && i < synced.length; i++) {
            const wt = all[i];
            const line = synced[i];
            if (!Array.isArray(wt) || !wt.length || !line) continue;
            const hardEnd = line.end != null ? line.end : line.time + 4;
            let cap = hardEnd - MARGIN;
            for (let k = wt.length - 1; k >= 0; k--) {
                if (wt[k] > cap) wt[k] = cap;
                cap = wt[k] - GAP;
            }
            const ends = endsAll && endsAll[i];
            if (Array.isArray(ends)) {
                for (let k = 0; k < ends.length; k++) {
                    const upper = k + 1 < wt.length ? wt[k + 1] : hardEnd;
                    let e = ends[k];
                    if (!Number.isFinite(e) || e < wt[k]) e = wt[k];
                    if (e > upper) e = upper;
                    ends[k] = e;
                }
            }
        }
    }

    _buildAllWordTimes() {
        const lines = this.lyricsData && this.lyricsData.synced;
        if (!this._lyricsAnalysis || !Array.isArray(lines)) {
            this._lyricsWordTimes = null;
            this._lyricsWordEnds = null;
            return;
        }
        this._lyricsWordTimes = lines.map(line =>
            this._computeLineWordTimes(line, this._lineWordCount(line.text)));
        this._lyricsWordEnds = null;
        this._normalizeWordTimes();
    }

    _computeLineWordTimes(line, wordCount) {
        const a = this._lyricsAnalysis;
        if (!a || wordCount <= 0) return null;
        if (wordCount === 1) return [line.time];

        const { env, hop, sr } = a;
        const end = line.end != null ? line.end : line.time + 4;
        let i0 = Math.floor(line.time * sr / hop);
        let i1 = Math.floor(end * sr / hop);
        if (i0 < 0) i0 = 0;
        if (i1 > env.length - 1) i1 = env.length - 1;
        if (i1 <= i0) return null;

        let max = 0;
        for (let i = i0; i <= i1; i++) if (env[i] > max) max = env[i];
        if (max <= 0) return null;

        const thr = max * 0.12;
        const voiced = [];
        for (let i = i0; i <= i1; i++) {
            if (env[i] >= thr) voiced.push((i * hop) / sr);
        }
        if (voiced.length < wordCount) return null;

        const times = new Array(wordCount);
        for (let k = 0; k < wordCount; k++) {
            const pos = Math.round((k * (voiced.length - 1)) / (wordCount - 1));
            times[k] = voiced[pos];
        }
        return times;
    }

    _startLyricsFillLoop() {
        if (this._lyricsFillRAF) return;
        const tick = () => {
            this.updateActiveLyricLine();
            this.updateLyricFill();
            this._lyricsFillRAF = requestAnimationFrame(tick);
        };
        this._lyricsFillRAF = requestAnimationFrame(tick);
    }

    _stopLyricsFillLoop() {
        if (this._lyricsFillRAF) {
            cancelAnimationFrame(this._lyricsFillRAF);
            this._lyricsFillRAF = null;
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
            } else if (song.cover_url) {
                // Preview/discover tracks carry a remote cover URL
                const imgHtml = `<img src="${song.cover_url}" alt="Cover" loading="lazy" referrerpolicy="no-referrer">`;
                this.fsArtwork.innerHTML = imgHtml;
                if (this.fsBackdrop) {
                    this.fsBackdrop.style.backgroundImage = `url('${song.cover_url}')`;
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
                : song.cover_url
                    ? `<img src="${song.cover_url}" alt="Cover" loading="lazy" referrerpolicy="no-referrer">`
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
            <div class="fs-queue-menu-item" data-action="playnext" data-index="${index}">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 3v18l8.5-6L6 9zm2 4.83l3.5 2.5L8 13.16zM16 6h5v2h-5zm0 4h5v2h-5zm0 4h5v2h-5z"/>
                </svg>
                <span>Play Next</span>
            </div>
            <div class="fs-queue-menu-item" data-action="addqueue" data-index="${index}">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
                <span>Add to Queue</span>
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
     * Add a song to the end of the queue.
     * @param {Object} song - The song object to add
     */
    addToQueue(song) {
        if (!song) return;
        this.playlist.push(song);
        this.queueModified = true;
        this.queueOperations.push({ action: 'add', songId: song.id, position: this.playlist.length - 1 });
        this.savePlaybackState();
        this.renderFullscreenQueue();
        window.showToast?.(`Added "${song.title}" to queue`, 'success');
        Logger.log('Added song to queue:', song.title);
    }

    /**
     * Insert a song to play immediately after the current one.
     * @param {Object} song - The song object to insert
     */
    playNextInQueue(song) {
        if (!song) return;
        const insertAt = this.currentIndex + 1;
        this.playlist.splice(insertAt, 0, song);
        this.queueModified = true;
        this.queueOperations.push({ action: 'add', songId: song.id, position: insertAt });
        this.savePlaybackState();
        this.renderFullscreenQueue();
        window.showToast?.(`"${song.title}" will play next`, 'success');
        Logger.log('Inserted song to play next:', song.title);
    }

    /**
     * Clear all songs from the queue except the currently playing one.
     */
    clearQueue() {
        if (this.currentIndex < 0 || !this.playlist.length) return;
        const current = this.playlist[this.currentIndex];
        this.playlist = [current];
        this.currentIndex = 0;
        this.queueModified = true;
        this.queueOperations = [];
        this.savePlaybackState();
        this.renderFullscreenQueue();
        window.showToast?.('Queue cleared', 'success');
        Logger.log('Queue cleared, kept current song');
    }

    /**
     * Restore playback state from the server (cross-device sync).
     * Fetches saved state and offers to resume.
     */
    async restoreFromServer() {
        try {
            const res = await usePlaybackService().getState();
            if (res.error || !res.value || !res.value.state) return null;
            return res.value.state;
        } catch (e) {
            Logger.warn('Failed to fetch server state:', e);
            return null;
        }
    }

    /**
     * Show the sleep timer popup menu anchored to a button.
     * @param {HTMLElement} anchorBtn
     */
    showSleepTimerMenu(anchorBtn) {
        // Remove any existing menu
        document.getElementById('sleep-timer-menu')?.remove();

        const menu = document.createElement('div');
        menu.id = 'sleep-timer-menu';
        menu.className = 'sleep-timer-menu';

        const presets = [5, 10, 15, 30, 45, 60];
        const activeRemaining = this.sleepTimer.isActive ? this.sleepTimer.remainingMs : 0;

        menu.innerHTML = `
            <div class="sleep-timer-header">Sleep Timer</div>
            ${this.sleepTimer.isActive ? `
                <div class="sleep-timer-active">
                    <span id="sleep-timer-countdown">${SleepTimer.format(activeRemaining)}</span> remaining
                    <button class="sleep-timer-cancel" id="sleep-timer-cancel">Cancel</button>
                </div>
            ` : ''}
            <div class="sleep-timer-presets">
                ${presets.map(m => `<button class="sleep-timer-preset" data-minutes="${m}">${m} min</button>`).join('')}
            </div>
            <div class="sleep-timer-custom">
                <input type="number" id="sleep-timer-custom-input" min="1" max="180" placeholder="Custom">
                <button class="sleep-timer-set" id="sleep-timer-custom-set">Set</button>
            </div>
        `;

        document.body.appendChild(menu);

        // Position above the anchor button
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;
        menu.style.zIndex = '3000';

        // Bind preset buttons
        menu.querySelectorAll('.sleep-timer-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                this.startSleepTimer(parseInt(btn.dataset.minutes));
                menu.remove();
            });
        });

        // Custom input
        const customSet = menu.querySelector('#sleep-timer-custom-set');
        const customInput = menu.querySelector('#sleep-timer-custom-input');
        customSet?.addEventListener('click', () => {
            const val = parseInt(customInput.value);
            if (val && val > 0) {
                this.startSleepTimer(val);
                menu.remove();
            }
        });
        customInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') customSet.click();
        });

        // Cancel button
        menu.querySelector('#sleep-timer-cancel')?.addEventListener('click', () => {
            this.sleepTimer.cancel();
            this._updateSleepTimerBtn(false);
            menu.remove();
            window.showToast?.('Sleep timer cancelled', 'info');
        });

        // Close on outside click
        const outsideHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', outsideHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', outsideHandler), 0);
    }

    /**
     * Start the sleep timer and wire up UI feedback.
     * @param {number} minutes
     */
    startSleepTimer(minutes) {
        this.sleepTimer.start(minutes);
        this._updateSleepTimerBtn(true);
        window.showToast?.(`Sleep timer set for ${minutes} min`, 'success');

        this.sleepTimer.onTick = (remainingMs) => {
            const countdown = document.getElementById('sleep-timer-countdown');
            if (countdown) countdown.textContent = SleepTimer.format(remainingMs);
            this._updateSleepTimerBtn(true, remainingMs);
        };
        this.sleepTimer.onEnd = () => {
            this._updateSleepTimerBtn(false);
            window.showToast?.('Sleep timer ended — playback paused', 'info');
        };
    }

    /**
     * Update the sleep timer button visual state.
     * @param {boolean} active
     * @param {number} [remainingMs]
     */
    _updateSleepTimerBtn(active, remainingMs) {
        const btn = document.getElementById('sleep-timer-btn');
        if (!btn) return;
        if (active) {
            btn.classList.add('active');
            btn.title = remainingMs ? `Sleep timer: ${SleepTimer.format(remainingMs)}` : 'Sleep timer active';
        } else {
            btn.classList.remove('active');
            btn.title = 'Sleep Timer';
        }
    }

    /* ========================================================================
       Playback Speed Control
       Popup menu with presets (0.5x–2x) and a fine-tune slider.
       Persists to localStorage so it survives page reloads.
       ======================================================================== */

    /** Speed presets shown as buttons in the menu. */
    static SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

    /**
     * Show the playback-speed popup anchored to the given button.
     * @param {HTMLElement} anchorBtn
     */
    showSpeedMenu(anchorBtn) {
        document.getElementById('speed-menu')?.remove();

        const current = this.audio.playbackRate || 1;
        const menu = document.createElement('div');
        menu.id = 'speed-menu';
        menu.className = 'speed-menu';

        menu.innerHTML = `
            <div class="speed-menu-header">Playback Speed</div>
            <div class="speed-presets">
                ${AudioPlayer.SPEED_PRESETS.map(s => `
                    <button class="speed-preset${Math.abs(s - current) < 0.01 ? ' active' : ''}" data-speed="${s}">${s}x</button>
                `).join('')}
            </div>
            <div class="speed-slider-row">
                <span class="speed-slider-label">Fine</span>
                <input type="range" class="speed-slider" id="speed-slider" min="0.25" max="3" step="0.05" value="${current}">
                <span class="speed-slider-value" id="speed-slider-value">${current.toFixed(2)}x</span>
            </div>
            <button class="speed-reset-btn" id="speed-reset-btn">Reset to 1x</button>
        `;

        document.body.appendChild(menu);

        // Position above the anchor button
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        menu.style.zIndex = '3000';
        // Center horizontally on the button, clamp to viewport
        const menuWidth = 220;
        let left = rect.left + rect.width / 2 - menuWidth / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
        menu.style.left = `${left}px`;
        menu.style.width = `${menuWidth}px`;

        // Preset buttons
        menu.querySelectorAll('.speed-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setPlaybackSpeed(parseFloat(btn.dataset.speed));
                menu.remove();
            });
        });

        // Fine-tune slider
        const slider = menu.querySelector('#speed-slider');
        const valueEl = menu.querySelector('#speed-slider-value');
        slider?.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            valueEl.textContent = `${v.toFixed(2)}x`;
            this.setPlaybackSpeed(v);
            // Update active preset highlight
            menu.querySelectorAll('.speed-preset').forEach(b => {
                b.classList.toggle('active', Math.abs(parseFloat(b.dataset.speed) - v) < 0.01);
            });
        });

        // Reset button
        menu.querySelector('#speed-reset-btn')?.addEventListener('click', () => {
            this.setPlaybackSpeed(1);
            menu.remove();
        });

        // Close on outside click
        const outsideHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', outsideHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', outsideHandler), 0);
    }

    /**
     * Set the audio playback rate and update all UI labels.
     * @param {number} rate  e.g. 0.5 – 3
     */
    setPlaybackSpeed(rate) {
        rate = Math.max(0.25, Math.min(3, rate));
        this.audio.playbackRate = rate;
        localStorage.setItem('rainy_playback_speed', String(rate));

        const label = rate === 1 ? '1x' : `${parseFloat(rate.toFixed(2))}x`;
        if (this.speedLabel) this.speedLabel.textContent = label;

        // Highlight active state on button
        const active = Math.abs(rate - 1) > 0.01;
        if (this.speedBtn) this.speedBtn.classList.toggle('active', active);
    }

    /**
     * Restore saved playback speed (called on init / song load).
     */
    restorePlaybackSpeed() {
        const saved = localStorage.getItem('rainy_playback_speed');
        if (saved !== null) {
            const rate = parseFloat(saved);
            if (!isNaN(rate) && rate >= 0.25 && rate <= 3) {
                this.audio.playbackRate = rate;
                const label = rate === 1 ? '1x' : `${parseFloat(rate.toFixed(2))}x`;
                if (this.speedLabel) this.speedLabel.textContent = label;
                const active = Math.abs(rate - 1) > 0.01;
                if (this.speedBtn) this.speedBtn.classList.toggle('active', active);
            }
        }
    }

    /* =====================================================================
     *  EQUALIZER (Web Audio API — 10-band peaking filters)
     * ===================================================================== */

    /** Band centre frequencies (Hz) for the 10-band EQ. */
    static EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

    /** Named presets — each is an array of 10 gain values (dB, -12…+12). */
    static EQ_PRESETS = {
        Flat:      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        'Bass Boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
        'Treble Boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
        Vocal:     [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
        Rock:      [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
        Pop:       [-1, 1, 3, 4, 3, 1, -1, -1, 1, 2],
        Jazz:      [4, 3, 1, 2, -1, -1, 0, 1, 3, 4],
        Electronic:[5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
        Classical: [5, 4, 3, 2, -1, -1, 0, 2, 3, 4],
        Podcast:   [-3, -1, 0, 2, 4, 4, 3, 1, -1, -2],
    };

    /**
     * Lazily create the AudioContext + 10 peaking BiquadFilters and wire
     * them between the <audio> element and the destination.
     * Must be called from a user gesture (click) to satisfy autoplay policy.
     */
    _ensureEqGraph() {
        if (this._eqContext) return; // already built

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) { window.showToast?.('Equalizer not supported in this browser', 'error'); return; }

        this._eqContext = new Ctx();
        this._eqSource = this._eqContext.createMediaElementSource(this.audio);

        this._eqFilters = AudioPlayer.EQ_BANDS.map((freq, i) => {
            const f = this._eqContext.createBiquadFilter();
            f.type = 'peaking';
            f.frequency.value = freq;
            f.Q.value = 1.4;
            f.gain.value = this._eqGains[i];
            return f;
        });

        // Chain: source → filter0 → filter1 → … → filter9 → destination
        this._eqSource.connect(this._eqFilters[0]);
        for (let i = 0; i < this._eqFilters.length - 1; i++) {
            this._eqFilters[i].connect(this._eqFilters[i + 1]);
        }
        this._eqFilters[this._eqFilters.length - 1].connect(this._eqContext.destination);

        // If the context was created while audio was already playing, resume it
        if (this._eqContext.state === 'suspended') this._eqContext.resume();
    }

    /**
     * Apply a gain array (10 values in dB) to the EQ filters.
     * @param {number[]} gains
     * @param {string} [presetName]  if provided, stored so the UI can highlight it
     */
    applyEqGains(gains, presetName = null) {
        this._eqGains = gains.slice(0, 10);
        if (this._eqFilters.length) {
            this._eqFilters.forEach((f, i) => { f.gain.value = this._eqGains[i]; });
        }
        if (presetName) this._eqPreset = presetName;
        this._saveEqState();
    }

    /** Toggle the EQ on/off. When off, all gains are set to 0 (flat). */
    toggleEqEnabled() {
        this._eqEnabled = !this._eqEnabled;
        if (!this._eqEnabled) {
            // Flatten
            this._eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            if (this._eqFilters.length) this._eqFilters.forEach(f => { f.gain.value = 0; });
            this._eqPreset = 'Flat';
        } else {
            // Restore saved gains
            this._loadEqState();
            if (this._eqFilters.length) {
                this._eqFilters.forEach((f, i) => { f.gain.value = this._eqGains[i]; });
            }
        }
        this._updateEqButtonState();
        this._saveEqState();
    }

    _updateEqButtonState() {
        const active = this._eqEnabled && this._eqGains.some(g => Math.abs(g) > 0.1);
        if (this.eqBtn) this.eqBtn.classList.toggle('active', active);
    }

    _saveEqState() {
        localStorage.setItem('rainy_eq_gains', JSON.stringify(this._eqGains));
        localStorage.setItem('rainy_eq_enabled', this._eqEnabled ? '1' : '0');
        if (this._eqPreset) localStorage.setItem('rainy_eq_preset', this._eqPreset);
    }

    _loadEqState() {
        try {
            const g = JSON.parse(localStorage.getItem('rainy_eq_gains'));
            if (Array.isArray(g) && g.length === 10) this._eqGains = g;
        } catch { /* ignore */ }
        this._eqEnabled = localStorage.getItem('rainy_eq_enabled') === '1';
        this._eqPreset = localStorage.getItem('rainy_eq_preset') || 'Flat';
    }

    /** Restore EQ state on init (called from init()). */
    restoreEq() {
        this._loadEqState();
        this._updateEqButtonState();
    }

    /**
     * Show the equalizer popup anchored to the given button.
     * @param {HTMLElement} anchorBtn
     */
    showEqMenu(anchorBtn) {
        document.getElementById('eq-menu')?.remove();

        // Ensure graph exists (user gesture)
        this._ensureEqGraph();
        if (!this._eqContext) return;
        if (this._eqContext.state === 'suspended') this._eqContext.resume();

        // If EQ was off, turn it on when opening the menu
        if (!this._eqEnabled) {
            this._eqEnabled = true;
            this._updateEqButtonState();
            this._saveEqState();
        }

        const bands = AudioPlayer.EQ_BANDS;
        const presets = Object.keys(AudioPlayer.EQ_PRESETS);

        const menu = document.createElement('div');
        menu.id = 'eq-menu';
        menu.className = 'eq-menu';

        menu.innerHTML = `
            <div class="eq-menu-header">
                <span>Equalizer</span>
                <button class="eq-power-btn${this._eqEnabled ? ' on' : ''}" id="eq-power-btn" title="Toggle EQ">⏻</button>
            </div>
            <div class="eq-presets">
                ${presets.map(name => `
                    <button class="eq-preset${(this._eqPreset || 'Flat') === name ? ' active' : ''}" data-preset="${name}">${name}</button>
                `).join('')}
            </div>
            <div class="eq-bands">
                ${bands.map((freq, i) => `
                    <div class="eq-band">
                        <span class="eq-band-val" id="eq-val-${i}">${this._eqGains[i] > 0 ? '+' : ''}${this._eqGains[i]}</span>
                        <input type="range" class="eq-slider" id="eq-slider-${i}"
                               min="-12" max="12" step="1" value="${this._eqGains[i]}"
                               orient="vertical" data-index="${i}">
                        <span class="eq-band-freq">${freq >= 1000 ? (freq / 1000) + 'k' : freq}</span>
                    </div>
                `).join('')}
            </div>
            <button class="eq-reset-btn" id="eq-reset-btn">Reset to Flat</button>
        `;

        document.body.appendChild(menu);

        // Position above the anchor button
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        menu.style.zIndex = '3000';
        const menuWidth = 340;
        let left = rect.left + rect.width / 2 - menuWidth / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
        menu.style.left = `${left}px`;
        menu.style.width = `${menuWidth}px`;

        // Preset buttons
        menu.querySelectorAll('.eq-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.dataset.preset;
                const gains = AudioPlayer.EQ_PRESETS[name];
                if (!gains) return;
                this.applyEqGains(gains, name);
                // Update sliders
                gains.forEach((g, i) => {
                    const sl = menu.querySelector(`#eq-slider-${i}`);
                    const vl = menu.querySelector(`#eq-val-${i}`);
                    if (sl) sl.value = g;
                    if (vl) vl.textContent = `${g > 0 ? '+' : ''}${g}`;
                });
                menu.querySelectorAll('.eq-preset').forEach(b => b.classList.toggle('active', b === btn));
            });
        });

        // Individual band sliders
        menu.querySelectorAll('.eq-slider').forEach(slider => {
            slider.addEventListener('input', () => {
                const idx = parseInt(slider.dataset.index);
                const val = parseInt(slider.value);
                this._eqGains[idx] = val;
                if (this._eqFilters[idx]) this._eqFilters[idx].gain.value = val;
                const vl = menu.querySelector(`#eq-val-${idx}`);
                if (vl) vl.textContent = `${val > 0 ? '+' : ''}${val}`;
                // Deselect preset (custom)
                this._eqPreset = 'Custom';
                menu.querySelectorAll('.eq-preset').forEach(b => b.classList.remove('active'));
                this._saveEqState();
                this._updateEqButtonState();
            });
        });

        // Power toggle
        menu.querySelector('#eq-power-btn')?.addEventListener('click', () => {
            this.toggleEqEnabled();
            const btn = menu.querySelector('#eq-power-btn');
            if (btn) btn.classList.toggle('on', this._eqEnabled);
            // Update sliders to reflect state
            this._eqGains.forEach((g, i) => {
                const sl = menu.querySelector(`#eq-slider-${i}`);
                const vl = menu.querySelector(`#eq-val-${i}`);
                if (sl) sl.value = g;
                if (vl) vl.textContent = `${g > 0 ? '+' : ''}${g}`;
            });
        });

        // Reset button
        menu.querySelector('#eq-reset-btn')?.addEventListener('click', () => {
            this.applyEqGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'Flat');
            menu.querySelectorAll('.eq-slider').forEach((sl, i) => { sl.value = 0; });
            menu.querySelectorAll('.eq-band-val').forEach(vl => { vl.textContent = '0'; });
            menu.querySelectorAll('.eq-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === 'Flat'));
        });

        // Close on outside click
        const outsideHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', outsideHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', outsideHandler), 0);
    }

    /* ========================================================================
       Crossfade — smooth volume-fade transition between songs.
       Uses a secondary <audio> element to overlap the tail of the current
       track with the head of the next. Toggle + adjustable duration (1-12 s).
       ======================================================================== */

    /** Restore crossfade settings from localStorage (called from init). */
    restoreCrossfade() {
        this._crossfadeEnabled = localStorage.getItem('rainy_crossfade_enabled') === '1';
        const d = parseInt(localStorage.getItem('rainy_crossfade_duration'));
        if (d >= 1 && d <= 12) this._crossfadeDuration = d;
        this._updateCrossfadeButtonState();
    }

    _saveCrossfadeState() {
        localStorage.setItem('rainy_crossfade_enabled', this._crossfadeEnabled ? '1' : '0');
        localStorage.setItem('rainy_crossfade_duration', String(this._crossfadeDuration));
    }

    _updateCrossfadeButtonState() {
        if (this.crossfadeBtn) this.crossfadeBtn.classList.toggle('active', this._crossfadeEnabled);
    }

    toggleCrossfadeEnabled() {
        this._crossfadeEnabled = !this._crossfadeEnabled;
        if (!this._crossfadeEnabled) this._cancelCrossfade();
        this._updateCrossfadeButtonState();
        this._saveCrossfadeState();
        window.showToast?.(
            this._crossfadeEnabled
                ? `Crossfade on (${this._crossfadeDuration}s)`
                : 'Crossfade off',
            'info'
        );
    }

    setCrossfadeDuration(seconds) {
        this._crossfadeDuration = Math.max(1, Math.min(12, Math.round(seconds)));
        this._saveCrossfadeState();
    }

    /**
     * Called from handleTimeUpdate — triggers crossfade when the current
     * song is within the fade window of its end.
     */
    _checkCrossfade() {
        if (!this._crossfadeEnabled || this._crossfading) return;
        if (!this.audio.duration || this.audio.duration < this._crossfadeDuration + 2) return;
        if (this.repeatMode === 'one') return;
        // Don't trigger while the user is manually seeking — they chose a
        // position on purpose, and starting a crossfade mid-seek causes
        // AbortError races in _completeCrossfade.
        if (this.audio.seeking) return;

        const remaining = this.audio.duration - this.audio.currentTime;
        if (remaining <= this._crossfadeDuration && remaining > 0.3) {
            // Determine next index
            let nextIndex = this.currentIndex + 1;
            if (this.isShuffle) {
                if (!this._tempoMapLoaded) {
                    this._ensureTempoMap();
                    return;
                }
                nextIndex = this._pickShuffleIndex();
            }
            if (nextIndex >= this.playlist.length) {
                if (this.repeatMode === 'all') nextIndex = 0;
                else return; // end of playlist — let it stop naturally
            }
            if (nextIndex === this.currentIndex) return;
            this._startCrossfade(nextIndex);
        }
    }

    /**
     * Begin the overlapping crossfade to the song at nextIndex.
     */
    _startCrossfade(nextIndex) {
        if (this._crossfading) return;
        const nextSong = this.playlist[nextIndex];
        if (!nextSong) return;

        this._crossfading = true;
        this._crossfadeTriggered = true;
        this._crossfadeBlobUrl = null;
        const cf = this.crossfadeAudio;
        const targetVolume = this.audio.volume;

        cf.src = `/api/music/stream/${nextSong.id}`;
        cf.volume = 0;
        cf.playbackRate = this.audio.playbackRate || 1;

        // Prefetch the full song as a blob so the primary can swap
        // instantly from memory instead of a fresh HTTP request.
        fetch(`/api/music/stream/${nextSong.id}`)
            .then(r => r.blob())
            .then(blob => {
                if (this._crossfading) {
                    this._crossfadeBlobUrl = URL.createObjectURL(blob);
                }
            })
            .catch(() => { /* fall back to URL src in _completeCrossfade */ });

        cf.play().then(() => {
            const startTime = performance.now();
            const fadeMs = this._crossfadeDuration * 1000;

            const animate = (now) => {
                if (!this._crossfading) return; // cancelled
                // Clamp to [0,1] — a stray negative/overshoot here would push
                // audio.volume below 0 and break the fade.
                const progress = Math.max(0, Math.min((now - startTime) / fadeMs, 1));

                // Equal-power crossfade curve (clamped so volume stays >= 0)
                this.audio.volume = Math.max(0, targetVolume * Math.cos(progress * Math.PI / 2));
                cf.volume = Math.max(0, targetVolume * Math.sin(progress * Math.PI / 2));

                if (progress < 1) {
                    this._crossfadeRaf = requestAnimationFrame(animate);
                } else {
                    this._completeCrossfade(nextIndex, nextSong, cf.currentTime);
                }
            };
            this._crossfadeRaf = requestAnimationFrame(animate);
        }).catch(() => {
            // Autoplay blocked or load error — fall back to normal transition
            this._crossfading = false;
        });
    }

    /**
     * Finalize the crossfade: swap the primary audio to the next song at
     * the position the secondary reached, then clean up.
     */
    _completeCrossfade(nextIndex, nextSong, _position) {
        if (this._crossfadeRaf) { cancelAnimationFrame(this._crossfadeRaf); this._crossfadeRaf = null; }

        const cf = this.crossfadeAudio;
        const targetVolume = parseFloat(localStorage.getItem('rainy_volume') || '0.8');

        // Flush listening stats for the song that just ended
        this._flushListenTracking();

        // Point the primary at the next song — use the prefetched blob if
        // available (instant load from memory), otherwise fall back to URL.
        this.currentIndex = nextIndex;
        const blobUrl = this._crossfadeBlobUrl;

        // Mute and pause BEFORE changing src. The element was previously
        // playing, so without this it can auto-play from position 0 at full
        // volume for a brief moment before loadedmetadata fires — that's
        // the "repeated second" artifact.
        this.audio.pause();
        this.audio.volume = 0;

        // Revoke the OLD active blob before assigning a new src.
        if (this._activeBlobUrl && this._activeBlobUrl !== blobUrl) {
            URL.revokeObjectURL(this._activeBlobUrl);
        }
        this._activeBlobUrl = blobUrl;
        this.audio.src = blobUrl || `/api/music/stream/${nextSong.id}`;

        const onLoaded = () => {
            this.audio.removeEventListener('loadedmetadata', onLoaded);
            this.audio.volume = 0;

            // Seek to the secondary's current position while the primary is
            // still PAUSED. This guarantees no audio frame is ever output
            // from the wrong position.
            const syncPos = cf.currentTime;

            const startPlayback = () => {
                this.audio.removeEventListener('seeked', startPlayback);

                const onPlaying = () => {
                    this.audio.removeEventListener('playing', onPlaying);
                    this._crossfadeTriggered = false;
                    this._crossfadeBlobUrl = null;

                    // Primary is confirmed playing at the correct position.
                    // Fade it in and ramp the secondary down over 150 ms.
                    this.audio.volume = targetVolume;
                    const cfVol = cf.volume;
                    const t0 = performance.now();
                    const ramp = (now) => {
                        const p = Math.min((now - t0) / 150, 1);
                        cf.volume = cfVol * (1 - p);
                        if (p < 1) {
                            requestAnimationFrame(ramp);
                        } else {
                            cf.pause();
                            cf.removeAttribute('src');
                            cf.load();
                        }
                    };
                    requestAnimationFrame(ramp);
                };

                this.audio.addEventListener('playing', onPlaying);
                this.audio.play().catch(() => {
                    this.audio.removeEventListener('playing', onPlaying);
                    this._crossfadeTriggered = false;
                    this._crossfadeBlobUrl = null;
                    cf.pause();
                    cf.removeAttribute('src');
                    cf.load();
                });
            };

            if (syncPos > 0 && syncPos < this.audio.duration) {
                this.audio.addEventListener('seeked', startPlayback);
                this.audio.currentTime = syncPos;
            } else {
                startPlayback();
            }
        };
        this.audio.addEventListener('loadedmetadata', onLoaded);

        // Reset crossfade state — but keep _crossfadeTriggered set.
        // The old song's `ended` event may already be queued in the event
        // loop; handleEnded needs the flag to swallow it.
        this._crossfading = false;

        // Update all UI
        this.updateNowPlaying(nextSong);
        this.savePlaybackState();
        if (this.lyricsActive) this.loadLyrics(nextSong.id);
    }

    /** Cancel an in-progress crossfade (e.g. user skipped manually). */
    _cancelCrossfade() {
        if (this._crossfadeRaf) { cancelAnimationFrame(this._crossfadeRaf); this._crossfadeRaf = null; }
        if (this.crossfadeAudio) {
            this.crossfadeAudio.pause();
            this.crossfadeAudio.removeAttribute('src');
            this.crossfadeAudio.load();
        }
        // Revoke any prefetched blob — but NOT if it's already the active
        // src on the primary audio (revoking a live src causes
        // ERR_FILE_NOT_FOUND on every subsequent seek/buffer).
        if (this._crossfadeBlobUrl && this._crossfadeBlobUrl !== this._activeBlobUrl) {
            URL.revokeObjectURL(this._crossfadeBlobUrl);
        }
        this._crossfadeBlobUrl = null;
        // Restore primary volume
        const vol = parseFloat(localStorage.getItem('rainy_volume') || '0.8');
        if (this.audio) this.audio.volume = vol;
        this._crossfading = false;
        this._crossfadeTriggered = false;
    }

    /**
     * Show the crossfade settings popup anchored to the given button.
     * @param {HTMLElement} anchorBtn
     */
    showCrossfadeMenu(anchorBtn) {
        document.getElementById('crossfade-menu')?.remove();

        const menu = document.createElement('div');
        menu.id = 'crossfade-menu';
        menu.className = 'crossfade-menu';

        menu.innerHTML = `
            <div class="crossfade-menu-header">
                <span>Crossfade</span>
                <button class="crossfade-power-btn${this._crossfadeEnabled ? ' on' : ''}" id="cf-power-btn" title="Toggle Crossfade">⏻</button>
            </div>
            <p class="crossfade-desc">Smoothly blend the end of one song into the start of the next.</p>
            <div class="crossfade-slider-row">
                <span class="crossfade-slider-label">Duration</span>
                <input type="range" class="crossfade-slider" id="cf-duration-slider"
                       min="1" max="12" step="1" value="${this._crossfadeDuration}">
                <span class="crossfade-slider-value" id="cf-duration-value">${this._crossfadeDuration}s</span>
            </div>
            <div class="crossfade-presets">
                ${[2, 4, 6, 8, 10].map(d => `
                    <button class="crossfade-preset${this._crossfadeDuration === d ? ' active' : ''}" data-dur="${d}">${d}s</button>
                `).join('')}
            </div>
        `;

        document.body.appendChild(menu);

        // Position above the anchor button
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        menu.style.zIndex = '3000';
        const menuWidth = 260;
        let left = rect.left + rect.width / 2 - menuWidth / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
        menu.style.left = `${left}px`;
        menu.style.width = `${menuWidth}px`;

        // Power toggle
        menu.querySelector('#cf-power-btn')?.addEventListener('click', () => {
            this.toggleCrossfadeEnabled();
            const btn = menu.querySelector('#cf-power-btn');
            if (btn) btn.classList.toggle('on', this._crossfadeEnabled);
        });

        // Duration slider
        const slider = menu.querySelector('#cf-duration-slider');
        const valueEl = menu.querySelector('#cf-duration-value');
        slider?.addEventListener('input', () => {
            const v = parseInt(slider.value);
            this.setCrossfadeDuration(v);
            valueEl.textContent = `${v}s`;
            menu.querySelectorAll('.crossfade-preset').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.dur) === v);
            });
        });

        // Preset buttons
        menu.querySelectorAll('.crossfade-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const d = parseInt(btn.dataset.dur);
                this.setCrossfadeDuration(d);
                slider.value = d;
                valueEl.textContent = `${d}s`;
                menu.querySelectorAll('.crossfade-preset').forEach(b => b.classList.toggle('active', b === btn));
            });
        });

        // Close on outside click
        const outsideHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', outsideHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', outsideHandler), 0);
    }

    /* ========================================================================
       Rainy Connect — Spotify-Connect-style cross-device control.

       This player registers itself as a Connect device (heartbeat every 5s),
       polls the server for remote-control commands (every 2s) and applies
       them to local playback. Other devices (phones, other browsers) show up
       in the Connect modal and can be remote-controlled from here.
       ======================================================================== */

    /**
     * Register this player as a Connect device and start the
     * heartbeat + command-poll loops.
     */
    _initConnect() {
        try {
            let deviceId = localStorage.getItem('rainy-connect-device-id');
            if (!deviceId) {
                deviceId = this._generateConnectDeviceId();
                localStorage.setItem('rainy-connect-device-id', deviceId);
            }
            this._connectDeviceId = deviceId;
        } catch (e) {
            // localStorage unavailable (private mode etc.) — fall back to a
            // session-scoped id so Connect still works within this tab.
            this._connectDeviceId = this._generateConnectDeviceId();
        }

        this._connectDeviceName = this._deriveConnectDeviceName();

        // Announce ourselves immediately, then every 2 seconds
        this._connectHeartbeat();
        this._connectHeartbeatTimer = setInterval(() => this._connectHeartbeat(), 2000);

        // Poll for remote-control commands every 1 second
        this._connectPollTimer = setInterval(() => this._connectPollCommands(), 1000);

        // Deregister on page unload so we disappear from other devices'
        // pickers immediately instead of waiting for the server timeout.
        window.addEventListener('beforeunload', () => this._connectDeregister());

        // Reflect remote activity on the player-bar button (pulsing dot)
        window.addEventListener('rainy-connect:remote-active', (e) => {
            const btn = document.getElementById('connect-btn');
            if (btn) btn.classList.toggle('remote-active', !!e.detail?.active);
        });
    }

    /** @returns {string} a random 16-char hex id */
    _generateConnectDeviceId() {
        try {
            if (window.crypto && crypto.randomUUID) {
                return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
            }
        } catch (e) { /* fall through */ }
        let id = '';
        for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
        return id;
    }

    /** @returns {string} e.g. "Chrome on macOS" */
    _deriveConnectDeviceName() {
        const ua = navigator.userAgent;
        let browser = 'Web Player';
        if (/Edg\//.test(ua)) browser = 'Edge';
        else if (/OPR\//.test(ua)) browser = 'Opera';
        else if (/Chrome\//.test(ua)) browser = 'Chrome';
        else if (/Firefox\//.test(ua)) browser = 'Firefox';
        else if (/Safari\//.test(ua)) browser = 'Safari';

        let platform = '';
        if (/Windows/.test(ua)) platform = 'Windows';
        else if (/Mac OS X/.test(ua)) platform = 'macOS';
        else if (/Android/.test(ua)) platform = 'Android';
        else if (/iPhone|iPad|iPod/.test(ua)) platform = 'iOS';
        else if (/Linux/.test(ua)) platform = 'Linux';

        return platform ? `${browser} on ${platform}` : browser;
    }

    /**
     * POST the current playback snapshot to the Connect hub.
     * Only heartbeats while there's a song loaded or playback is active,
     * so an idle tab doesn't clutter other devices' pickers.
     */
    _connectHeartbeat() {
        if (!this._connectDeviceId) return;
        // While in controller mode, heartbeat as idle (we're not playing locally)
        if (this._controllerTarget) return;
        if (!this.currentSong && !this.isPlaying) return;
        // One beat in flight at a time: without this a slow beat stacks up and
        // every later beat re-uploads the same multi-KB payload, which is what
        // buried the Connect table in duplicate row updates.
        if (this._connectBeatBusy) return;

        const song = this.currentSong;

        // Serialize the queue as lightweight maps so remotes can display and
        // tap-to-play any track. Cap at 200 entries to keep payloads sane.
        const queue = (this.playlist || []).slice(0, 200).map(s => ({
            id: s?.id ?? null,
            title: s?.title ?? null,
            artist: s?.artist ?? null,
            album: s?.album ?? null,
            cover_path: s?.cover_path ?? null
        }));

        // Upload the queue only when it actually changed — it is by far the
        // heaviest part of the beat, and the server only needs it on change.
        const queueSig = queue.map(s => s.id).join(',');
        const sendQueue = queueSig !== this._connectQueueSig;

        const payload = {
            device_id: this._connectDeviceId,
            device_name: this._connectDeviceName,
            device_type: 'web',
            song_id: song?.id ?? null,
            song_title: song?.title ?? null,
            song_artist: song?.artist ?? null,
            song_album: song?.album ?? null,
            cover_path: song?.cover_path ?? null,
            position: this.audio ? Math.floor(this.audio.currentTime || 0) : 0,
            duration: (this.audio && this.audio.duration) ? Math.floor(this.audio.duration) : (song?.duration || 0),
            is_playing: this.isPlaying,
            volume: Math.round((this.audio ? this.audio.volume : 0.8) * 100),
            is_shuffled: this.isShuffle,
            repeat_mode: this.repeatMode || 'none',
            queue_index: this.currentIndex
        };
        if (sendQueue) payload.queue = queue;

        this._connectBeatBusy = true;
        useConnectService().heartbeat(payload).then((result) => {
            // Remember the signature only once the server has it, so a failed
            // beat re-sends the queue on the next try.
            if (sendQueue && result && !result.error) this._connectQueueSig = queueSig;
        }).catch(() => { /* network blips are fine — next beat retries */ })
          .finally(() => { this._connectBeatBusy = false; });
    }

    /** Fetch queued remote commands and apply them to local playback. */
    async _connectPollCommands() {
        if (!this._connectDeviceId || this._connectPollBusy) return;
        this._connectPollBusy = true;
        try {
            const result = await useConnectService().pollCommands(this._connectDeviceId);
            const commands = result?.value?.commands;
            if (Array.isArray(commands) && commands.length > 0) {
                for (const cmd of commands) {
                    try {
                        await this._connectApplyCommand(cmd);
                    } catch (e) {
                        Logger.warn('Connect command failed:', cmd, e);
                    }
                }
                // Reflect the new state to remotes without waiting for the next beat
                this._connectHeartbeat();
            }
        } catch (e) {
            // silent — polling retries every 2s
        } finally {
            this._connectPollBusy = false;
        }
    }

    /**
     * Apply a single remote-control command to local playback.
     * @param {{ command: string, args?: Object }} cmd
     */
    async _connectApplyCommand(cmd) {
        if (!cmd || !cmd.command) return;
        const args = cmd.args || {};

        // Give visible feedback that a remote is steering this player
        this._connectFlashButton();

        switch (cmd.command) {
            case 'play':
                if (!this.isPlaying) this.togglePlayPause();
                break;
            case 'pause':
                if (this.isPlaying) this.togglePlayPause();
                break;
            case 'play_pause':
                this.togglePlayPause();
                break;
            case 'next':
                this.playNext();
                break;
            case 'previous':
                this.playPrevious();
                break;
            case 'seek': {
                const position = Number(args.position);
                if (!isNaN(position) && this.audio) {
                    this.audio.currentTime = Math.max(0, position);
                }
                break;
            }
            case 'volume': {
                const volume = Number(args.volume);
                if (!isNaN(volume) && this.audio) {
                    this.setVolume(Math.max(0, Math.min(100, volume)) / 100);
                }
                break;
            }
            case 'shuffle': {
                const enabled = !!args.enabled;
                if (this.isShuffle !== enabled) this.toggleShuffle();
                break;
            }
            case 'repeat': {
                const mode = String(args.mode ?? '');
                if (['none', 'all', 'one'].includes(mode) && this.repeatMode !== mode) {
                    this.setRepeatMode(mode);
                }
                break;
            }
            case 'play_song': {
                // Receiving a playback command means we're being controlled — exit controller mode
                if (this.isControllerMode) this._stopControllerMode();
                if (args.song_id != null) await this._connectPlaySongById(args.song_id);
                break;
            }
            case 'transfer':
                // Receiving side of a hand-off: load the full queue (if provided)
                // and start at the given index/position.
                if (this.isControllerMode) this._stopControllerMode();
                if (Array.isArray(args.queue) && args.queue.length > 0) {
                    this._connectPlayQueueObjects(args.queue, Number(args.index) || 0, Number(args.position) || 0);
                } else if (args.song_id != null) {
                    await this._connectPlaySongById(args.song_id, Number(args.position) || 0);
                }
                break;
            case 'play_queue':
                // Remote sets our entire queue and starts at index.
                // Receiving this means we're being controlled — exit controller mode
                if (this.isControllerMode) this._stopControllerMode();
                // Supports two formats:
                //   args.queue  — full song objects (preferred, no resolution needed)
                //   args.song_ids — legacy ID-only format (resolved against library)
                if (Array.isArray(args.queue) && args.queue.length > 0) {
                    this._connectPlayQueueObjects(args.queue, Number(args.index) || 0);
                } else if (Array.isArray(args.song_ids)) {
                    await this._connectPlayQueue(args.song_ids, Number(args.index) || 0);
                }
                break;
            default:
                Logger.warn('Unknown Connect command:', cmd.command);
        }
    }

    /**
     * Set the local queue from a list of song IDs (sent by a remote) and start
     * playing at [startIndex]. Resolves IDs against the loaded library, falling
     * back to a full server fetch.
     * @param {Array<number|string>} songIds
     * @param {number} startIndex
     */
    async _connectPlayQueue(songIds, startIndex = 0) {
        if (!Array.isArray(songIds) || songIds.length === 0) return;

        /** @type {import('./app.js').RainyApp | undefined} */
        const app = window.app;
        let library = app?.songs || [];
        if (!library.length) {
            const result = await useMusicService().library();
            library = result?.value?.all_songs || [];
        }
        const byId = new Map(library.map(s => [Number(s.id), s]));

        const queue = [];
        for (const raw of songIds) {
            const song = byId.get(Number(raw));
            if (song) queue.push(song);
        }
        if (!queue.length) return;

        const idx = Math.max(0, Math.min(startIndex, queue.length - 1));
        this.playSong(idx, queue, { type: 'connect', id: null });
    }

    /**
     * Set the local queue from full song objects sent by a remote controller.
     * No resolution needed — the objects are used directly.
     * @param {Array<Object>} queueData - Song objects with id, title, artist, etc.
     * @param {number} startIndex
     */
    _connectPlayQueueObjects(queueData, startIndex = 0, startPosition = 0) {
        if (!Array.isArray(queueData) || queueData.length === 0) return;
        const idx = Math.max(0, Math.min(startIndex, queueData.length - 1));
        this.playSong(idx, queueData, { type: 'connect', id: null });
        if (startPosition > 0 && this.audio) {
            this.audio.currentTime = startPosition;
        }
    }

    /**
     * Look a song up by id and play it locally. Prefers the current queue,
     * falls back to the app's loaded library, then to a server fetch.
     * @param {number|string} songId
     * @param {number} [position] - seconds to start at
     */
    async _connectPlaySongById(songId, position = 0) {
        const wantedId = Number(songId);

        // 1) Already in the current queue?
        const queueIndex = this.playlist.findIndex(s => Number(s.id) === wantedId);
        if (queueIndex !== -1) {
            this.playSong(queueIndex);
            if (position > 0) this.audio.currentTime = position;
            return;
        }

        // 2) In the app's loaded library?
        /** @type {import('./app.js').RainyApp | undefined} */
        const app = window.app;
        const librarySong = app?.songs?.find(s => Number(s.id) === wantedId);
        if (librarySong) {
            this.playSong(0, [librarySong], { type: 'connect', id: null });
            if (position > 0) this.audio.currentTime = position;
            return;
        }

        // 3) Fetch from the server.
        const result = await useMusicService().fetch(songId);
        const song = result?.value?.song;
        if (result.error || !song) {
            Logger.warn('Connect: could not resolve song', songId, result.error);
            window.showToast?.('Could not play the requested song', 'error');
            return;
        }
        this.playSong(0, [song], { type: 'connect', id: null });
        if (position > 0) this.audio.currentTime = position;
    }

    /**
     * Set volume (0..1) and sync both sliders + gradient fill.
     * @param {number} volume
     */
    setVolume(volume) {
        if (!this.audio) return;
        const v = Math.max(0, Math.min(1, volume));
        this.audio.volume = v;
        try {
            localStorage.setItem('rainy_volume', v.toString());
        } catch (e) { /* ignore */ }
        const pct = Math.round(v * 1000) / 10; // one decimal, matches slider step
        if (this.volumeSlider) this.volumeSlider.value = pct;
        this.updateVolumeGradient();
        if (this.fsVolumeSlider) {
            this.fsVolumeSlider.value = pct;
            this.updateFsVolumeGradient();
        }
    }

    /**
     * Set the repeat mode directly ('none' | 'all' | 'one') and update the UI.
     * Cycles via toggleRepeat() when the target differs from the current mode.
     * @param {'none'|'all'|'one'} mode
     */
    setRepeatMode(mode) {
        const modes = ['none', 'all', 'one'];
        if (!modes.includes(mode) || this.repeatMode === mode) return;
        // toggleRepeat cycles none -> all -> one; at most two cycles needed
        this.toggleRepeat();
        if (this.repeatMode !== mode) this.toggleRepeat();
    }

    /** Open the Rainy Connect device picker. */
    openConnectModal() {
        /** @type {import('./components/connectModal.js').ConnectModal | null} */
        const modal = document.querySelector('rainy-connect-modal');
        if (modal) {
            modal.show();
        } else {
            window.showToast?.('Connect is not available', 'error');
        }
    }

    /** Briefly light up the Connect button when a remote command lands. */
    _connectFlashButton() {
        const btn = document.getElementById('connect-btn');
        if (!btn) return;
        btn.classList.add('remote-active');
        clearTimeout(this._connectFlashTimeout);
        this._connectFlashTimeout = setTimeout(() => btn.classList.remove('remote-active'), 1500);
    }

    /** Fire-and-forget deregister so we vanish from other devices on unload. */
    _connectDeregister() {
        if (!this._connectDeviceId) return;
        const url = `/api/connect/device/${encodeURIComponent(this._connectDeviceId)}`;
        try {
            if (navigator.sendBeacon) {
                // sendBeacon can't send DELETE — a POST to the same path is the
                // closest reliable approximation during unload.
                navigator.sendBeacon(url, new Blob([], { type: 'application/json' }));
            }
            fetch(url, { method: 'DELETE', keepalive: true }).catch(() => { });
        } catch (e) { /* best effort */ }
    }

    /* ========================================================================
       Controller Mode — this player becomes a remote control for another device
       ======================================================================== */

    /**
     * Enter controller mode: stop local playback, mirror the remote device's
     * state on the player bar, and route all controls as Connect commands.
     * @param {{ device_id: string, device_name: string }} device
     */
    _startControllerMode(device) {
        if (!device?.device_id) return;

        // Clean up any existing controller mode first
        if (this._controllerTarget) {
            this._stopControllerMode();
        }

        // Stop local audio
        if (this.audio) {
            this.audio.pause();
            this.audio.currentTime = 0;
        }
        this.isPlaying = false;

        this._controllerTarget = { device_id: device.device_id, device_name: device.device_name };
        this._controllerState = null;
        this._controllerPollFailures = 0;

        // Show the controller banner
        this._showControllerBanner(device.device_name);

        // Immediately fetch remote state, then poll every 1s
        this._controllerPoll();
        this._controllerPollTimer = setInterval(() => this._controllerPoll(), 1000);

        window.showToast?.(`Controlling ${device.device_name}`, 'success');
    }

    /** Exit controller mode and restore local player state. */
    _stopControllerMode() {
        this._controllerTarget = null;
        this._controllerState = null;
        if (this._controllerPollTimer) {
            clearInterval(this._controllerPollTimer);
            this._controllerPollTimer = null;
        }
        this._hideControllerBanner();
        // Restore player bar to local state
        if (this.currentSong) this.updateNowPlaying(this.currentSong);
        this._updatePlayPauseIcon();
        window.showToast?.('Back to local playback', 'info');
    }

    /** @returns {boolean} true when this player is in controller mode */
    get isControllerMode() {
        return !!this._controllerTarget;
    }

    /** Send a command to the controlled device. */
    async _controllerCommand(command, args = {}) {
        if (!this._controllerTarget) return;
        this._lastControllerCommandMs = Date.now();
        try {
            await useConnectService().sendCommand(this._controllerTarget.device_id, command, args);
        } catch (e) {
            Logger.warn('Controller command failed:', command, e);
        }
    }

    /** Poll the controlled device's state and mirror it on the player bar. */
    async _controllerPoll() {
        if (!this._controllerTarget) return;
        try {
            const result = await useConnectService().getDevice(this._controllerTarget.device_id);
            const device = result?.value?.device;
            if (!device) {
                // Transient failure — only give up after several consecutive misses
                this._controllerPollFailures++;
                if (this._controllerPollFailures >= 5) {
                    this._stopControllerMode();
                    window.showToast?.('Controlled device went offline', 'info');
                }
                return;
            }
            this._controllerPollFailures = 0;
            
            // Skip stale responses: if we just sent a command, the remote might
            // not have processed it yet, so this response is outdated.
            const now = Date.now();
            if (now - this._lastControllerCommandMs < 1500) {
                return; // Too soon — wait for the next poll
            }
            
            this._controllerState = device;
            this._mirrorControllerState(device);
        } catch (e) {
            this._controllerPollFailures++;
            if (this._controllerPollFailures >= 5) {
                this._stopControllerMode();
                window.showToast?.('Controlled device went offline', 'info');
            }
        }
    }

    /** Update the player bar UI to reflect the remote device's state. */
    _mirrorControllerState(device) {
        // Now-playing info (player bar)
        if (this.nowPlayingTitle) this.nowPlayingTitle.textContent = device.song_title || 'Nothing playing';
        if (this.nowPlayingArtist) this.nowPlayingArtist.textContent = device.song_artist || (device.song_title ? '' : 'Select a song to play');
        if (this.nowPlayingArtwork) {
            const img = this.nowPlayingArtwork.querySelector('img');
            if (device.cover_path) {
                const src = `/api/music/cover/${encodeURIComponent(device.cover_path)}`;
                if (!img || !img.src.startsWith(src)) {
                    this.nowPlayingArtwork.innerHTML = `<img src="${src}" alt="">`;
                }
            } else {
                this.nowPlayingArtwork.innerHTML = '';
            }
        }

        // Fullscreen player info
        if (this.fsTitle) this.fsTitle.textContent = device.song_title || 'Nothing playing';
        if (this.fsArtist) this.fsArtist.textContent = device.song_artist || (device.song_title ? '' : 'Select a song to play');
        if (this.fsArtwork) {
            const img = this.fsArtwork.querySelector('img');
            if (device.cover_path) {
                const src = `/api/music/cover/${encodeURIComponent(device.cover_path)}`;
                if (!img || !img.src.startsWith(src)) {
                    this.fsArtwork.innerHTML = `<img src="${src}" alt="">`;
                }
            } else {
                this.fsArtwork.innerHTML = '';
            }
        }
        if (this.fsBackdrop && device.cover_path) {
            const src = `/api/music/cover/${encodeURIComponent(device.cover_path)}`;
            this.fsBackdrop.style.backgroundImage = `url(${src})`;
        }

        // Queue: mirror remote queue into local playlist and re-render
        const remoteQueue = device.queue;
        const remoteIndex = device.queue_index ?? 0;
        if (Array.isArray(remoteQueue) && remoteQueue.length > 0) {
            // Only update if the queue actually changed (compare by IDs)
            const newIds = remoteQueue.map(s => s?.id).join(',');
            const oldIds = (this.playlist || []).map(s => s?.id).join(',');
            if (newIds !== oldIds) {
                this.playlist = remoteQueue;
                this.currentIndex = remoteIndex;
                this.renderFullscreenQueue();
            } else if (remoteIndex !== this.currentIndex) {
                this.currentIndex = remoteIndex;
                this.renderFullscreenQueue();
            }
        }

        // Lyrics: load for the remote song when it changes
        const remoteSongId = device.song_id;
        if (remoteSongId != null && remoteSongId !== this.lyricsSongId && this.lyricsActive) {
            this.loadLyrics(remoteSongId);
        }

        // Play/pause icon
        this.isPlaying = !!device.is_playing;
        this._updatePlayPauseIcon();

        // Progress bar
        const duration = device.duration || 0;
        const position = device.position || 0;
        if (this.progressFill) {
            this.progressFill.style.width = duration > 0 ? `${Math.min(100, (position / duration) * 100)}%` : '0%';
        }
        if (this.fsProgressFill) {
            this.fsProgressFill.style.width = duration > 0 ? `${Math.min(100, (position / duration) * 100)}%` : '0%';
        }
        // Time labels
        if (this.currentTimeEl) this.currentTimeEl.textContent = this.formatTime(position);
        if (this.totalTimeEl) this.totalTimeEl.textContent = this.formatTime(duration);
        if (this.fsCurrentTimeEl) this.fsCurrentTimeEl.textContent = this.formatTime(position);
        if (this.fsTotalTimeEl) this.fsTotalTimeEl.textContent = this.formatTime(duration);

        // Volume
        const vol = Math.max(0, Math.min(100, device.volume ?? 80));
        if (this.volumeSlider) {
            this.volumeSlider.value = vol;
            this.updateVolumeGradient?.();
        }
        if (this.fsVolumeSlider) {
            this.fsVolumeSlider.value = vol;
            this.updateFsVolumeGradient?.();
        }

        // Shuffle / repeat visual state
        if (this.shuffleBtn) {
            const color = device.is_shuffled ? 'var(--accent-primary)' : '';
            this.shuffleBtn.style.color = color;
            const svg = this.shuffleBtn.querySelector('svg');
            if (svg) svg.style.fill = color;
        }
        if (this.fsShuffleBtn) {
            const color = device.is_shuffled ? 'var(--accent-primary)' : '';
            this.fsShuffleBtn.style.color = color;
            const svg = this.fsShuffleBtn.querySelector('svg');
            if (svg) svg.style.fill = color;
        }
        if (this.repeatBtn) {
            const mode = device.repeat_mode || 'none';
            const color = mode !== 'none' ? 'var(--accent-primary)' : '';
            this.repeatBtn.style.color = color;
            const svg = this.repeatBtn.querySelector('svg');
            if (svg) svg.style.fill = color;
        }
        if (this.fsRepeatBtn) {
            const mode = device.repeat_mode || 'none';
            const color = mode !== 'none' ? 'var(--accent-primary)' : '';
            this.fsRepeatBtn.style.color = color;
            const svg = this.fsRepeatBtn.querySelector('svg');
            if (svg) svg.style.fill = color;
        }
    }

    /** Show the 'Controlling: X' banner above the player bar. */
    _showControllerBanner(deviceName) {
        this._hideControllerBanner();
        const banner = document.createElement('div');
        banner.id = 'controller-banner';
        banner.className = 'controller-banner';
        banner.innerHTML = `
            <span class="controller-banner-icon">📡</span>
            <span class="controller-banner-text">Controlling <strong>${deviceName}</strong></span>
            <button class="controller-banner-stop" title="Stop controlling">Stop</button>
        `;
        banner.querySelector('.controller-banner-stop').addEventListener('click', () => this._stopControllerMode());
        const playerBar = document.querySelector('.player-bar');
        if (playerBar) {
            playerBar.parentNode.insertBefore(banner, playerBar);
        }
        this._controllerBanner = banner;
    }

    _hideControllerBanner() {
        if (this._controllerBanner) {
            this._controllerBanner.remove();
            this._controllerBanner = null;
        }
    }

    /** Update the play/pause button icons based on this.isPlaying. */
    _updatePlayPauseIcon() {
        if (this.iconPlay) this.iconPlay.classList.toggle('hidden', this.isPlaying);
        if (this.iconPause) this.iconPause.classList.toggle('hidden', !this.isPlaying);
        if (this.fsIconPlay) this.fsIconPlay.classList.toggle('hidden', this.isPlaying);
        if (this.fsIconPause) this.fsIconPause.classList.toggle('hidden', !this.isPlaying);
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

        // Preview/discover tracks are ephemeral (videoId-based, not in the
        // library) — don't persist resume state or push to the cross-device
        // sync.
        if (song.videoId) return;

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

        // Also push to server for cross-device sync (throttled)
        this._syncStateToServer();
    }

    /**
     * Start tracking real listening time for a song.
     * Uses wall-clock accumulation (pause-aware) instead of audio.currentTime
     * so seeking doesn't inflate stats.
     * @param {Object} song
     */
    _startListenTracking(song) {
        // Flush any in-progress tracking from the previous song
        this._flushListenTracking();

        if (!song || !song.id) return;
        this._listenTracker = {
            songId: song.id,
            songDuration: song.duration || 0,
            listenedSeconds: 0,
            lastTick: Date.now(),
            recorded: false
        };
    }

    /**
     * Called on every timeupdate while playing — accumulates real elapsed time.
     * Records the play once the 50% threshold is crossed.
     */
    _tickListenTracking() {
        const t = this._listenTracker;
        if (!t || t.recorded) return;

        const now = Date.now();
        const elapsed = (now - t.lastTick) / 1000;
        t.lastTick = now;

        // Count elapsed time while playing. isPlaying already guards against
        // pause gaps; cap at 30s per tick to handle browser tab-suspend edge
        // cases without rejecting legitimate background-tab listening.
        if (elapsed > 0) {
            t.listenedSeconds += Math.min(elapsed, 30);
        }

        // Record once we've listened to at least 50% of the song
        if (t.songDuration > 0 && t.listenedSeconds >= t.songDuration * 0.5) {
            this._recordPlay(t.songId, Math.round(t.listenedSeconds));
            t.recorded = true;
        }
    }

    /**
     * Flush: if the song ended or was skipped before the 50% mark but we
     * listened to at least 30 seconds, still count it (partial credit).
     * @param {boolean} useBeacon - use sendBeacon for page-unload reliability
     */
    _flushListenTracking(useBeacon = false) {
        const t = this._listenTracker;
        if (!t || t.recorded) {
            this._listenTracker = null;
            return;
        }
        // Count partial listens of at least 30 seconds
        if (t.listenedSeconds >= 30) {
            this._recordPlay(t.songId, Math.round(t.listenedSeconds), useBeacon);
        }
        this._listenTracker = null;
    }

    /**
     * Send the actual play record to the server.
     * @param {number} songId
     * @param {number} listenedSeconds - real seconds actually listened
     * @param {boolean} useBeacon - use navigator.sendBeacon (survives page unload)
     */
    _recordPlay(songId, listenedSeconds, useBeacon = false) {
        const payload = JSON.stringify({ song_id: songId, position: 0, duration: listenedSeconds });
        if (useBeacon && navigator.sendBeacon) {
            navigator.sendBeacon('/api/playback/history', new Blob([payload], { type: 'application/json' }));
        } else {
            try {
                usePlaybackService().recordPlay(songId, 0, listenedSeconds);
            } catch (e) {
                Logger.warn('Failed to record play history:', e);
            }
        }
    }

    /**
     * Push current playback state to the server for cross-device sync.
     * Throttled to avoid excessive requests.
     */
    _syncStateToServer() {
        if (this.currentIndex < 0 || !this.playlist.length) return;
        const now = Date.now();
        if (this._lastServerSync && now - this._lastServerSync < 5000) return;
        this._lastServerSync = now;

        const song = this.playlist[this.currentIndex];
        if (!song) return;
        try {
            usePlaybackService().saveState(
                song.id,
                this.audio.currentTime || 0,
                this.playlist,
                this.currentIndex,
                this.isPlaying
            );
        } catch (e) {
            Logger.warn('Failed to sync state to server:', e);
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
