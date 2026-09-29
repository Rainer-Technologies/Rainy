/**
 * Listening-history tracking shared by the player.
 *
 * Two independent pieces (kept dependency-free so they can be unit-tested):
 *
 *  - ListenTracker: turns playback ticks into "listens". It counts real
 *    playback progress (seek/pause/buffer-proof), gives every listen a random
 *    play_id and reports it three times as it grows: once it is clearly a
 *    real listen (START_SECONDS -> feeds Recently Played), once it qualifies
 *    (countThreshold -> feeds Most Played / stats) and a final tally.
 *
 *  - PlayRecorder: a persistent, retrying outbox. Reports are merged by
 *    play_id, saved to localStorage and re-sent (batched) until the server
 *    acknowledges them, so a dropped connection, a closed tab or a server
 *    restart no longer loses plays. The server upserts on (user, play_id),
 *    so re-sending is always safe.
 *
 * The mobile app implements the same rules (lib/services/play_recorder.dart).
 */

export const START_SECONDS = 8;
export const CHECKPOINT_SECONDS = 60;

/** Seconds of listening after which a listen counts as a "play". */
export function countThreshold(duration) {
    // Spotify/Last.fm style: 30s, or half of a short track.
    if (!(duration > 0)) return 30;
    return Math.max(5, Math.min(30, duration * 0.5));
}

export class ListenTracker {
    /**
     * @param {{ onEvent: (payload: object) => void, now?: () => number, newId?: () => string }} opts
     */
    constructor({ onEvent, now = Date.now, newId = defaultId }) {
        this._onEvent = onEvent;
        this._now = now;
        this._newId = newId;
        this._cur = null;
    }

    get songId() {
        return this._cur ? this._cur.song.id : null;
    }

    /** Start a fresh listen (finalises the previous one). */
    begin(song, position = 0) {
        this.end();
        if (!song || !Number.isFinite(Number(song.id)) || Number(song.id) <= 0) return;
        this._cur = {
            song,
            duration: Number(song.duration) || 0,
            playId: this._newId(),
            startedAt: this._now(),
            listened: 0,
            lastPos: position,
            lastWall: this._now(),
            started: false,
            counted: false,
            sentListened: 0,
        };
    }

    /**
     * Re-anchor after a pause/seek so the gap isn't counted.
     * @param {number} position seconds
     */
    sync(position) {
        const c = this._cur;
        if (!c) return;
        c.lastPos = position;
        c.lastWall = this._now();
    }

    /**
     * Feed one playback tick.
     * @param {{ position: number, playing: boolean, rate?: number, duration?: number }} t
     */
    tick({ position, playing, rate = 1, duration = 0 }) {
        let c = this._cur;
        if (!c) return;
        const wall = this._now();
        if (!c.duration && duration > 0) c.duration = duration;

        if (!playing) {
            c.lastPos = position;
            c.lastWall = wall;
            return;
        }

        const dPos = position - c.lastPos;
        const dWall = (wall - c.lastWall) / 1000;
        const prevPos = c.lastPos;
        c.lastPos = position;
        c.lastWall = wall;

        // Jumped back from the tail to the head: the song looped (repeat one /
        // manual replay) — that's a new listen, not more of this one.
        if (c.duration > 0 && dPos < 0 && prevPos > c.duration * 0.8 && position < c.duration * 0.2) {
            this.begin(c.song, position);
            return;
        }

        // Only credit progress that real time could have produced. A seek
        // forward moves the position much faster than the wall clock.
        if (dPos > 0 && dPos <= dWall * rate * 1.5 + 0.75) {
            c.listened += dPos;
        }

        const ct = countThreshold(c.duration);
        if (!c.started && c.listened >= Math.min(START_SECONDS, ct)) {
            c.started = true;
            this._emit(c);
        }
        if (!c.counted && c.listened >= ct) {
            c.counted = true;
            this._emit(c);
        } else if (c.counted && c.listened - c.sentListened >= CHECKPOINT_SECONDS) {
            this._emit(c);
        }
    }

    /** Emit progress without ending the listen (tab hidden, etc.). */
    checkpoint() {
        const c = this._cur;
        if (c && c.started && c.listened - c.sentListened >= 1) this._emit(c);
    }

    /** Finish the current listen, reporting its final tally. */
    end() {
        this.checkpoint();
        this._cur = null;
    }

    _emit(c) {
        c.sentListened = c.listened;
        this._onEvent({
            song_id: Number(c.song.id),
            play_id: c.playId,
            duration: Math.round(c.listened),
            counted: c.counted,
            started_at: c.startedAt,
            client: 'web',
        });
    }
}

const QUEUE_KEY = 'rainy_play_queue_v1';
const MAX_QUEUE = 500;
const MAX_ENTRY_AGE_MS = 25 * 24 * 3600 * 1000;
const RETRY_MIN_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;

export class PlayRecorder {
    /**
     * @param {{
     *   url?: string,
     *   storage?: Storage | null,
     *   fetchFn?: typeof fetch,
     *   beaconFn?: ((url: string, data: Blob) => boolean) | null,
     *   now?: () => number,
     *   setTimer?: typeof setTimeout,
     *   clearTimer?: typeof clearTimeout,
     *   onRecorded?: () => void,
     * }} opts
     */
    constructor({
        url = '/api/playback/history/batch',
        storage = safeStorage(),
        fetchFn = (...a) => fetch(...a),
        beaconFn = typeof navigator !== 'undefined' && navigator.sendBeacon
            ? (u, d) => navigator.sendBeacon(u, d) : null,
        now = Date.now,
        setTimer = (...a) => setTimeout(...a),
        clearTimer = (...a) => clearTimeout(...a),
        onRecorded = null,
    } = {}) {
        this._url = url;
        this._storage = storage;
        this._fetch = fetchFn;
        this._beacon = beaconFn;
        this._now = now;
        this._setTimer = setTimer;
        this._clearTimer = clearTimer;
        this._onRecorded = onRecorded;
        this._entries = this._load();
        this._inFlight = false;
        this._dirty = false;
        this._timer = null;
        this._retryMs = RETRY_MIN_MS;
        // A new play (or one that just started counting) is waiting to be
        // sent — unlike a mere duration top-up, this changes what lists show.
        this._visibleChange = false;
        // play_id -> counted, for plays the server already has (bounded), so a
        // later top-up of an acknowledged play isn't mistaken for a new one.
        this._acked = new Map();
    }

    get pending() {
        return this._entries.length;
    }

    /** Queue a report (merged by play_id) and send soon. */
    enqueue(payload) {
        const existing = this._entries.find(e => e.play_id === payload.play_id);
        if (existing) {
            if (payload.counted && !existing.counted) this._visibleChange = true;
            existing.duration = Math.max(existing.duration, payload.duration);
            existing.counted = existing.counted || payload.counted;
            existing.v++;
        } else {
            const prev = this._acked.get(payload.play_id);
            if (prev === undefined || (payload.counted && !prev)) this._visibleChange = true;
            this._entries.push({ ...payload, v: 0 });
            if (this._entries.length > MAX_QUEUE) this._entries.splice(0, this._entries.length - MAX_QUEUE);
        }
        this._save();
        this._schedule(0);
    }

    /** Send everything pending; resolves true when the queue drained. */
    async flush() {
        if (this._inFlight) {
            this._dirty = true;
            return false;
        }
        this._prune();
        if (!this._entries.length) return true;

        this._inFlight = true;
        this._dirty = false;
        const visibleChange = this._visibleChange;
        this._visibleChange = false;
        const sent = this._entries.map(e => ({ id: e.play_id, v: e.v, counted: e.counted }));
        const body = JSON.stringify({ plays: this._entries.map(e => this._wire(e)) });
        let drained = false;
        try {
            const res = await this._fetch(this._url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body,
                keepalive: body.length < 60_000,
            });
            // 2xx: every item was recorded or permanently rejected. 400/413:
            // the batch itself is malformed — retrying can never help.
            if (res.ok || res.status === 400 || res.status === 413) {
                this._ack(sent);
                this._retryMs = RETRY_MIN_MS;
                drained = this._entries.length === 0;
                if (res.ok && visibleChange && this._onRecorded) this._onRecorded();
            } else {
                this._visibleChange ||= visibleChange;
                // 401 (logged out), 5xx, 429...: keep everything, back off.
                this._backoff();
            }
        } catch {
            this._visibleChange ||= visibleChange;
            this._backoff();
        } finally {
            this._inFlight = false;
        }
        if (this._dirty) this._schedule(0);
        return drained;
    }

    /**
     * Best-effort send for page unload. Entries stay queued: the server
     * dedupes by play_id, so the next page load can safely re-send them.
     */
    flushBeacon() {
        if (!this._beacon || !this._entries.length) return;
        try {
            const body = JSON.stringify({ plays: this._entries.map(e => this._wire(e)) });
            this._beacon(this._url, new Blob([body], { type: 'application/json' }));
        } catch { /* nothing more we can do while unloading */ }
    }

    _wire(e) {
        return {
            song_id: e.song_id,
            play_id: e.play_id,
            duration: e.duration,
            counted: e.counted,
            client: e.client,
            // Relative so a wrong local clock can't misplace the play.
            age_seconds: Math.max(0, Math.round((this._now() - e.started_at) / 1000)),
        };
    }

    _ack(sent) {
        const done = new Map(sent.map(s => [s.id, s.v]));
        for (const s of sent) {
            const was = this._acked.get(s.id) === true;
            this._acked.delete(s.id); // re-insert = most recent
            this._acked.set(s.id, was || s.counted);
        }
        while (this._acked.size > 200) this._acked.delete(this._acked.keys().next().value);
        // Keep entries that grew while the request was in flight.
        this._entries = this._entries.filter(e => !(done.has(e.play_id) && done.get(e.play_id) === e.v));
        this._save();
    }

    _backoff() {
        this._schedule(this._retryMs);
        this._retryMs = Math.min(this._retryMs * 2, RETRY_MAX_MS);
    }

    _schedule(ms) {
        if (this._timer) this._clearTimer(this._timer);
        this._timer = this._setTimer(() => {
            this._timer = null;
            this.flush();
        }, ms);
    }

    _prune() {
        const cutoff = this._now() - MAX_ENTRY_AGE_MS;
        const kept = this._entries.filter(e => e.started_at > cutoff);
        if (kept.length !== this._entries.length) {
            this._entries = kept;
            this._save();
        }
    }

    _load() {
        try {
            const raw = this._storage?.getItem(QUEUE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed)
                ? parsed.filter(e => e && e.play_id && e.song_id).map(e => ({ ...e, v: 0 }))
                : [];
        } catch {
            return [];
        }
    }

    _save() {
        try {
            this._storage?.setItem(QUEUE_KEY, JSON.stringify(this._entries));
        } catch { /* storage full/blocked: still works in memory */ }
    }
}

function safeStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
        return null;
    }
}

function defaultId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
