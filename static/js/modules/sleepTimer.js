/**
 * Sleep Timer — fade out volume and pause after a set duration.
 * Integrates with the AudioPlayer instance.
 */
import { Logger } from '../helper/logger.js';

export class SleepTimer {
    constructor(player) {
        this.player = player;
        this.remainingMs = 0;
        this.timerId = null;
        this.tickId = null;
        this.fadeId = null;
        this.originalVolume = 1;
        this.isActive = false;
        this.onTick = null;      // callback(remainingMs)
        this.onEnd = null;       // callback()
        this.FADE_DURATION_MS = 15000; // 15s fade
    }

    /** Start a sleep timer for the given number of minutes. */
    start(minutes) {
        this.cancel();
        this.remainingMs = minutes * 60 * 1000;
        this.isActive = true;
        this.originalVolume = this.player.audio ? this.player.audio.volume : 1;

        const startedAt = Date.now();
        const targetEnd = startedAt + this.remainingMs;

        this.tickId = setInterval(() => {
            this.remainingMs = Math.max(0, targetEnd - Date.now());
            if (this.onTick) this.onTick(this.remainingMs);

            // Begin fade in the last FADE_DURATION_MS
            if (this.remainingMs <= this.FADE_DURATION_MS && !this.fadeId) {
                this._startFade();
            }

            if (this.remainingMs <= 0) {
                this._finish();
            }
        }, 1000);

        Logger.info(`Sleep timer started: ${minutes} min`);
    }

    _startFade() {
        if (!this.player.audio) return;
        const startVol = this.originalVolume;
        const fadeStart = Date.now();
        this.fadeId = setInterval(() => {
            const elapsed = Date.now() - fadeStart;
            const frac = Math.min(1, elapsed / this.FADE_DURATION_MS);
            if (this.player.audio) {
                this.player.audio.volume = Math.max(0, startVol * (1 - frac));
            }
            if (frac >= 1) {
                clearInterval(this.fadeId);
                this.fadeId = null;
            }
        }, 200);
    }

    _finish() {
        if (this.player.isPlaying) this.player.togglePlayPause();
        if (this.player.audio) this.player.audio.volume = this.originalVolume;
        this.cancel();
        if (this.onEnd) this.onEnd();
        Logger.info('Sleep timer ended — playback paused');
    }

    /** Cancel the timer and restore volume. */
    cancel() {
        if (this.tickId) { clearInterval(this.tickId); this.tickId = null; }
        if (this.fadeId) { clearInterval(this.fadeId); this.fadeId = null; }
        if (this.player.audio) this.player.audio.volume = this.originalVolume;
        this.isActive = false;
        this.remainingMs = 0;
    }

    /** Format remaining time as M:SS. */
    static format(ms) {
        const totalSec = Math.ceil(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }
}
