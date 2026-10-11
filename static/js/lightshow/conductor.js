/**
 * Conductor — the musical direction every environment shares.
 *
 * It turns the frame from the source (beats, hits, sections, lookahead) into
 * the state of the show: how hard it goes (intensity), the hit envelopes, the
 * 8-bar phrase count, the palette for the section's key, the master dimmer
 * (pause, blackouts, the breath before a drop) and the flash limiter.
 *
 * An environment only decides what that state looks like. It reads the
 * conductor in `update(S)` / `render(S)` and asks for flashes through it, so
 * the photosensitivity limit holds whatever is drawing the show.
 */
import { clamp, lerp, paletteFor, blendPalette, mixRgb } from './palette.js';

export const MIN_FLASH_GAP = 1 / 3;   // ≤ 3 flashes per second (WCAG 2.3.1)
export const PHRASE_BARS = 8;
const INTENSITY = { chill: 0.3, balanced: 0.65, hype: 1 };

export class Conductor {
    constructor() {
        this.accentHue = 350;
        this.palette = paletteFor({ accentHue: this.accentHue, label: 'intro', genre: 'pop' });
        this.pulse = { k: 0, s: 0, h: 0 };
        this.flashAmt = 0;
        this.flashColor = [255, 255, 255];
        this._lastFlashAt = -1;
        this.blinderAmt = 0;
        this.burstAmt = 0;
        this.dim = 1;

        // Per-frame state, filled by update().
        this.F = null;
        this.t = 0;
        this.now = 0;
        this.dt = 1 / 60;
        this.I = 0.65;
        this.phrase = 0;
        this.running = false;
        this.prefs = {};
        // Set by the engine: the song on stage and whether its lyrics are up.
        this.songId = 0;
        this.lyrics = null;
        this.lyricsOn = false;

        this.reset();
    }

    /** A new score or track: phrases and palette start over. */
    reset() {
        this.paletteKey = '';
        this.paletteTarget = null;
        this._secIdx = -1;
        this._phrase = 0;
    }

    onTrackChange() {
        this.reset();
        this.flashAmt = 0;
        this.blinderAmt = 0;
        this.burstAmt = 0;
    }

    /**
     * Advance the show state by one frame.
     * @param {object} F      musical frame from the source (jumped/running already set)
     * @param {object} prefs  engine preferences (intensity, reduceFlashing, …)
     * @param {number} t      media time
     * @param {number} now    perf seconds
     * @param {number} dt
     * @returns {Conductor} itself, as the show state `S`
     */
    update(F, prefs, t, now, dt) {
        this.F = F;
        this.prefs = prefs;
        this.t = t;
        this.now = now;
        this.dt = dt;
        const running = this.running = !!F.running;

        this.I = prefs.intensity === 'auto' || !(prefs.intensity in INTENSITY)
            ? clamp(0.35 + 0.65 * ((F.profile && F.profile.intensity) ?? 0.6), 0.3, 1)
            : INTENSITY[prefs.intensity];

        // Hit envelopes (instant attack, short release).
        const p = this.pulse;
        p.k = Math.max(p.k * Math.exp(-dt / 0.13), F.hits.k);
        p.s = Math.max(p.s * Math.exp(-dt / 0.15), F.hits.s);
        p.h = Math.max(p.h * Math.exp(-dt / 0.07), F.hits.h);
        if (F.jumped) p.k = p.s = p.h = 0;
        F.pulse = p;

        // ---- Phrase + palette ----
        const sec = F.section || { label: 'verse', idx: 0 };
        const genre = (F.profile && F.profile.genre) || 'pop';
        let phrase = Math.floor(F.sectionBar / PHRASE_BARS);
        // Don't start a new phrase in the last two bars of a section — the
        // section change right after would make it a one-bar blip.
        if (sec.idx === this._secIdx && phrase !== this._phrase && F.nextIn < (F.period || 0.5) * 8) phrase = this._phrase;
        this._secIdx = sec.idx;
        this._phrase = phrase;
        this.phrase = phrase;

        let snap = F.jumped;
        const palKey = `${sec.idx}:${phrase & 1}`;
        if (palKey !== this.paletteKey) {
            this.paletteKey = palKey;
            this.paletteTarget = paletteFor({
                accentHue: this.accentHue, key: sec.key, mode: sec.mode, label: sec.label, genre, swap: (phrase & 1) === 1,
            });
            if (sec.label === 'drop' && F.sectionBar === 0) snap = true;
        }
        if (this.paletteTarget) blendPalette(this.palette, this.paletteTarget, snap ? 1 : 1 - Math.exp(-dt / 0.6));

        // ---- Master dimmer: blackouts, pre-drop suck-back, pause ----
        let dimTarget = running ? 1 : 0.35;
        if (F.stopDepth > 0) dimTarget = 1 - 0.96 * F.stopDepth;
        else if (F.dropIn > 0 && F.dropIn < F.period && F.stopIn > F.dropIn) {
            dimTarget = 1 - 0.45 * (1 - F.dropIn / F.period);
        }
        this.dim = F.stopDepth > 0 || F.jumped ? dimTarget : lerp(this.dim, dimTarget, 1 - Math.exp(-dt / 0.08));
        return this;
    }

    /** Strobe with a hard photosensitivity limiter. */
    flash(amount, color) {
        if (this.prefs.reduceFlashing) {
            amount = Math.min(amount * 0.3, 0.2);
            color = mixRgb(this.palette.a, color, 0.3);
        }
        if (amount > 0.12) {
            if (this.now - this._lastFlashAt < MIN_FLASH_GAP) amount = Math.min(amount, 0.08);
            else this._lastFlashAt = this.now;
        }
        if (amount > this.flashAmt) {
            this.flashAmt = amount;
            this.flashColor = color;
        }
    }

    blind(amount) {
        if (amount > this.blinderAmt) this.blinderAmt = amount;
    }

    burst(amount) {
        if (amount > this.burstAmt) this.burstAmt = amount;
    }

    /** Let this frame's flashes ring out: called between an environment's update and render. */
    settle(dt) {
        this.flashAmt *= Math.exp(-dt / 0.07);
        this.blinderAmt *= Math.exp(-dt / 0.14);
        this.burstAmt *= Math.exp(-dt / 0.6);
    }
}
