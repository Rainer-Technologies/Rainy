/**
 * Rainy Light Show — audio-reactive concert lighting engine.
 *
 * Pipeline per frame:
 *  1. AudioAnalysis  — 2048-point FFT band envelopes, spectral-flux onset
 *     detection (kick / snare / hat) with adaptive thresholds that lower
 *     their noise floor in quiet passages.
 *  2. Normalization  — slow mean/deviation tracking of the song's energy, so
 *     "loud" and "quiet" are measured relative to each song's own dynamic
 *     range. This lets one threshold set serve a whisper-quiet ballad and a
 *     brickwalled EDM track alike, and lets the show actually calm down when
 *     the music does.
 *  3. BeatGrid       — BPM estimation from kick onset intervals + phase-locked
 *     beat anchor, so every visual event lands exactly on the beat.
 *  4. LightingDesk   — section-aware choreography (intro / verse / build /
 *     drop / breakdown) driving a virtual rig: 6 floor moving-heads, 4 truss
 *     moving-heads, side washes, haze, strobes and a center orb. Every move
 *     is expressed in beats, not frames, and a master dimmer follows the
 *     normalized energy so even mid-section the rig breathes with the music.
 *  5. Renderer       — additive volumetric beams, glow pools, sprites,
 *     impact rings and flash passes.
 *
 * Falls back to a simulated 120 BPM clock when WebAudio is unavailable.
 */
import { Logger } from './helper/logger.js';
import { useLightshowService } from './services/lightshow.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function hexToRgb(hex) {
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);
    return [r, g, b];
}

function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
        t = ((t % 1) + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1)})`;

export class LightShowEngine {
    /**
     * @param {object} opts
     * @param {HTMLCanvasElement} opts.canvas
     * @param {HTMLElement} opts.backdrop   Fullscreen backdrop (scale/opacity synced to bass)
     * @param {HTMLElement} opts.container  Fullscreen container (visibility + layout mode)
     * @param {() => boolean} opts.isPlaying
     */
    constructor({ canvas, backdrop, container, isPlaying, canvas3d }) {
        this.canvas = canvas;
        this.ctx = canvas ? canvas.getContext('2d') : null;
        this.backdrop = backdrop;
        this.container = container;
        this.isPlaying = isPlaying || (() => false);

        this.active = false;
        this._raf = null;
        this._lastTs = 0;

        // --- Renderer style ('original' 2D canvas | 'nebula' Three.js 3D) ---
        // The brain below (analysis, beat grid, choreography, scenes, heads)
        // is renderer-agnostic; only _render() differs per style. The 3D
        // renderer is lazy-loaded so three.js never loads for 2D users.
        this.canvas3d = canvas3d || null;
        this.style = 'original';
        this._r3d = null;
        this._r3dLoading = false;

        // --- Audio graph ---
        this.audioCtx = null;
        this.analyser = null;
        this.freq = null;
        this.binHz = 0;

        // --- Band envelopes (0..1) ---
        this.envKick = 0;
        this.envBass = 0;
        this.envMid = 0;
        this.envHighMid = 0;
        this.envTreble = 0;
        this.energy = 0;       // fast energy
        this.slowEnergy = 0;   // long-term energy (section driver)

        // --- Song-relative energy normalization ---
        // Sections are classified from how the current energy compares to the
        // song's own recent history, not from absolute FFT levels — that way
        // quiet genres still reach full power and loud genres still calm down.
        this.normEnergy = 0.45;  // 0..1, 0.5 = typical level for the current song
        this.energyMean = 0.3;   // slow running mean of absolute energy
        this.energyDev = 0.08;   // slow running mean |energy - mean|
        this._adaptUntil = 0;    // fast-adaptation window after track changes

        // --- Onset detection state ---
        this._bands = {
            kick:  this._makeBandState(1.40, 0.22, 0.120),
            snare: this._makeBandState(1.45, 0.16, 0.120),
            hat:   this._makeBandState(1.50, 0.10, 0.060),
        };

        // --- Beat grid ---
        this.onsets = [];           // recent kick onset timestamps (s)
        this.beatInterval = 0.5;    // seconds per beat (default 120 BPM)
        this.anchor = 0;            // timestamp of beat 0
        this.beatFloat = 0;
        this.beatIndex = -1;
        this.eighthIndex = -1;

        // --- Choreography ---
        this.section = 'intro';
        this.sectionUntil = 0;   // earliest time (s) the section may change again
        this.wasHot = false;
        this.lastHotTime = -999;
        this.sectionCount = 0;
        this.verseFlip = 0;

        // --- Choreographed (pregenerated) show ---
        // When a score exists for the current song it drives the show and the
        // live guessing pipeline steps aside; otherwise live mode runs.
        this.script = null;
        this.scriptSongId = 0;
        this._scriptLoading = false;
        this._scriptPtr = { beat: 0, kick: 0, snare: 0, hat: 0, section: 0, lastT: -1 };

        // --- Color scenes ---
        this.accentHue = 350;
        this.sceneCur = null;
        this.scenePrev = null;
        this.sceneMix = 1;
        this.sceneBarLen = 4; // seconds per scene crossfade (recomputed from interval)

        // --- Virtual fixture rig ---
        this.floorHeads = [];
        this.topHeads = [];
        for (let i = 0; i < 6; i++) this.floorHeads.push(this._makeHead('floor', i, 6));
        for (let i = 0; i < 4; i++) this.topHeads.push(this._makeHead('top', i, 4));

        // --- FX pools ---
        this.haze = [];
        for (let i = 0; i < 56; i++) {
            this.haze.push({
                x: Math.random(), y: Math.random(),
                vx: (Math.random() - 0.5) * 0.008,
                vy: -0.004 - Math.random() * 0.010,
                size: 1 + Math.random() * 2.2,
                seed: Math.random() * TAU,
            });
        }
        this.rings = [];
        this.flash = 0;
        this.lastFlashTime = -999;

        // --- Caches ---
        this._sprites = new Map();
        this._vignette = null;
        this._vignetteKey = '';
        this._prefs = { disableLasers: false, showBgBlur: false };
        this._prefsAt = 0;
    }

    // ------------------------------------------------------------------ API

    start(audioEl) {
        if (!this.canvas || !this.ctx) return;
        this.active = true;
        this._initAudio(audioEl);
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }
        // Adapt quickly to whatever is playing right now (same clock as the rAF loop)
        this._adaptUntil = performance.now() / 1000 + 5;
        this._readAccent();
        this._ensureScenes();
        // Apply the saved renderer style before the first frame paints
        this._getPrefs(true);
        if (this._prefs.style) this.setStyle(this._prefs.style);
        this._resize();
        this._lastTs = 0;
        this._startLoop();
    }

    stop() {
        this.active = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        if (this.canvas) this.canvas.style.filter = 'none';
    }

    /** Called when the fullscreen player re-opens while the show is active. */
    resume() {
        if (!this.active) return;
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }
        this._startLoop();
    }

    /**
     * Switch renderers. 'original' = 2D canvas, 'nebula' = Three.js 3D.
     * During the (lazy) 3D load the 2D renderer keeps painting, then the
     * canvases crossfade via their CSS opacity transitions.
     */
    setStyle(style) {
        style = style === 'nebula' ? 'nebula' : 'original';
        if (style === this.style) return;
        this.style = style;
        if (style === 'nebula') {
            if (this._r3d) {
                if (this.canvas3d) this.canvas3d.classList.remove('hidden');
                if (this.canvas) this.canvas.classList.add('hidden');
            } else {
                this._ensure3d();
            }
        } else {
            if (this.canvas3d) this.canvas3d.classList.add('hidden');
            if (this.canvas) this.canvas.classList.remove('hidden');
        }
    }

    async _ensure3d() {
        if (this._r3d || this._r3dLoading) return;
        if (!this.canvas3d) { this.style = 'original'; return; }
        this._r3dLoading = true;
        try {
            const mod = await import('./lightshow3d.js');
            this._r3d = mod.createRenderer(this.canvas3d);
            if (this.style === 'nebula') {
                this.canvas3d.classList.remove('hidden');
                if (this.canvas) this.canvas.classList.add('hidden');
            }
            Logger.log('LightShow: Nebula 3D renderer ready.');
        } catch (e) {
            Logger.error('LightShow: failed to load 3D renderer, staying on Original.', e);
            this._r3d = null;
            this.style = 'original';
            if (this.canvas) this.canvas.classList.remove('hidden');
        } finally {
            this._r3dLoading = false;
        }
    }

    /**
     * Load the pregenerated score for a song (if any). When found, the engine
     * switches to scripted playback; otherwise it keeps live-guessing.
     * @param {number} songId
     * @param {boolean} [force] Refetch even if this song is already loaded
     */
    async loadScript(songId, force = false) {
        if (!songId) return;
        if (!force && this.scriptSongId === songId && (this.script || this._scriptLoading)) return;
        this.scriptSongId = songId;
        this._scriptLoading = true;
        try {
            const data = await useLightshowService().get(songId);
            if (this.scriptSongId !== songId) return; // song changed while fetching
            if (data.error || !data.value || !data.value.lightshow) {
                this.script = null;
                return;
            }
            this._setScript(data.value.lightshow);
        } catch (e) {
            if (this.scriptSongId === songId) this.script = null;
            Logger.error('LightShow: failed to load choreographed show.', e);
        } finally {
            if (this.scriptSongId === songId) this._scriptLoading = false;
        }
    }

    /** Drop the loaded score (e.g. after the user removed it server-side). */
    clearScript(songId = 0) {
        if (songId && this.scriptSongId !== songId) return;
        this.script = null;
        this.scriptSongId = 0;
    }

    _setScript(data) {
        if (!data || !Array.isArray(data.beats) || data.beats.length < 2 ||
            !Array.isArray(data.sections) || !data.sections.length) {
            this.script = null;
            return;
        }
        this.script = data;
        this._scriptPtr = { beat: 0, kick: 0, snare: 0, hat: 0, section: 0, lastT: -1 };
        this.beatInterval = 60 / (data.bpm || 120);
        this._syncScriptPointers(this._audioEl ? this._audioEl.currentTime : 0);
        Logger.log(`LightShow: choreographed show loaded (${Math.round(data.bpm)} BPM, ${data.sections.length} sections).`);
    }

    /** A score only activates when it plausibly matches the loaded track. */
    _scriptActive() {
        if (!this.script || !this._audioEl) return false;
        const d = this._audioEl.duration;
        if (d && this.script.duration && Math.abs(d - this.script.duration) > 2) return false;
        return true;
    }

    // --------------------------------------------------------------- Audio

    _initAudio(audioEl) {
        if (this._audioEl !== audioEl) {
            this._audioEl = audioEl;
            // A new src on the element means a new track: re-learn tempo and
            // dynamics quickly instead of dragging the previous song's state.
            audioEl.addEventListener('loadstart', () => this._onTrackChange());
        }
        if (this.audioCtx) return;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new AC();
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0.4; // low smoothing keeps transients sharp
            this.freq = new Uint8Array(this.analyser.frequencyBinCount);
            this.binHz = this.audioCtx.sampleRate / this.analyser.fftSize;
            const source = this.audioCtx.createMediaElementSource(audioEl);
            source.connect(this.analyser);
            this.analyser.connect(this.audioCtx.destination);
            Logger.log('LightShow: audio graph initialized.');
        } catch (e) {
            Logger.error('LightShow: WebAudio unavailable, using simulated beat clock.', e);
            this.analyser = null;
            this.audioCtx = null;
        }
    }

    /** Reset adaptive state so a new song re-learns its tempo and dynamics fast. */
    _onTrackChange() {
        this._adaptUntil = (this._now || 0) + 5; // fast normalization window
        this.onsets.length = 0;
        this.anchor = 0;
        for (const key of Object.keys(this._bands)) {
            const b = this._bands[key];
            b.filled = 0;
            b.idx = 0;
            b.prev = 0;
            b.lastOnset = -999;
            b.slowAvg = 0;
        }
        this.wasHot = false;
        this.lastHotTime = -999;
        this.section = 'intro';
        this.sectionUntil = 0;
        this.flash = 0; // stale flash must not carry into the next track
        this._onSectionChange(); // settle the rig into calm targets between songs
    }

    _makeBandState(mult, minLevel, refractory) {
        return {
            hist: new Float32Array(48),
            idx: 0,
            filled: 0,
            prev: 0,
            slowAvg: 0,   // long-term band level, lowers the noise floor in quiet passages
            lastOnset: -999,
            mult, minLevel, refractory,
        };
    }

    _makeHead(side, i, count) {
        return {
            side, i, count,
            baseX: (i + 0.75) / (count + 0.5), // fraction of screen width
            angle: 0,
            from: 0,
            to: 0,
            moveT0: -999,   // in beats
            moveDur: 1,     // in beats
            ease: easeInOutSine,
            env: 0,         // current intensity
            target: 0,      // target intensity
            boost: 0,       // momentary flash boost (decays)
        };
    }

    _bandAvg(loHz, hiHz) {
        const lo = Math.max(0, Math.floor(loHz / this.binHz));
        const hi = Math.min(this.freq.length - 1, Math.ceil(hiHz / this.binHz));
        if (hi <= lo) return 0;
        let sum = 0;
        for (let i = lo; i <= hi; i++) sum += this.freq[i];
        return sum / (hi - lo + 1) / 255;
    }

    /** Adaptive-threshold onset detector for one band. */
    _detectOnset(state, level, now) {
        state.hist[state.idx] = level;
        state.idx = (state.idx + 1) % state.hist.length;
        if (state.filled < state.hist.length) state.filled++;

        let avg = 0;
        for (let i = 0; i < state.filled; i++) avg += state.hist[i];
        avg /= Math.max(1, state.filled);

        // Long-term band level (~1s): lets the noise floor follow quiet
        // passages so soft kicks/snares still register onsets there.
        state.slowAvg += (level - state.slowAvg) * 0.015;

        const delta = level - state.prev;
        state.prev = level;

        // Floors only ever drop below the configured values, never rise above
        // them — loud-material behavior is unchanged.
        const minLevel = Math.min(state.minLevel, Math.max(0.045, state.slowAvg * 0.9));
        const minDelta = Math.min(0.03, Math.max(0.015, avg * 0.3));

        const hit = level > avg * state.mult &&
                    level > minLevel &&
                    delta > minDelta &&
                    (now - state.lastOnset) > state.refractory;
        if (hit) state.lastOnset = now;
        return hit;
    }

    _follow(env, target, dt, tauUp, tauDown) {
        const tau = target > env ? tauUp : tauDown;
        return env + (target - env) * (1 - Math.exp(-dt / tau));
    }

    _analyse(now, dt) {
        const playing = this.isPlaying();

        if (this.analyser && playing) {
            this.analyser.getByteFrequencyData(this.freq);

            const kick = this._bandAvg(40, 130);
            const bass = this._bandAvg(30, 250);
            const mid = this._bandAvg(250, 2000);
            const highMid = this._bandAvg(1200, 4000);
            const treble = this._bandAvg(5000, 12000);

            // Punchy envelopes: instant attack, musical release
            this.envKick = this._follow(this.envKick, kick, dt, 0.012, 0.14);
            this.envBass = this._follow(this.envBass, bass, dt, 0.015, 0.20);
            this.envMid = this._follow(this.envMid, mid, dt, 0.020, 0.25);
            this.envHighMid = this._follow(this.envHighMid, highMid, dt, 0.015, 0.16);
            this.envTreble = this._follow(this.envTreble, treble, dt, 0.012, 0.12);

            // Onsets (skipped in scripted mode: the score fires exact ones)
            if (!this._scriptActive()) {
                if (this._detectOnset(this._bands.kick, kick, now)) this._onKick(now);
                if (this._detectOnset(this._bands.snare, highMid, now)) this._onSnare(now);
                if (this._detectOnset(this._bands.hat, treble, now)) this._onHat(now);
            }
        } else {
            // Decay everything when paused or in simulated mode
            this.envKick = this._follow(this.envKick, 0, dt, 0.05, 0.2);
            this.envBass = this._follow(this.envBass, 0, dt, 0.05, 0.3);
            this.envMid = this._follow(this.envMid, 0, dt, 0.05, 0.3);
            this.envHighMid = this._follow(this.envHighMid, 0, dt, 0.05, 0.2);
            this.envTreble = this._follow(this.envTreble, 0, dt, 0.05, 0.2);
        }

        // Energy levels drive the section state machine
        const e = this.envBass * 0.5 + this.envMid * 0.35 + this.envTreble * 0.15;
        this.energy = this._follow(this.energy, e, dt, 0.05, 0.2);
        this.slowEnergy = this._follow(this.slowEnergy, e, dt, 0.4, 1.6);

        // Song-relative normalization: track the song's own typical level and
        // dynamic range, then express the current energy within that range.
        // normEnergy ~0.5 = typical, ~1 = this song's loudest, ~0 = its quietest.
        if (this.analyser && playing) {
            const adapting = now < this._adaptUntil;
            const mTau = adapting ? 1.2 : 14; // snap fast after track changes, then stable
            this.energyMean = this._follow(this.energyMean, e, dt, mTau, mTau);
            const dev = Math.abs(e - this.energyMean);
            this.energyDev = this._follow(this.energyDev, dev, dt, mTau, mTau * 2);
            // Floor on the spread avoids hypersensitivity in low-dynamics material
            const spread = Math.max(this.energyDev * 2.5, 0.08);
            let norm = clamp(0.5 + (e - this.energyMean) / (spread * 2), 0, 1);
            // True silence stays calm no matter what the history says
            if (e < 0.07 && this.energyMean < 0.12) norm = Math.min(norm, 0.15);
            this.normEnergy = this._follow(this.normEnergy, norm, dt, 0.25, 1.0);
        } else if (playing) {
            // Simulated beat clock (no WebAudio): hold a steady mid-level show
            this.normEnergy = this._follow(this.normEnergy, 0.5, dt, 0.5, 0.5);
        } else {
            this.normEnergy = this._follow(this.normEnergy, 0, dt, 0.4, 1.2);
        }

        // "Heat" memory: was the song recently at full power relative to itself?
        // Distinguishes a mid-set breakdown from a song that simply started quietly.
        if (this.normEnergy >= 0.7) {
            this.lastHotTime = now;
            this.wasHot = true;
        } else if (this.wasHot && now - this.lastHotTime > 20) {
            this.wasHot = false;
        }
    }

    // ------------------------------------------------------------ Beat grid

    _tempoOnset(now) {
        this.onsets.push(now);
        if (this.onsets.length > 20) this.onsets.shift();

        if (this.onsets.length >= 4) {
            // Interval histogram with octave folding into [0.3s, 1.0s] (60–200 BPM)
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
            for (const [bin, w] of hist) {
                if (w > bestW) { bestW = w; best = bin; }
            }
            if (best > 0) {
                const iv = best * 0.02;
                this.beatInterval = lerp(this.beatInterval, iv, 0.25);
            }
        }

        // Phase lock: pull the grid anchor toward the kick
        if (!this.anchor) this.anchor = now;
        const nearest = this.anchor + Math.round((now - this.anchor) / this.beatInterval) * this.beatInterval;
        const err = now - nearest;
        if (Math.abs(err) < this.beatInterval * 0.25) {
            this.anchor += err * 0.6;
        } else {
            this.anchor = now; // way off-grid: hard re-sync
        }
    }

    _updateBeatGrid(now, dt) {
        // Scripted mode: the score is the beat grid. Frozen while paused.
        if (this.script) {
            if (this._scriptActive() && this.isPlaying()) this._updateScriptGrid(now, dt);
            return;
        }

        this.beatFloat = Math.max(0, (now - this.anchor) / this.beatInterval);

        const bi = Math.floor(this.beatFloat);
        if (bi !== this.beatIndex) {
            this.beatIndex = bi;
            this._onBeat(bi, now);
        }
        const ei = Math.floor(this.beatFloat * 2);
        if (ei !== this.eighthIndex) {
            this.eighthIndex = ei;
            this._onEighth(ei);
        }
        // Scene crossfade runs over one bar
        if (this.sceneMix < 1) {
            this.sceneMix = Math.min(1, this.sceneMix + dt / (this.beatInterval * 4));
        }
    }

    // ------------------------------------------------------- Scripted mode

    /** Drive the grid, onsets, sections and dimmer from the pregenerated score. */
    _updateScriptGrid(now, dt) {
        const t = this._audioEl.currentTime;
        const ptr = this._scriptPtr;

        // Re-sync event pointers after seeks / stalls
        if (ptr.lastT < 0 || t < ptr.lastT - 0.25 || t - ptr.lastT > 1.5) {
            this._syncScriptPointers(t);
        }
        ptr.lastT = t;

        // Section + energy first, so cues fire under the right section
        this._applyScriptState(t, now);

        // Beat phase from the surrounding score beats
        const beats = this.script.beats;
        let bi = ptr.beat;
        if (bi >= beats.length - 1) bi = beats.length - 2;
        while (bi + 1 < beats.length && beats[bi + 1] <= t) bi++;
        while (bi > 0 && beats[bi] > t) bi--;
        ptr.beat = bi;

        const t0 = beats[bi];
        const t1 = beats[Math.min(bi + 1, beats.length - 1)];
        const span = Math.max(0.05, t1 - t0);
        this.beatInterval = span;
        this.beatFloat = bi + clamp((t - t0) / span, 0, 1);
        this.anchor = t0;

        if (bi !== this.beatIndex) {
            this.beatIndex = bi;
            this._onBeat(bi, now);
        }
        const ei = Math.floor(this.beatFloat * 2);
        if (ei !== this.eighthIndex) {
            this.eighthIndex = ei;
            this._onEighth(ei);
        }

        this._fireScriptOnsets(t, now);

        if (this.sceneMix < 1) {
            this.sceneMix = Math.min(1, this.sceneMix + dt / (span * 4));
        }
    }

    _applyScriptState(t, now) {
        this._now = now;
        this.normEnergy = this._scriptNormAt(t);
        const sec = this._scriptSectionAt(t);
        if (sec && sec !== this.section) {
            this.section = sec;
            this.sectionCount++;
            this._onSectionChange();
        }
        if (this.normEnergy >= 0.7) {
            this.lastHotTime = now;
            this.wasHot = true;
        }
    }

    _scriptSectionAt(t) {
        const secs = this.script.sections;
        let i = this._scriptPtr.section;
        if (i >= secs.length) i = secs.length - 1;
        while (i + 1 < secs.length && secs[i + 1].t0 <= t) i++;
        while (i > 0 && secs[i].t0 > t) i--;
        this._scriptPtr.section = i;
        return secs[i].y;
    }

    _scriptNormAt(t) {
        const n = this.script.norm;
        const dt = this.script.normDt || 0.2;
        if (!n || !n.length) return 0.5;
        const x = clamp(t / dt, 0, n.length - 1);
        const i = Math.floor(x);
        const a = n[i] / 255;
        const b = n[Math.min(i + 1, n.length - 1)] / 255;
        return a + (b - a) * (x - i);
    }

    /** Fire onset FX for every score onset whose time has just passed. */
    _fireScriptOnsets(t, now) {
        const o = this.script.onsets || {};
        const ptr = this._scriptPtr;
        const run = (times, key, fx) => {
            if (!times || !times.length) return;
            let i = ptr[key];
            while (i < times.length && times[i] <= t) { fx.call(this, now); i++; }
            ptr[key] = i;
        };
        run(o.k, 'kick', this._kickFx);
        run(o.s, 'snare', this._snareFx);
        run(o.h, 'hat', this._hatFx);
    }

    /** Move onset pointers to the first event at or after time t. */
    _syncScriptPointers(t) {
        const o = (this.script && this.script.onsets) || {};
        const lowerBound = (arr) => {
            if (!arr) return 0;
            let lo = 0, hi = arr.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (arr[mid] <= t) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };
        this._scriptPtr.kick = lowerBound(o.k);
        this._scriptPtr.snare = lowerBound(o.s);
        this._scriptPtr.hat = lowerBound(o.h);
    }

    // -------------------------------------------------------------- Onsets

    _onKick(now) {
        this._tempoOnset(now);
        this._kickFx(now);
    }

    _kickFx(now) {
        if (this.section === 'drop') {
            this._flash(0.20, now);
            this._ring(0.55, this._col(0));
            this._boostAll(0.55);
        } else if (this.section === 'build') {
            this._boostAll(0.22);
        }
    }

    _onSnare(now) {
        this._snareFx(now);
    }

    _snareFx(now) {
        if (this.section === 'drop') {
            this._flash(0.30, now);
        } else if (this.section === 'build') {
            // Snare chase step across the rig
            const heads = this._allHeads();
            const h = heads[Math.floor(Math.random() * heads.length)];
            h.boost = Math.max(h.boost, 0.8);
        }
    }

    _onHat(now) {
        this._hatFx(now);
    }

    _hatFx(now) {
        if (this.section === 'drop' || this.section === 'build') {
            // Sparkle: a few haze particles flare up
            for (let k = 0; k < 3; k++) {
                const p = this.haze[Math.floor(Math.random() * this.haze.length)];
                if (p) p.flare = 1;
            }
        }
    }

    _flash(v, now, force = false) {
        if (!force && now - this.lastFlashTime < 0.18) return; // photosensitivity cap
        this.lastFlashTime = now;
        if (this._prefs.disableLasers) v *= 0.4;
        this.flash = Math.max(this.flash, v);
    }

    _ring(alpha, color) {
        this.rings.push({
            r: 20, alpha, color,
            speed: 0.55 + this.energy * 0.5, // fraction of screen per second
        });
        if (this.rings.length > 8) this.rings.shift();
    }

    _boostAll(v) {
        for (const h of this._allHeads()) h.boost = Math.max(h.boost, v);
    }

    _allHeads() {
        return this.floorHeads.concat(this.topHeads);
    }

    // -------------------------------------------------------- Choreography

    _evaluateSection() {
        const now = this._now || 0;
        if (now < this.sectionUntil) return; // hold: keep sections musical, avoid flapping

        const n = this.normEnergy;
        const e = this.slowEnergy;
        const rising = this.energy - this.slowEnergy > 0.05; // short-term energy surging
        const recentHeat = this.wasHot && (now - this.lastHotTime) < 10;
        let target;
        if (n < 0.20) target = recentHeat ? 'breakdown' : 'intro';
        else if (n < 0.42) target = recentHeat ? 'breakdown' : 'verse';
        else if (n < 0.62 || e < 0.14) target = rising ? 'build' : (this.section === 'drop' ? 'drop' : 'verse');
        else target = 'drop';

        if (target !== this.section) {
            this.section = target;
            this.sectionCount++;
            this.sectionUntil = now + 4; // minimum section hold (seconds)
            this._onSectionChange();
        }
    }

    _onSectionChange() {
        this._rotateScene();
        const heads = this._allHeads();
        if (this.section === 'drop') {
            this._flash(0.5, this._now, true); // big entrance flash
            this._ring(0.7, [255, 255, 255]);
            for (const h of heads) { h.target = 1; }
            this._cueDrop(this.beatIndex);
        } else if (this.section === 'breakdown' || this.section === 'intro') {
            for (const h of heads) { h.target = h.side === 'floor' ? 0.15 : 0.06; }
        } else {
            for (const h of heads) { h.target = 0.5; }
        }
    }

    _onBeat(bi, now) {
        this._now = now;
        // Simulated rhythm when WebAudio is unavailable or paused: drive from grid
        if ((!this.analyser || !this.isPlaying()) && !this.script) {
            if (this.isPlaying() && !this.analyser) {
                if (bi % 2 === 0) this._onKick(now);
                else this._onSnare(now);
                this.envKick = Math.max(this.envKick, bi % 2 === 0 ? 0.7 : 0);
                this.envBass = Math.max(this.envBass, 0.4);
                this.envMid = Math.max(this.envMid, 0.35);
            }
        }

        if (bi % 4 === 0 && !this._scriptActive()) this._evaluateSection();
        if (bi % 32 === 16) this._rotateScene();

        switch (this.section) {
            case 'intro':
            case 'breakdown':
                if (bi % 4 === 0) this._cueCalm(bi);
                break;
            case 'verse':
                if (bi % 2 === 0) this._cueVerse(bi);
                break;
            case 'build':
                if (bi % 2 === 0) this._cueBuild(bi);
                break;
            case 'drop':
                this._cueDrop(bi);
                break;
        }
    }

    _onEighth(ei) {
        if (this.section === 'build' || this.section === 'drop') {
            // Fast chase stepping across the whole rig on eighth notes
            const heads = this._allHeads();
            heads[ei % heads.length].boost = Math.max(heads[ei % heads.length].boost, 0.9);
        } else if (this.section === 'verse' && ei % 2 === 1) {
            // Off-beat: gentle alternating side pulse
            const heads = ei % 4 === 1 ? this.floorHeads.slice(0, 3) : this.floorHeads.slice(3);
            for (const h of heads) h.boost = Math.max(h.boost, 0.35);
        }
    }

    /** Assign a beat-quantized move to a head. */
    _moveHead(h, angle, durBeats, ease = easeInOutSine) {
        h.from = h.angle;
        h.to = clamp(angle, -1.25, 1.25);
        h.moveT0 = this.beatFloat;
        h.moveDur = Math.max(0.25, durBeats);
        h.ease = ease;
    }

    /** Slow emotional sweeps for intro / breakdown — three rotating patterns. */
    _cueCalm(bi) {
        const pattern = Math.floor(bi / 4) % 3;
        if (pattern === 0) {
            // Lone sweeper: one head wanders slowly, the rest almost dark
            const turn = Math.floor(bi / 4) % 3;
            this.floorHeads.forEach((h, i) => {
                const active = this.section === 'intro' ? (i % 3 === turn) : (i === turn + 1);
                h.target = active ? 0.18 + this.normEnergy * 0.2 : 0.05;
                if (active) this._moveHead(h, (Math.random() - 0.5) * 1.0, 8);
            });
            this.topHeads.forEach((h, i) => {
                h.target = i === turn ? 0.12 : 0.04;
                if (i === turn) this._moveHead(h, (Math.random() - 0.5) * 0.8, 8);
            });
        } else if (pattern === 1) {
            // Mirrored breath: the floor fans out and breathes together
            const spread = 0.5 + Math.random() * 0.4;
            this.floorHeads.forEach((h, i) => {
                const side = i < 3 ? 1 : -1;
                const rank = i < 3 ? 2 - i : i - 3;
                this._moveHead(h, side * spread * (0.3 + rank * 0.25), 8);
                h.target = 0.10 + this.normEnergy * 0.12;
            });
            this.topHeads.forEach((h) => { h.target = 0.05; });
        } else {
            // Center rest: beams park near the middle and sway gently
            this.floorHeads.forEach((h, i) => {
                this._moveHead(h, (i - 2.5) * 0.12, 8);
                h.target = (i === 2 || i === 3) ? 0.16 + this.normEnergy * 0.15 : 0.05;
            });
            this.topHeads.forEach((h, i) => {
                this._moveHead(h, (i - 1.5) * 0.2, 8);
                h.target = 0.06;
            });
        }
    }

    /** Mirrored fans, crosses and diagonal waves alternating every 2 beats. */
    _cueVerse(bi) {
        this.verseFlip = (this.verseFlip + 1) % 3;
        const spread = 0.4 + this.normEnergy * 0.5 + Math.random() * 0.15;
        if (this.verseFlip < 2) {
            const cross = this.verseFlip === 0;
            this.floorHeads.forEach((h, i) => {
                const side = i < 3 ? 1 : -1;
                const rank = i < 3 ? 2 - i : i - 3; // distance from center
                const a = cross ? side * spread * (0.35 + rank * 0.3)
                                : -side * spread * (0.35 + rank * 0.3);
                this._moveHead(h, a, 2);
                h.target = 0.45 + this.normEnergy * 0.25;
            });
            this.topHeads.forEach((h, i) => {
                const side = i < 2 ? 1 : -1;
                this._moveHead(h, (cross ? -side : side) * spread * 0.6, 2);
                h.target = 0.3 + this.normEnergy * 0.2;
            });
        } else {
            // Diagonal wave: angles sweep across the whole rig
            this.floorHeads.forEach((h, i) => {
                this._moveHead(h, -((i / 5) - 0.5) * 2 * spread, 2);
                h.target = 0.4 + this.normEnergy * 0.25;
            });
            this.topHeads.forEach((h, i) => {
                this._moveHead(h, ((i / 3) - 0.5) * spread, 2);
                h.target = 0.28 + this.normEnergy * 0.2;
            });
        }
    }

    /** Accelerating moves as energy rises toward the drop. */
    _cueBuild(bi) {
        const prog = clamp((this.normEnergy - 0.42) / 0.20, 0, 1);
        const dur = Math.max(0.5, 2 - prog * 1.5);
        const spread = 0.5 + prog * 0.6;
        this.floorHeads.forEach((h, i) => {
            const side = i % 2 === 0 ? 1 : -1;
            this._moveHead(h, side * spread * (0.3 + Math.random() * 0.7), dur, easeOutCubic);
            h.target = 0.55 + prog * 0.35;
        });
        this.topHeads.forEach((h, i) => {
            const side = i % 2 === 0 ? -1 : 1;
            this._moveHead(h, side * spread * 0.7, dur, easeOutCubic);
            h.target = 0.4 + prog * 0.4;
        });
    }

    /** Full-power snap patterns, one per beat, cycling every 8 beats. */
    _cueDrop(bi) {
        const step = ((bi % 8) + 8) % 8;
        const snap = easeOutCubic;
        if (step === 0 || step === 4) {
            // Wide fan
            this.floorHeads.forEach((h, i) => {
                const a = ((i / 5) - 0.5) * 2.2;
                this._moveHead(h, a, 1, snap);
                h.target = 1;
            });
        } else if (step === 2 || step === 6) {
            // Cross at center
            this.floorHeads.forEach((h, i) => {
                const side = i < 3 ? 1 : -1;
                this._moveHead(h, side * (0.5 + Math.random() * 0.35), 1, snap);
                h.target = 1;
            });
        } else {
            // Scatter / alternate sides
            this.floorHeads.forEach((h, i) => {
                const side = (i + step) % 2 === 0 ? 1 : -1;
                this._moveHead(h, side * (0.2 + Math.random() * 0.9), 0.5, snap);
                h.target = 0.9;
            });
        }
        this.topHeads.forEach((h, i) => {
            const side = (i + bi) % 2 === 0 ? 1 : -1;
            this._moveHead(h, side * (0.3 + Math.random() * 0.8), 1, snap);
            h.target = 0.85;
        });
    }

    // ------------------------------------------------------------- Colors

    _readAccent() {
        let hex = '#fa586a';
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) hex = v;
        } catch (e) { /* keep fallback */ }
        const [r, g, b] = hexToRgb(hex);
        this.accentHue = rgbToHsl(r, g, b)[0];
    }

    _buildScenes() {
        const h = this.accentHue;
        const W = [255, 255, 255];
        return [
            [hslToRgb(h, 0.9, 0.55), hslToRgb(h + 150, 0.85, 0.55), hslToRgb(h + 30, 0.95, 0.6), W],
            [hslToRgb(h + 180, 0.85, 0.55), hslToRgb(h + 45, 0.9, 0.55), hslToRgb(h - 60, 0.85, 0.55), W],
            [hslToRgb(h - 30, 0.95, 0.55), hslToRgb(h + 120, 0.8, 0.5), hslToRgb(h + 210, 0.85, 0.6), W],
        ];
    }

    _ensureScenes() {
        if (!this.sceneCur) {
            const scenes = this._buildScenes();
            this.sceneCur = scenes[0];
            this.scenePrev = scenes[0];
            this.sceneMix = 1;
            this._sceneIdx = 0;
        }
    }

    _rotateScene() {
        const scenes = this._buildScenes();
        this._sceneIdx = (this._sceneIdx + 1) % scenes.length;
        this.scenePrev = this.sceneCur;
        this.sceneCur = scenes[this._sceneIdx];
        this.sceneMix = 0;
    }

    /** Scene color by slot (0 primary, 1 secondary, 2 tertiary, 3 white), crossfaded. */
    _col(slot) {
        const a = this.scenePrev[slot], b = this.sceneCur[slot], t = this.sceneMix;
        return [lerp(a[0], b[0], t) | 0, lerp(a[1], b[1], t) | 0, lerp(a[2], b[2], t) | 0];
    }

    _headColor(h) {
        return this._col((h.i + (h.side === 'top' ? 1 : 0)) % 3);
    }

    // ------------------------------------------------------------ Rendering

    _getPrefs(force = false) {
        if (!force && this._now - this._prefsAt < 0.5) return this._prefs;
        this._prefsAt = this._now || 0;
        let prefs = {};
        try {
            if (window.app && window.app.user && window.app.user.preferences) {
                let p = window.app.user.preferences;
                if (typeof p === 'string') p = JSON.parse(p);
                prefs = p || {};
            }
        } catch (e) { /* ignore */ }
        this._prefs = {
            disableLasers: !!prefs.disable_lasers,
            showBgBlur: !!prefs.show_bg_blur,
            style: prefs.lightshow_style === 'nebula' ? 'nebula' : 'original',
        };
        return this._prefs;
    }

    _resize() {
        if (!this.canvas) return;
        const w = window.innerWidth, h = window.innerHeight;
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            this._vignette = null;
        }
    }

    _sprite(color) {
        const key = `${color[0] >> 4},${color[1] >> 4},${color[2] >> 4}`;
        let s = this._sprites.get(key);
        if (s) return s;
        s = document.createElement('canvas');
        s.width = s.height = 96;
        const c = s.getContext('2d');
        const g = c.createRadialGradient(48, 48, 0, 48, 48, 48);
        g.addColorStop(0, 'rgba(255,255,255,0.9)');
        g.addColorStop(0.18, rgba(color, 0.8));
        g.addColorStop(0.5, rgba(color, 0.22));
        g.addColorStop(1, rgba(color, 0));
        c.fillStyle = g;
        c.fillRect(0, 0, 96, 96);
        this._sprites.set(key, s);
        return s;
    }

    /** Ray/rect intersection: beam length until it leaves the screen. */
    _beamLen(x, y, dx, dy, w, h) {
        let t = Infinity;
        if (dx > 0) t = Math.min(t, (w - x) / dx);
        else if (dx < 0) t = Math.min(t, -x / dx);
        if (dy > 0) t = Math.min(t, (h - y) / dy);
        else if (dy < 0) t = Math.min(t, -y / dy);
        return Math.max(0, t);
    }

    _drawBeam(ctx, x, y, dx, dy, len, w0, spread, color, intensity) {
        const ex = x + dx * len, ey = y + dy * len;
        const px = -dy, py = dx;
        const w1 = w0 + len * spread;

        // Outer glow cone
        ctx.beginPath();
        ctx.moveTo(x + px * w0 / 2, y + py * w0 / 2);
        ctx.lineTo(ex + px * w1 / 2, ey + py * w1 / 2);
        ctx.lineTo(ex - px * w1 / 2, ey - py * w1 / 2);
        ctx.lineTo(x - px * w0 / 2, y - py * w0 / 2);
        ctx.closePath();
        const g = ctx.createLinearGradient(x, y, ex, ey);
        g.addColorStop(0, rgba(color, 0.55 * intensity));
        g.addColorStop(0.35, rgba(color, 0.25 * intensity));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fill();

        // Hot core
        if (intensity > 0.35) {
            const cw0 = w0 * 0.2, cw1 = Math.max(2, w1 * 0.18);
            const ci = (intensity - 0.35) / 0.65;
            ctx.beginPath();
            ctx.moveTo(x + px * cw0 / 2, y + py * cw0 / 2);
            ctx.lineTo(ex + px * cw1 / 2, ey + py * cw1 / 2);
            ctx.lineTo(ex - px * cw1 / 2, ey - py * cw1 / 2);
            ctx.lineTo(x - px * cw0 / 2, y - py * cw0 / 2);
            ctx.closePath();
            const cg = ctx.createLinearGradient(x, y, ex, ey);
            cg.addColorStop(0, `rgba(255,255,255,${0.55 * ci})`);
            cg.addColorStop(0.25, rgba(color, 0.3 * ci));
            cg.addColorStop(1, rgba(color, 0));
            ctx.fillStyle = cg;
            ctx.fill();
        }
        return { ex, ey };
    }

    _updateHeads(dt) {
        // Master dimmer: the whole rig breathes with the song-relative energy,
        // so a quiet passage dims even if the section label hasn't changed yet.
        const dim = 0.35 + this.normEnergy * 0.65;
        for (const h of this._allHeads()) {
            const t = clamp((this.beatFloat - h.moveT0) / h.moveDur, 0, 1);
            h.angle = lerp(h.from, h.to, h.ease(t));
            const target = h.target * dim;
            h.env += (target - h.env) * (1 - Math.exp(-dt / 0.12));
            h.boost *= Math.exp(-dt / 0.10);
        }
    }

    _render(now, dt) {
        // Nebula style: hand the choreographed state to the Three.js renderer
        if (this.style === 'nebula' && this._r3d) {
            this._r3d.render(this, now, dt);
            return;
        }
        const ctx = this.ctx;
        const w = this.canvas.width, h = this.canvas.height;
        const isStandard = this.container && this.container.classList.contains('mode-standard');
        const floorY = h - (isStandard ? 90 : 0);
        const minDim = Math.min(w, h);
        const prefs = this._getPrefs();

        // Canvas CSS effect preference
        const wantFilter = prefs.showBgBlur ? 'blur(40px) brightness(0.95)' : 'none';
        if (this.canvas.style.filter !== wantFilter) this.canvas.style.filter = wantFilter;

        // Trail fade (clears faster during flashes so strobes don't smear)
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgba(5,5,9,${clamp(0.30 + this.flash * 0.6, 0, 1)})`;
        ctx.fillRect(0, 0, w, h);

        // Vignette for stage depth
        if (!this._vignette || this._vignetteKey !== `${w}x${h}`) {
            this._vignetteKey = `${w}x${h}`;
            this._vignette = ctx.createRadialGradient(w / 2, h / 2, minDim * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
            this._vignette.addColorStop(0, 'rgba(0,0,0,0)');
            this._vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
        }

        ctx.globalCompositeOperation = 'lighter';

        // ---- Side washes (breathe with mids + beat pulse) ----
        const beatPhase = this.beatFloat % 1;
        const beatPulse = Math.exp(-beatPhase * 4);
        const washDim = 0.4 + this.normEnergy * 0.6;
        const washA = (0.04 + this.envMid * 0.14) * (0.7 + 0.5 * beatPulse) * (this.section === 'intro' ? 0.6 : 1) * washDim;
        if (washA > 0.01) {
            const wc = this._col(1);
            const lg = ctx.createLinearGradient(0, 0, w * 0.45, 0);
            lg.addColorStop(0, rgba(wc, washA));
            lg.addColorStop(1, rgba(wc, 0));
            ctx.fillStyle = lg;
            ctx.fillRect(0, 0, w * 0.45, h);
            const rg = ctx.createLinearGradient(w, 0, w * 0.55, 0);
            rg.addColorStop(0, rgba(wc, washA));
            rg.addColorStop(1, rgba(wc, 0));
            ctx.fillStyle = rg;
            ctx.fillRect(w * 0.55, 0, w * 0.45, h);
        }

        // ---- Moving heads ----
        const beamSegs = [];
        if (!prefs.disableLasers) {
            for (const hd of this._allHeads()) {
                const inten = clamp(hd.env + hd.boost, 0, 1.2);
                if (inten < 0.02) continue;
                const x = hd.baseX * w;
                const y = hd.side === 'floor' ? floorY : 18;
                const dx = Math.sin(hd.angle);
                const dy = hd.side === 'floor' ? -Math.cos(hd.angle) : Math.cos(hd.angle);
                const len = this._beamLen(x, y, dx, dy, w, h);
                if (len < 10) continue;

                const color = this._headColor(hd);
                const widthFactor = 1 + this.envBass * 0.8;
                const w0 = (hd.side === 'floor' ? 10 : 8) * widthFactor;
                const spread = 0.05 + this.envBass * 0.03;
                const { ex, ey } = this._drawBeam(ctx, x, y, dx, dy, len, w0, spread, color, inten);
                beamSegs.push({ x, y, ex, ey, color, inten, width: w0 + len * spread });

                // Fixture lens glow
                const s = this._sprite(color);
                const lens = w0 * 4 * inten + 8;
                ctx.globalAlpha = clamp(inten, 0, 1);
                ctx.drawImage(s, x - lens / 2, y - lens / 2, lens, lens);
                // End pool
                const pool = beamSegs[beamSegs.length - 1].width * 2.2 * inten + 20;
                ctx.globalAlpha = clamp(inten * 0.7, 0, 1);
                ctx.drawImage(s, ex - pool / 2, ey - pool / 2, pool, pool);
                ctx.globalAlpha = 1;
            }
        }

        // ---- Haze particles (lit by beams) ----
        for (const p of this.haze) {
            p.x += p.vx * dt + Math.sin(now * 0.4 + p.seed) * 0.0004;
            p.y += p.vy * dt;
            if (p.y < -0.05 || p.x < -0.05 || p.x > 1.05) {
                p.x = Math.random();
                p.y = 1.02;
                p.vx = (Math.random() - 0.5) * 0.008;
            }
            const px = p.x * w, py = p.y * h;

            let light = 0;
            let lc = null;
            for (const b of beamSegs) {
                // point-to-segment distance
                const sx = b.ex - b.x, sy = b.ey - b.y;
                const sl2 = sx * sx + sy * sy || 1;
                const t = clamp(((px - b.x) * sx + (py - b.y) * sy) / sl2, 0, 1);
                const ddx = px - (b.x + sx * t), ddy = py - (b.y + sy * t);
                const d = Math.sqrt(ddx * ddx + ddy * ddy);
                const reach = b.width * 0.75 + 12;
                if (d < reach) {
                    const v = (1 - d / reach) * b.inten;
                    if (v > light) { light = v; lc = b.color; }
                }
            }
            if (p.flare) { light += p.flare; p.flare *= Math.exp(-dt / 0.15); if (p.flare < 0.02) p.flare = 0; }

            const alpha = clamp(0.035 + light * 0.5 + this.envTreble * 0.04, 0, 0.85);
            const color = lc || this._col(2);
            const size = p.size * (1 + light * 1.6);
            ctx.globalAlpha = alpha;
            ctx.fillStyle = rgba(color, 1);
            ctx.beginPath();
            ctx.arc(px, py, size, 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        // ---- Center orb (the "sun" of the stage) ----
        const cx = w / 2, cy = floorY - (h - (isStandard ? 90 : 0)) * 0.42;
        const calmSection = this.section === 'breakdown' || this.section === 'intro';
        const orbBoost = calmSection ? 0.12 : 0;
        const orbR = minDim * 0.05 * (0.85 + this.envKick * 0.7 + this.envBass * 0.25 + orbBoost);
        if (orbR > 2) {
            const oc = this._col(0);
            const s = this._sprite(oc);
            const d = orbR * 5;
            ctx.globalAlpha = clamp((0.35 + this.envKick * 0.5 + orbBoost) * (calmSection ? 0.55 : 1), 0, 1);
            ctx.drawImage(s, cx - d / 2, cy - d / 2, d, d);
            ctx.globalAlpha = 1;
            const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR);
            core.addColorStop(0, `rgba(255,255,255,${(0.5 + this.envKick * 0.4) * (calmSection ? 0.6 : 1)})`);
            core.addColorStop(0.5, rgba(oc, calmSection ? 0.2 : 0.35));
            core.addColorStop(1, rgba(oc, 0));
            ctx.fillStyle = core;
            ctx.beginPath();
            ctx.arc(cx, cy, orbR, 0, TAU);
            ctx.fill();
        }

        // ---- Impact rings ----
        for (let i = this.rings.length - 1; i >= 0; i--) {
            const r = this.rings[i];
            r.r += minDim * r.speed * dt;   // alpha decay + pruning happen in _decayTransients()
            ctx.beginPath();
            ctx.arc(cx, cy, r.r, 0, TAU);
            ctx.strokeStyle = rgba(r.color, r.alpha);
            ctx.lineWidth = 3 * r.alpha + 1;
            ctx.stroke();
        }

        // ---- Flash pass (drawn last, non-additive) ----
        if (this.flash > 0.01) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = `rgba(255,255,255,${clamp(this.flash * 0.55, 0, 0.6)})`;
            ctx.fillRect(0, 0, w, h);
        }

        // Vignette on top
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = this._vignette;
        ctx.fillRect(0, 0, w, h);

        // ---- Backdrop sync ----
        if (this.backdrop) {
            const scale = 1 + this.envKick * 0.05;
            const opacity = 0.10 + (1 - this.envBass) * 0.22;
            this.backdrop.style.transform = `scale(${scale})`;
            this.backdrop.style.opacity = `${opacity}`;
        }
    }

    // ----------------------------------------------------------- Main loop

    _startLoop() {
        if (this._raf) return;
        const loop = (ts) => {
            this._raf = null;
            if (!this.active) return;
            this._frame(ts);
            if (this.active) this._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
    }

    _frame(ts) {
        // Skip while fullscreen is hidden; loop stays alive for resume
        if (!this.container || this.container.classList.contains('hidden')) return;

        const now = ts / 1000;
        if (!this._lastTs) this._lastTs = now;
        const dt = clamp(now - this._lastTs, 0.001, 0.1);
        this._lastTs = now;
        this._now = now;

        if (this.audioCtx && this.audioCtx.state === 'suspended' && this.isPlaying()) {
            this.audioCtx.resume().catch(() => {});
        }

        this._resize();
        this._getPrefs();
        // Live style switching: the pref poller (0.5s) picks up changes
        if (this._prefs.style !== this.style) this.setStyle(this._prefs.style);
        this._analyse(now, dt);
        this._updateBeatGrid(now, dt);
        this._updateHeads(dt);
        this._decayTransients(dt);

        try {
            this._render(now, dt);
        } catch (e) {
            Logger.error('LightShow render error:', e);
        }
    }

    /**
     * Age the short-lived state (strobe flash, impact rings) in the BRAIN, once
     * per frame — NOT inside a renderer's draw call.
     *
     * The 2D pass used to be the only place that decayed `flash`/`rings` while
     * it painted, but the Nebula (3D) pass returns before that code. In 3D mode
     * `flash` therefore only ever grew (max of every beat/section flash) and
     * stayed pinned for the whole track: the camera-attached flash quad kept
     * `flash * 0.5` opacity (a permanent grey-white veil over the picture) and
     * `_ambient.intensity` stayed boosted, washing the scene out. Impact rings
     * suffered the same way — they stopped spawning once the list hit its cap.
     */
    _decayTransients(dt) {
        this.flash *= Math.exp(-dt / 0.08);
        if (this.flash < 0.002) this.flash = 0;
        for (let i = this.rings.length - 1; i >= 0; i--) {
            const r = this.rings[i];
            r.alpha *= Math.exp(-dt / 0.3);
            if (r.alpha < 0.02) this.rings.splice(i, 1);
        }
    }
}
