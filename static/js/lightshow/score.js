/**
 * Score timeline: the server-generated choreography (v2) as pure lookups.
 *
 * Everything is a function of media time `t`, so seeking, pausing or a
 * dropped frame can never desync the show — the next frame simply asks
 * "what is happening at t?" again. Past/future lookups (drop in N seconds,
 * build progress, silence ahead) are what makes the choreography anticipate
 * the music instead of reacting to it.
 */
import { clamp } from './palette.js';

export const SCORE_VERSION = 2;

function b64ToBytes(s) {
    const bin = atob(s || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Index of the last element <= t (or -1). */
function floorIndex(arr, t) {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}

export class Score {
    /** @returns {Score|null} */
    static from(data) {
        if (!data || (data.v || 0) < SCORE_VERSION || !data.env || !Array.isArray(data.beats)) return null;
        try {
            return new Score(data);
        } catch (e) {
            return null;
        }
    }

    constructor(d) {
        this.duration = +d.duration || 0;
        this.fps = d.fps || 50;
        this.tempo = d.tempo || 120;
        this.tempoConf = d.tempoConf ?? 0.5;
        this.period = 60 / this.tempo;
        this.beats = Float64Array.from(d.beats || []);
        this.downbeats = Float64Array.from(d.downbeats || []);
        this.env = {};
        for (const k of Object.keys(d.env)) this.env[k] = b64ToBytes(d.env[k]);
        this.onsets = {};
        for (const k of ['k', 's', 'h']) {
            const list = (d.onsets && d.onsets[k]) || [];
            this.onsets[k] = {
                t: Float64Array.from(list.map((o) => o[0])),
                s: Float32Array.from(list.map((o) => o[1])),
            };
        }
        this.sections = (d.sections || []).map((s, i) => ({ ...s, idx: i }));
        if (!this.sections.length) {
            this.sections = [{ t0: 0, t1: this.duration, label: 'verse', energy: 0.5, idx: 0 }];
        }
        this._secStarts = Float64Array.from(this.sections.map((s) => s.t0));
        this.events = (d.events || []).slice().sort((a, b) => a.t - b.t);
        this._evT = Float64Array.from(this.events.map((e) => e.t));
        this.profile = d.profile || { genre: 'pop', intensity: 0.6 };
    }

    envAt(name, t) {
        const a = this.env[name];
        if (!a || !a.length) return 0;
        const x = t * this.fps;
        const i = Math.floor(x);
        if (i < 0) return a[0] / 255;
        if (i >= a.length - 1) return a[a.length - 1] / 255;
        const f = x - i;
        return (a[i] + (a[i + 1] - a[i]) * f) / 255;
    }

    /** Fractional beat number at t (extrapolated outside the tracked range). */
    beatAt(t) {
        const b = this.beats, n = b.length;
        if (n < 2) return t / this.period;
        if (t < b[0]) return (t - b[0]) / this.period;
        if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / this.period;
        const i = floorIndex(b, t);
        return i + (t - b[i]) / (b[i + 1] - b[i]);
    }

    /** Fractional bar number at t (downbeat-aligned). */
    barAt(t) {
        const d = this.downbeats, n = d.length, bar = this.period * 4;
        if (n < 2) return this.beatAt(t) / 4;
        if (t < d[0]) return (t - d[0]) / bar;
        if (t >= d[n - 1]) return n - 1 + (t - d[n - 1]) / bar;
        const i = floorIndex(d, t);
        return i + (t - d[i]) / (d[i + 1] - d[i]);
    }

    sectionAt(t) {
        const i = Math.max(0, floorIndex(this._secStarts, t));
        return this.sections[Math.min(i, this.sections.length - 1)];
    }

    /** Strongest onset of a type in (t0, t1] — 0 when none. */
    hitIn(type, t0, t1) {
        const o = this.onsets[type];
        if (!o || !o.t.length || t1 <= t0) return 0;
        let i = floorIndex(o.t, t0) + 1;
        let best = 0;
        while (i < o.t.length && o.t[i] <= t1) {
            if (o.s[i] > best) best = o.s[i];
            i++;
        }
        return best;
    }

    /** Events whose time falls in (t0, t1]. */
    eventsIn(t0, t1) {
        const out = [];
        if (t1 <= t0) return out;
        let i = floorIndex(this._evT, t0) + 1;
        while (i < this.events.length && this.events[i].t <= t1) out.push(this.events[i++]);
        return out;
    }

    nextEvent(type, t, horizon = 30) {
        let i = floorIndex(this._evT, t) + 1;
        while (i < this.events.length && this.events[i].t - t <= horizon) {
            if (this.events[i].type === type) return this.events[i];
            i++;
        }
        return null;
    }

    /** Depth (0..1) of a 'stop' (pre-drop silence) around t, with soft edges. */
    stopDepth(t) {
        let i = floorIndex(this._evT, t);
        for (let k = 0; k < 3 && i >= 0; k++, i--) {
            const e = this.events[i];
            if (e.type !== 'stop') continue;
            const end = e.t + (e.dur || 0.3);
            if (t >= e.t && t < end) {
                return clamp(Math.min((t - e.t) / 0.04, (end - t) / 0.03), 0, 1);
            }
        }
        return 0;
    }
}
