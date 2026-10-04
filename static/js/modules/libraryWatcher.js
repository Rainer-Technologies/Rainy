/**
 * Library Watcher — keeps songs and playlists live without a page reload.
 *
 * Polls a pair of cheap server fingerprints (see /api/music/library/version)
 * and only re-fetches the library or playlists when one of them changes, so
 * songs imported by a background job, another tab, another device or another
 * user show up on their own. Polling pauses while the tab is hidden and
 * catches up as soon as it becomes visible again.
 */
import { Logger } from '../helper/logger.js';
import { useMusicService } from '../services/music.js';

const POLL_INTERVAL_MS = 5000;

export class LibraryWatcher {
    constructor(app) {
        this.app = app;
        this._timer = null;
        this._busy = false;
        // null = not seen yet; the first check then refreshes once so
        // nothing that changed during the initial load is missed.
        this._songsVersion = null;
        this._playlistsVersion = null;
        this._onVisibilityChange = () => {
            if (document.visibilityState === 'visible') this.check();
        };
    }

    /** Begin polling (called once the signed-in app has loaded). */
    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this.check(), POLL_INTERVAL_MS);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    /** Stop polling (called on logout / session expiry). */
    stop() {
        clearInterval(this._timer);
        this._timer = null;
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        this._songsVersion = null;
        this._playlistsVersion = null;
    }

    /**
     * Record the songs version the UI just rendered, so a library load
     * triggered elsewhere doesn't cause a redundant background refresh.
     * @param {string|undefined} version
     */
    noteSongsVersion(version) {
        if (version) this._songsVersion = version;
    }

    async check() {
        // Skip while signed out (login screen) — it would only 401.
        if (this._busy || !this.app?.user || document.visibilityState !== 'visible') return;
        this._busy = true;
        try {
            const data = await useMusicService().libraryVersion();
            if (data.error || !data.value || !this.app.user) return;

            const { songs, playlists } = data.value;
            if (songs !== this._songsVersion) {
                // loadLibrary records the version it rendered on success; a
                // failed refresh leaves the old one so the next tick retries.
                await this.app.loadLibrary({ silent: true });
            }
            if (playlists !== this._playlistsVersion) {
                if (await this.app.refreshPlaylists()) this._playlistsVersion = playlists;
            }
        } catch (e) {
            Logger.warn('Library watcher check failed:', e);
        } finally {
            this._busy = false;
        }
    }
}
