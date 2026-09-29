/**
 * Smooth media clock for the light show.
 *
 * `audio.currentTime` is updated in coarse, jittery steps (and very coarsely
 * in some browsers), which would make beat-locked motion stutter. This clock
 * free-runs on performance.now() between samples and is pulled toward the
 * media time by a soft phase-lock; real jumps (seek, stall, track change)
 * snap immediately and are flagged so consumers can reset edge triggers.
 */
export class PlaybackClock {
    constructor() {
        this.t = 0;
        this.jumped = true;
        this.running = false;
        this._mediaAnchor = 0;
        this._perfAnchor = 0;
        this._lastMedia = NaN;
    }

    /**
     * @param {HTMLAudioElement} audio
     * @param {number} perfNow  seconds (performance.now() / 1000)
     * @param {number} offset   user sync offset in seconds (+ = lights later)
     */
    update(audio, perfNow, offset = 0) {
        const media = audio ? audio.currentTime || 0 : 0;
        const running = !!audio && !audio.paused && !audio.ended && !audio.seeking && audio.readyState >= 3;
        const prevT = this.t;
        const rate = (audio && audio.playbackRate) || 1;

        if (!running) {
            this._mediaAnchor = media;
            this._perfAnchor = perfNow;
        } else if (media !== this._lastMedia) {
            const predicted = this._mediaAnchor + (perfNow - this._perfAnchor) * rate;
            const err = media - predicted;
            if (Math.abs(err) > 0.15) {
                this._mediaAnchor = media;
                this._perfAnchor = perfNow;
            } else {
                this._mediaAnchor += err * 0.2;
            }
        }
        this._lastMedia = media;

        let t = running ? this._mediaAnchor + (perfNow - this._perfAnchor) * rate : media;
        t -= offset;
        const jump = Math.abs(t - prevT) > 0.3;
        // Tiny backwards corrections are absorbed instead of re-firing hits.
        if (!jump && running && t < prevT) t = prevT;
        this.jumped = jump;
        this.running = running;
        this.t = t;
        return t;
    }

    reset() {
        this.jumped = true;
        this._lastMedia = NaN;
    }
}
