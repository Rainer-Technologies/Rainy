/**
 * Frame sources: turn "time t" into the musical state the director uses.
 *
 *  - ScoreSource: reads the server-generated score. Exact beats, bars,
 *    sections, hits, and lookahead (drop in N s, build progress, silences).
 *  - LiveSource:  fallback while a song has no score yet. Guesses the same
 *    fields in real time from an AnalyserNode (no lookahead).
 *
 * Both produce the same frame shape, so the renderer never cares which one
 * is driving it.
 */
import { clamp, lerp } from './palette.js';
import { getAudioGraph } from '../audioGraph.js';

const BAND_KEYS = ['sub', 'bass', 'mid', 'high', 'air', 'rms', 'harm'];

function baseFrame() {
    return {
        scripted: false,
        t: 0,
        bands: { sub: 0, bass: 0, mid: 0, high: 0, air: 0, rms: 0, harm: 0 },
        hits: { k: 0, s: 0, h: 0 },
        beat: 0, bar: 0, beatPhase: 0, barPhase: 0, beatInBar: 0, period: 0.5,
        newBeat: false, newBar: false,
        section: null, sectionProgress: 0, sectionBar: 0, nextSection: null, nextIn: Infinity,
        dropIn: Infinity, stopDepth: 0, stopIn: Infinity, buildProgress: 0,
        events: [],
        profile: { genre: 'pop', intensity: 0.6 },
        tempoConf: 0.5,
    };
}

// ------------------------------------------------------------------ score

export class ScoreSource {
    constructor(score) {
        this.score = score;
    }

    frame(t, tPrev, jumped) {
        const s = this.score;
        const F = baseFrame();
        F.scripted = true;
        F.t = t;
        F.tempoConf = s.tempoConf;
        F.profile = s.profile;
        F.period = s.period;
        for (const k of BAND_KEYS) F.bands[k] = s.envAt(k, t);

        F.beat = s.beatAt(t);
        F.bar = s.barAt(t);
        F.beatPhase = F.beat - Math.floor(F.beat);
        F.barPhase = F.bar - Math.floor(F.bar);
        F.beatInBar = Math.floor(F.barPhase * 4 + 1e-6) & 3;
        const live = !jumped && t > tPrev && t - tPrev < 0.25;
        if (live) {
            F.newBeat = Math.floor(F.beat) !== Math.floor(s.beatAt(tPrev));
            F.newBar = Math.floor(F.bar) !== Math.floor(s.barAt(tPrev));
            F.hits.k = s.hitIn('k', tPrev, t);
            F.hits.s = s.hitIn('s', tPrev, t);
            F.hits.h = s.hitIn('h', tPrev, t);
            F.events = s.eventsIn(tPrev, t);
        }

        const sec = s.sectionAt(t);
        F.section = sec;
        F.sectionProgress = clamp((t - sec.t0) / Math.max(0.1, sec.t1 - sec.t0), 0, 1);
        F.sectionBar = Math.max(0, Math.floor(F.bar - s.barAt(sec.t0) + 0.02));
        const next = s.sections[sec.idx + 1] || null;
        F.nextSection = next;
        F.nextIn = next ? next.t0 - t : Infinity;

        const drop = s.nextEvent('drop', t, 40);
        F.dropIn = drop ? drop.t - t : Infinity;
        const stop = s.nextEvent('stop', t, 8);
        F.stopIn = stop ? stop.t - t : Infinity;
        F.stopDepth = s.stopDepth(t);
        if (sec.label === 'build') F.buildProgress = F.sectionProgress;
        else if (next && (next.label === 'drop' || next.label === 'chorus') && F.nextIn < s.period * 8) {
            // Last two bars before a lift ramp up even without a detected build.
            F.buildProgress = 0.5 * (1 - F.nextIn / (s.period * 8));
        }
        return F;
    }
}

// ------------------------------------------------------------------- live

function bandState(mult, minLevel, refractory) {
    return { hist: new Float32Array(48), idx: 0, filled: 0, prev: 0, slowAvg: 0, lastOnset: -999, mult, minLevel, refractory };
}

const follow = (env, target, dt, up, down) => env + (target - env) * (1 - Math.exp(-dt / (target > env ? up : down)));

export class LiveSource {
    /** @param {HTMLAudioElement} audioEl  @param {boolean} [analyse] false = silent clock only */
    constructor(audioEl, analyse = true) {
        this.audioEl = audioEl;
        this.graph = analyse ? getAudioGraph(audioEl) : null;
        this.analyser = this.graph ? this.graph.tapAnalyser() : null;
        this.freq = this.analyser ? new Uint8Array(this.analyser.frequencyBinCount) : null;
        this.binHz = this.graph ? this.graph.ctx.sampleRate / 2048 : 21.5;
        this.reset();
    }

    get available() {
        return !!this.analyser;
    }

    reset() {
        this.env = { sub: 0, bass: 0, mid: 0, high: 0, air: 0, rms: 0, harm: 0 };
        this.peak = { sub: 0.3, bass: 0.3, mid: 0.3, high: 0.3, air: 0.3, rms: 0.3, harm: 0.3 };
        this.bands = { kick: bandState(1.4, 0.22, 0.12), snare: bandState(1.45, 0.16, 0.12), hat: bandState(1.5, 0.1, 0.06) };
        this.onsets = [];
        this.interval = 0.5;
        this.anchor = 0;
        this.energyMean = 0.3;
        this.energyDev = 0.08;
        this.norm = 0.45;
        this.normHist = [];
        this.lastLowT = -999;
        this.wasHot = false;
        this.section = { label: 'intro', t0: 0, t1: Infinity, energy: 0.3, idx: 0 };
        this.sectionHoldUntil = 0;
        this.adaptUntil = 0;
        this._prevBeat = 0;
        this._prevBar = 0;
    }

    _bandAvg(lo, hi) {
        const a = Math.max(0, Math.floor(lo / this.binHz));
        const b = Math.min(this.freq.length - 1, Math.ceil(hi / this.binHz));
        if (b <= a) return 0;
        let sum = 0;
        for (let i = a; i <= b; i++) sum += this.freq[i];
        return sum / (b - a + 1) / 255;
    }

    _onset(st, level, now) {
        st.hist[st.idx] = level;
        st.idx = (st.idx + 1) % st.hist.length;
        if (st.filled < st.hist.length) st.filled++;
        let avg = 0;
        for (let i = 0; i < st.filled; i++) avg += st.hist[i];
        avg /= Math.max(1, st.filled);
        st.slowAvg += (level - st.slowAvg) * 0.015;
        const delta = level - st.prev;
        st.prev = level;
        const minLevel = Math.min(st.minLevel, Math.max(0.045, st.slowAvg * 0.9));
        const minDelta = Math.min(0.03, Math.max(0.015, avg * 0.3));
        if (level > avg * st.mult && level > minLevel && delta > minDelta && now - st.lastOnset > st.refractory) {
            st.lastOnset = now;
            return clamp(level / Math.max(avg * st.mult * 1.6, 0.05), 0.35, 1);
        }
        return 0;
    }

    _kickTempo(now) {
        this.onsets.push(now);
        if (this.onsets.length > 20) this.onsets.shift();
        if (this.onsets.length >= 4) {
            const hist = new Map();
            for (let i = this.onsets.length - 1; i > 0; i--) {
                let ioi = this.onsets[i] - this.onsets[i - 1];
                while (ioi < 0.3) ioi *= 2;
                while (ioi > 1.0) ioi /= 2;
                if (ioi < 0.28 || ioi > 1.02) continue;
                const bin = Math.round(ioi / 0.02);
                hist.set(bin, (hist.get(bin) || 0) + i / this.onsets.length);
            }
            let best = -1, bestW = 0;
            for (const [bin, w] of hist) if (w > bestW) { bestW = w; best = bin; }
            if (best > 0) this.interval = lerp(this.interval, best * 0.02, 0.25);
        }
        if (!this.anchor) this.anchor = now;
        const nearest = this.anchor + Math.round((now - this.anchor) / this.interval) * this.interval;
        const err = now - nearest;
        if (Math.abs(err) < this.interval * 0.25) this.anchor += err * 0.6;
        else this.anchor = now;
    }

    /** @param {number} now perf seconds  @param {number} dt  @param {boolean} playing */
    frame(now, dt, playing) {
        const F = baseFrame();
        F.t = now;
        const env = this.env;
        let kHit = 0, sHit = 0, hHit = 0;

        if (this.analyser && playing) {
            this.analyser.getByteFrequencyData(this.freq);
            const raw = {
                sub: this._bandAvg(40, 120),
                bass: this._bandAvg(120, 250),
                mid: this._bandAvg(250, 2000),
                high: this._bandAvg(2000, 6000),
                air: this._bandAvg(6000, 12000),
            };
            raw.rms = raw.sub * 0.35 + raw.bass * 0.25 + raw.mid * 0.3 + raw.high * 0.1;
            raw.harm = raw.mid * 0.7 + raw.bass * 0.3;
            // Auto-gain per band so quiet songs still use the full range.
            for (const k of BAND_KEYS) {
                this.peak[k] = raw[k] > this.peak[k] ? raw[k] : this.peak[k] * Math.exp(-dt / 8);
                const v = clamp((raw[k] - this.peak[k] * 0.25) / Math.max(0.05, this.peak[k] * 0.75), 0, 1);
                env[k] = follow(env[k], v, dt, 0.012, k === 'harm' ? 0.4 : 0.15);
            }
            kHit = this._onset(this.bands.kick, raw.sub, now);
            sHit = this._onset(this.bands.snare, this._bandAvg(1200, 4000), now);
            hHit = this._onset(this.bands.hat, raw.air, now);
            if (kHit) this._kickTempo(now);

            const e = raw.rms;
            const adapting = now < this.adaptUntil;
            const tau = adapting ? 1.2 : 14;
            this.energyMean = follow(this.energyMean, e, dt, tau, tau);
            this.energyDev = follow(this.energyDev, Math.abs(e - this.energyMean), dt, tau, tau * 2);
            const spread = Math.max(this.energyDev * 2.5, 0.08);
            let n = clamp(0.5 + (e - this.energyMean) / (spread * 2), 0, 1);
            if (e < 0.07 && this.energyMean < 0.12) n = Math.min(n, 0.15);
            this.norm = follow(this.norm, n, dt, 0.25, 1.0);
        } else {
            for (const k of BAND_KEYS) env[k] = follow(env[k], 0, dt, 0.05, 0.3);
            this.norm = follow(this.norm, playing ? 0.5 : 0, dt, 0.5, 1.2);
        }

        Object.assign(F.bands, env);
        F.hits.k = kHit;
        F.hits.s = sHit;
        F.hits.h = hHit;

        // Beat grid (simulated 120 BPM clock when there's no analyser).
        if (!this.anchor) this.anchor = now;
        F.period = this.interval;
        F.beat = (now - this.anchor) / this.interval;
        F.bar = F.beat / 4;
        F.beatPhase = F.beat - Math.floor(F.beat);
        F.barPhase = F.bar - Math.floor(F.bar);
        F.beatInBar = Math.floor(F.barPhase * 4) & 3;
        F.newBeat = Math.floor(F.beat) !== Math.floor(this._prevBeat);
        F.newBar = Math.floor(F.bar) !== Math.floor(this._prevBar);
        this._prevBeat = F.beat;
        this._prevBar = F.bar;
        if (!this.analyser && playing && F.newBeat) F.hits.k = 0.6;

        // Section guessing, re-evaluated on bar lines.
        if (F.newBar) {
            this.normHist.push(this.norm);
            if (this.normHist.length > 4) this.normHist.shift();
        }
        if (this.norm < 0.4) this.lastLowT = now;
        if (this.norm >= 0.7) this.wasHot = true;
        if (F.newBar && now >= this.sectionHoldUntil) {
            const n = this.norm;
            const rising = this.normHist.length >= 3 && this.normHist[this.normHist.length - 1] - this.normHist[0] > 0.15;
            let label;
            if (n >= 0.72) label = now - this.lastLowT < this.interval * 8 ? 'drop' : 'chorus';
            else if (n <= 0.3) label = this.wasHot ? 'breakdown' : 'intro';
            else if (rising && n >= 0.45) label = 'build';
            else label = 'verse';
            if (label === 'drop' && this.section.label === 'drop') label = 'chorus';
            if (label !== this.section.label && !(label === 'chorus' && this.section.label === 'drop')) {
                if (label === 'drop') F.events = [{ t: now, type: 'drop' }];
                this.section = { label, t0: now, t1: Infinity, energy: n, idx: this.section.idx + 1 };
                this.sectionHoldUntil = now + this.interval * 8;
            }
        }
        F.section = this.section;
        F.sectionBar = Math.max(0, Math.floor((now - this.section.t0) / (this.interval * 4)));
        F.sectionProgress = this.section.label === 'build' ? clamp(F.sectionBar / 8, 0, 1) : 0;
        F.buildProgress = this.section.label === 'build' ? F.sectionProgress : 0;
        return F;
    }

    onTrackChange(now) {
        this.reset();
        this.adaptUntil = now + 5;
    }
}
