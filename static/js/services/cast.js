import { Logger } from "../helper/logger.js";
import { RequestHelper } from "../helper/request.js";

/**
 * @typedef {Object} CastState
 * @property {boolean} available - Cast SDK loaded and receivers discoverable
 * @property {boolean} connected - an active Cast session exists
 * @property {boolean} connecting - a session is being established
 * @property {string|null} deviceName - friendly name of the connected receiver
 * @property {boolean} is_playing
 * @property {number} position - seconds
 * @property {number} duration - seconds
 * @property {number} volume - 0..100
 * @property {string|null} song_title
 * @property {string|null} song_artist
 * @property {string|null} song_album
 * @property {string|null} cover_url
 */

/**
 * Rainy Cast — Google Chromecast sender built on the Cast Application
 * Framework (CAF). Wraps discovery, session management, queue loading and
 * transport controls, and exposes a simple observable state object that the
 * Connect modal and player bar render from.
 *
 * The SDK is only present in Chromium-based browsers; every public method is a
 * safe no-op when casting is unavailable so callers never need to guard.
 */
export class CastService {
    constructor() {
        /** @type {CastState} */
        this.state = {
            available: false,
            connected: false,
            connecting: false,
            deviceName: null,
            is_playing: false,
            position: 0,
            duration: 0,
            volume: 100,
            song_title: null,
            song_artist: null,
            song_album: null,
            cover_url: null,
        };

        /** @type {Set<(state: CastState) => void>} */
        this._listeners = new Set();

        this._context = null;
        this._player = null;
        this._controller = null;
        this._initialized = false;

        // True once the Cast framework has initialized successfully. This is
        // the real capability gate: the device picker does its own discovery,
        // so we surface the Chromecast row as soon as the SDK is ready rather
        // than waiting for getCastState() (which lags discovery and whose
        // CAST_STATE_CHANGED event can be missed, leaving the row hidden even
        // when receivers are present on the network).
        this.sdkReady = false;

        // Metadata for the currently loaded queue, keyed by nothing — we keep
        // the array + active item id so the UI can show now-playing info even
        // before the receiver reports media_info back.
        /** @type {Array<Object>} */
        this._queue = [];

        // Chromecast availability diagnosis. Chrome withholds the Cast Web SDK
        // on insecure (non-https / non-localhost) origins, so we detect that
        // up front and let the UI explain instead of silently showing nothing.
        this.blocked = false;
        this.blockReason = null; // 'insecure' | 'unsupported'
        if (this._isChromium() && window.isSecureContext === false) {
            this.blocked = true;
            this.blockReason = 'insecure';
            Logger.warn('Cast: blocked — insecure origin. Casting needs https:// or http://localhost.');
        }
    }

    _isChromium() {
        return typeof window !== 'undefined' && !!window.chrome &&
            /Chrome|Chromium|CriOS|Edg\//.test(navigator.userAgent);
    }

    /** Record that the Cast SDK cannot initialize here. */
    markUnavailable(reason) {
        if (this.sdkReady) return;
        this.blocked = true;
        this.blockReason = reason || 'unsupported';
        this._set({ available: false });
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    /** Initialize the Cast context. Safe to call multiple times. */
    init() {
        if (this._initialized) return;
        this._initialized = true;

        if (!this._sdkReady()) {
            Logger.info('Cast: SDK not present in this browser/context');
            this.markUnavailable(window.isSecureContext ? 'unsupported' : 'insecure');
            return;
        }

        try {
            const context = cast.framework.CastContext.getInstance();
            context.setOptions({
                receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
            });
            this._context = context;

            this._player = new cast.framework.RemotePlayer();
            this._controller = new cast.framework.RemotePlayerController(this._player);
            this._bindControllerEvents();
            this._bindContextEvents();

            // The framework is up — the picker can now discover receivers even
            // if getCastState() hasn't caught up yet.
            this.sdkReady = true;
            this._set({
                available: true,
                connected: !!context.getCurrentSession(),
            });
            Logger.info('Cast: SDK initialized, initial state =', context.getCastState());

            // Belt-and-suspenders: keep connected/available in sync in case a
            // state event is missed. Never downgrades `available` below the
            // sdkReady baseline (discovery state is the picker's concern).
            this._syncTimer = setInterval(() => this._syncCastState(), 3000);
        } catch (e) {
            Logger.warn('Cast init failed:', e);
            this._set({ available: false });
        }
    }

    /** Re-read the framework state without downgrading the sdkReady baseline. */
    _syncCastState() {
        if (!this._context) return;
        const session = this._context.getCurrentSession();
        const castState = this._context.getCastState();
        const patch = {};
        const connected = !!session;
        if (connected !== this.state.connected) patch.connected = connected;
        const connecting = castState === cast.framework.CastState.CONNECTING;
        if (connecting !== this.state.connecting) patch.connecting = connecting;
        // Once the framework reports receivers, reflect it (purely additive).
        if (!this.state.available &&
            castState !== cast.framework.CastState.NO_DEVICES_AVAILABLE) {
            patch.available = true;
        }
        if (Object.keys(patch).length) this._set(patch);
    }

    _sdkReady() {
        return typeof window !== 'undefined' &&
            !!window.cast && !!window.cast.framework &&
            !!window.chrome && !!window.chrome.cast;
    }

    _bindContextEvents() {
        const EventType = cast.framework.CastContextEventType;
        this._context.addEventListener(EventType.CAST_STATE_CHANGED, (e) => {
            // Never downgrade `available` here — the sdkReady baseline means
            // the picker can always be opened; discovery state is cosmetic.
            const patch = {
                connecting: e.castState === cast.framework.CastState.CONNECTING,
            };
            if (!this.state.available &&
                e.castState !== cast.framework.CastState.NO_DEVICES_AVAILABLE) {
                patch.available = true;
            }
            this._set(patch);
        });
        this._context.addEventListener(EventType.SESSION_STATE_CHANGED, (e) => {
            const session = this._context.getCurrentSession();
            this._set({
                connected: !!session,
                connecting: e.sessionState === cast.framework.SessionState.SESSION_STARTING ||
                    e.sessionState === cast.framework.SessionState.SESSION_RESUMED,
                deviceName: session ? session.getCastDevice()?.friendlyName || 'Chromecast' : null,
            });
            if (!session) {
                // Session ended — clear now-playing info.
                this._queue = [];
                this._set({
                    is_playing: false, position: 0, duration: 0,
                    song_title: null, song_artist: null, song_album: null, cover_url: null,
                });
            }
        });
    }

    _bindControllerEvents() {
        const T = cast.framework.RemotePlayerEventType;
        const on = (type, fn) => this._controller.addEventListener(type, fn);

        on(T.IS_PAUSED_CHANGED, () => this._set({ is_playing: !this._player.isPaused }));
        on(T.IS_PLAYING_CHANGED, () => this._set({ is_playing: this._player.isPlaying }));
        on(T.CURRENT_TIME_CHANGED, () => this._set({ position: Math.floor(this._player.currentTime || 0) }));
        on(T.DURATION_CHANGED, () => this._set({ duration: Math.floor(this._player.duration || 0) }));
        on(T.VOLUME_LEVEL_CHANGED, () => this._set({ volume: Math.round((this._player.volumeLevel || 0) * 100) }));
        on(T.IS_MUTED_CHANGED, () => {
            if (this._player.isMuted) this._set({ volume: 0 });
        });
        on(T.MEDIA_INFO_CHANGED, () => this._syncMediaInfo());
    }

    _syncMediaInfo() {
        const info = this._player.mediaInfo;
        if (!info) return;
        const meta = info.metadata || {};
        const image = Array.isArray(meta.images) && meta.images.length ? meta.images[0]?.url : null;
        this._set({
            song_title: meta.title || meta.songName || null,
            song_artist: meta.artist || meta.albumArtist || null,
            song_album: meta.albumName || null,
            cover_url: image,
            duration: Math.floor(this._player.duration || this.state.duration || 0),
        });
    }

    /* ------------------------------------------------------------------ */
    /* Observation                                                         */
    /* ------------------------------------------------------------------ */

    /** @param {(state: CastState) => void} cb @returns {() => void} unsubscribe */
    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _set(patch) {
        Object.assign(this.state, patch);
        for (const cb of this._listeners) {
            try { cb(this.state); } catch (e) { Logger.warn('Cast listener error:', e); }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Session                                                             */
    /* ------------------------------------------------------------------ */

    /** Open Google's device picker to start a Cast session. */
    async requestSession() {
        this.init();
        if (!this._context) return;
        try {
            await this._context.requestSession();
        } catch (e) {
            // The user cancelling the picker rejects with "cancel" — not an error.
            if (e !== 'cancel') Logger.warn('Cast requestSession failed:', e);
        }
    }

    /** Stop casting and end the session. */
    async endSession() {
        const session = this._context?.getCurrentSession();
        if (!session) return;
        try {
            await session.endSession(true);
        } catch (e) {
            Logger.warn('Cast endSession failed:', e);
        }
    }

    _session() {
        return this._context?.getCurrentSession() || null;
    }

    /* ------------------------------------------------------------------ */
    /* Loading media                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Resolve absolute, token-authenticated stream URLs for a set of songs.
     * @param {Array<number>} songIds
     * @returns {Promise<Object<string, {url: string, cover_url?: string}>>}
     */
    async _resolveUrls(songIds) {
        const result = await RequestHelper.request('/api/music/cast-urls', {
            method: 'POST',
            body: { song_ids: songIds },
        });
        if (result.error) {
            Logger.warn('Cast URL resolution failed:', result.error);
            return {};
        }
        const data = await result.value.json();
        return data.urls || {};
    }

    _guessContentType(url) {
        const lower = (url || '').toLowerCase();
        if (lower.includes('.flac')) return 'audio/flac';
        if (lower.includes('.wav')) return 'audio/wav';
        if (lower.includes('.ogg')) return 'audio/ogg';
        if (lower.includes('.m4a') || lower.includes('.aac')) return 'audio/mp4';
        return 'audio/mpeg';
    }

    /**
     * Load a queue of songs onto the connected receiver and start playback.
     * @param {Array<Object>} songs - {id,title,artist,album,cover_path,duration}
     * @param {number} startIndex
     * @param {number} startPosition - seconds into the start track
     */
    async loadQueue(songs, startIndex = 0, startPosition = 0) {
        this.init();
        const session = this._session();
        if (!session || !Array.isArray(songs) || !songs.length) return;

        const urls = await this._resolveUrls(songs.map(s => s?.id).filter(id => id != null));

        const items = [];
        songs.forEach((song) => {
            const resolved = urls[String(song.id)];
            if (!resolved?.url) return;
            const metadata = new chrome.cast.media.MusicTrackMediaMetadata();
            metadata.title = song.title || 'Unknown';
            metadata.artist = song.artist || 'Unknown Artist';
            metadata.albumName = song.album || '';
            if (resolved.cover_url) {
                metadata.images = [new chrome.cast.Image(resolved.cover_url)];
            }

            const mediaInfo = new chrome.cast.media.MediaInfo(resolved.url, this._guessContentType(resolved.url));
            mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
            mediaInfo.metadata = metadata;

            const item = new chrome.cast.media.QueueItem(mediaInfo);
            item.autoplay = true;
            items.push(item);
        });

        if (!items.length) {
            Logger.warn('Cast: no playable items in queue');
            return;
        }

        const safeIndex = Math.max(0, Math.min(startIndex, items.length - 1));
        this._queue = songs;

        try {
            const request = new chrome.cast.media.QueueLoadRequest(items);
            request.startIndex = safeIndex;
            request.currentTime = startPosition || 0;
            await session.loadMedia(request);
            this._set({ is_playing: true });
        } catch (e) {
            Logger.warn('Cast loadMedia failed:', e);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Transport controls                                                  */
    /* ------------------------------------------------------------------ */

    play() {
        if (this._player && this._player.isPaused) this._controller.playOrPause();
    }

    pause() {
        if (this._player && !this._player.isPaused) this._controller.playOrPause();
    }

    playPause() {
        if (this._controller) this._controller.playOrPause();
    }

    /** @param {number} seconds */
    seek(seconds) {
        if (!this._player || !this._controller) return;
        this._player.currentTime = seconds;
        this._controller.seek();
    }

    /** @param {number} percent 0..100 */
    setVolume(percent) {
        if (!this._player || !this._controller) return;
        this._player.volumeLevel = Math.max(0, Math.min(1, percent / 100));
        if (this._player.isMuted && percent > 0) this._player.isMuted = false;
        this._controller.setVolumeLevel();
        if (percent > 0 && this._player.isMuted) this._controller.muteOrUnmute();
    }

    next() {
        try { this._controller?.queueNext(); } catch (e) { Logger.warn('Cast next failed:', e); }
    }

    previous() {
        try { this._controller?.queuePrev(); } catch (e) { Logger.warn('Cast previous failed:', e); }
    }

    /** @param {boolean} enabled */
    setShuffle(enabled) {
        const session = this._session();
        if (!session) return;
        try {
            const request = new chrome.cast.media.QueueSetPropertiesRequest();
            request.shuffleMode = enabled
                ? chrome.cast.media.ShuffleMode.SHUFFLE
                : chrome.cast.media.ShuffleMode.UNSHUFFLE;
            session.queueSetProperties(request);
        } catch (e) {
            Logger.warn('Cast shuffle failed:', e);
        }
    }

    /** @param {string} mode - 'none' | 'all' | 'one' */
    setRepeat(mode) {
        const session = this._session();
        if (!session) return;
        try {
            const RepeatMode = chrome.cast.media.RepeatMode;
            const map = {
                none: RepeatMode.OFF,
                all: RepeatMode.ALL,
                one: RepeatMode.SINGLE,
            };
            const request = new chrome.cast.media.QueueSetPropertiesRequest();
            request.repeatMode = map[mode] ?? RepeatMode.OFF;
            session.queueSetProperties(request);
        } catch (e) {
            Logger.warn('Cast repeat failed:', e);
        }
    }
}

const __singleton = new CastService();

/** @returns {CastService} */
export function useCastService() {
    return __singleton;
}
