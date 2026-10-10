/**
 * Song radio.
 *
 * "Start radio" on a song plays an endless queue of similar music built
 * around it (/api/radio). It follows YouTube Music's radio for that song:
 * tracks the listener already owns play from their library, the rest are
 * new discoveries.
 *
 * New songs arrive as pending tracks ({ videoId, radio: true }). The few
 * coming up next are downloaded ahead of playback (/api/radio/prefetch)
 * and turned into the real song once ready, which is when likes, lyrics
 * and history start working for them. A track reached before its download
 * lands still plays, through the YouTube preview stream, and becomes the
 * real song mid-play as soon as the download finishes.
 */
import { Logger } from '../helper/logger.js';

const BATCH = 12;
const LOW_WATER = 4;     // top the queue up when this few songs remain
const AHEAD = 3;         // pending tracks kept downloading ahead of playback
const POLL_MS = 2000;
const SKIP_SECONDS = 30; // leaving a song sooner than this counts as a skip

export class SongRadio {
    /**
     * @param {import('../player.js').AudioPlayer} player
     * @param {{onEmpty?: () => void, onKeepFailed?: (song: object) => void}} [hooks]
     *  onEmpty: a radio found nothing to play; onKeepFailed: a song the
     *  listener asked to keep could not be downloaded.
     */
    constructor(player, hooks = {}) {
        this.player = player;
        this.hooks = hooks;
        this._session = null;
        this._pollTimer = null;
        this._polling = false;
    }

    /**
     * @param {{id: number, title?: string, artist?: string}} song the seed
     */
    async start(song) {
        if (!song || song.id == null) return;
        const player = this.player;
        const ctx = { type: 'radio', id: song.id, endless: true };

        if (player.isControllerMode) {
            // The remote device plays what it is sent: hand it the seed plus
            // the songs of the first batch that are already on disk (it can't
            // fetch new ones).
            const items = await this._request('start', { song_id: song.id, limit: BATCH });
            player.playSong(0, [song, ...items.filter(s => s.id != null)], ctx);
            return;
        }

        const queue = [song];
        const session = {
            ctx, queue, seedId: song.id,
            videos: new Set(), skipped: [], failed: new Set(), keep: new Set(),
            pending: null, exhausted: false,
        };
        this._session = session;
        // The first batch counts as a top-up in flight: starting the seed
        // makes the player ask to extend the (one-song) queue right away,
        // and that must wait for this instead of also asking for more.
        const first = this._request('start', { song_id: song.id, limit: BATCH });
        session.pending = first.then(() => {});
        player.playSong(0, queue, ctx);   // the seed plays while the queue fills

        const items = await first;
        session.pending = null;
        if (!this._alive(session)) return;
        if (!items.length) {
            this.hooks.onEmpty?.();
            return;
        }
        this._append(session, items);
        this._poll();
    }

    /**
     * Keep the running radio going: top the queue up when it runs low and
     * keep the next new songs downloading. Called by the player whenever
     * the current song changes; resolves once any top-up has landed.
     */
    extend() {
        const session = this._session;
        if (!this._alive(session)) return Promise.resolve();
        this._poll();
        if (session.pending) return session.pending;
        if (session.exhausted) return Promise.resolve();
        if (session.queue.length - this.player.currentIndex > LOW_WATER) return Promise.resolve();

        session.pending = (async () => {
            const items = await this._request('more', {
                song_id: session.seedId,
                limit: BATCH,
                exclude_song_ids: session.queue.map(s => s?.id).filter(Number.isInteger),
                exclude_video_ids: [...session.videos],
                skipped_artists: session.skipped,
            });
            if (!this._alive(session)) return;
            if (!items.length) { session.exhausted = true; return; }
            this._append(session, items);
            this._poll();
        })().finally(() => { session.pending = null; });
        return session.pending;
    }

    /** The listener moved on from `song` after `seconds` of it. */
    noteSkip(song, seconds) {
        const session = this._session;
        if (!this._alive(session) || !song || song.id === session.seedId) return;
        if (!(seconds < SKIP_SECONDS)) return;
        const artist = String(song.artist || '').split(',')[0].trim();
        if (!artist) return;
        session.skipped.push(artist);
        if (session.skipped.length > 20) session.skipped.shift();
    }

    /**
     * Keep a track that is still downloading: it is saved to the library
     * the moment its download lands.
     * @returns {'queued'|'failed'|null} null when it isn't one of this radio's tracks
     */
    keepWhenReady(song) {
        const session = this._session;
        if (!this._alive(session) || !song?.videoId || song.id != null) return null;
        if (session.failed.has(song.videoId)) return 'failed';
        session.keep.add(song.videoId);
        song.keepRequested = true;
        this._poll();
        return 'queued';
    }

    _alive(session) {
        return !!session && this._session === session
            && this.player.playlist === session.queue
            && this.player.playbackContext === session.ctx;
    }

    async _request(action, body) {
        try {
            const res = await fetch(`/api/radio/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data.queue) ? data.queue : [];
        } catch (err) {
            Logger.warn('Radio request failed:', err);
            return [];
        }
    }

    _append(session, items) {
        const player = this.player;
        const haveIds = new Set(session.queue.map(s => s?.id).filter(id => id != null));
        const fresh = items.filter(s =>
            s.id != null ? !haveIds.has(s.id) : (s.videoId && !session.videos.has(s.videoId)));
        if (!fresh.length) return;
        fresh.forEach(s => {
            s.radio = true;   // came from the radio (the player offers to keep new ones)
            if (s.videoId) session.videos.add(s.videoId);
        });
        const start = session.queue.length;
        session.queue.push(...fresh);
        fresh.forEach((s, i) => player._shuffleRemaining?.add(player._songKey(s, start + i)));
        this._refreshQueueView();
    }

    _refreshQueueView() {
        const player = this.player;
        if (player.fsQueueList) player.renderFullscreenQueue();
    }

    /** Pending tracks to download: the one playing now (it started before
     *  its download landed) and the next few in play order. */
    _upcoming(session) {
        const pending = s => s?.radio && s.videoId && s.id == null && !session.failed.has(s.videoId);
        const index = this.player.currentIndex;
        const next = session.queue.slice(index + 1).filter(pending).slice(0, AHEAD);
        const current = session.queue[index];
        return pending(current) ? [current, ...next] : next;
    }

    /** Ask for the upcoming downloads; repeats while any are pending. */
    async _poll() {
        const session = this._session;
        if (!this._alive(session) || this._polling) return;
        clearTimeout(this._pollTimer);
        const tracks = this._upcoming(session);
        if (!tracks.length) return;

        this._polling = true;
        let states = {};
        try {
            const res = await fetch('/api/radio/prefetch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tracks }),
            });
            if (res.ok) states = (await res.json()).tracks || {};
        } catch (err) {
            Logger.warn('Radio prefetch failed:', err);
        } finally {
            this._polling = false;
        }
        if (!this._alive(session)) return;

        let swapped = false;
        for (const [videoId, state] of Object.entries(states)) {
            if (state.status === 'failed') { this._fail(session, videoId); continue; }
            if (state.status !== 'ready' || !state.song) continue;
            swapped = this._swap(session, videoId, state.song) || swapped;
        }
        if (swapped) this._refreshQueueView();
        if (this._upcoming(session).length) {
            this._pollTimer = setTimeout(() => this._poll(), POLL_MS);
        }
    }

    /** A download gave up: the track stays playable through the preview
     *  stream, but it can't be kept. */
    _fail(session, videoId) {
        session.failed.add(videoId);
        if (!session.keep.delete(videoId)) return;
        const song = session.queue.find(s => s?.videoId === videoId && s.id == null);
        if (!song) return;
        song.keepRequested = false;
        this.hooks.onKeepFailed?.(song);
    }

    /** Turn a pending track into its downloaded song. The queue entry is
     *  updated in place, so the one playing right now keeps playing (from
     *  the preview stream) while it gains its id, cover and library actions. */
    _swap(session, videoId, song) {
        const player = this.player;
        const index = session.queue.findIndex(s => s?.videoId === videoId && s.id == null);
        if (index < 0) return false;
        const entry = session.queue[index];
        const oldKey = player._songKey(entry, index);
        const duplicate = session.queue.some(s => s?.id === song.id);
        if (duplicate && index !== player.currentIndex) {
            // Already queued as a library song: drop the pending copy.
            session.queue.splice(index, 1);
            if (index < player.currentIndex) player.currentIndex -= 1;
            player._shuffleRemaining?.delete(oldKey);
            session.keep.delete(videoId);
            return true;
        }
        player.adoptDownloadedSong(index, song);
        if (player._shuffleRemaining?.delete(oldKey)) {
            player._shuffleRemaining.add(player._songKey(entry, index));
        }
        if (session.keep.delete(videoId)) player.keepSong(entry);
        return true;
    }
}
