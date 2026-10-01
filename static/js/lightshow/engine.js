/**
 * Rainy Light Show — choreographed concert lighting for the fullscreen player.
 *
 * Per frame:
 *  1. PlaybackClock  — smooth media time from <audio>.currentTime (+ user offset).
 *  2. Source         — ScoreSource (server-analysed song: exact beats, bars,
 *                      sections, hits, drops/silences ahead) or LiveSource
 *                      (real-time guessing while the analysis is pending).
 *  3. Director       — scene per section × genre profile, 8-bar phrase
 *                      variations, crossfades, key-derived palettes.
 *  4. Renderer       — lasers, beams, washes, LED bars, haze, sparks, rings,
 *                      blinders and (photosensitivity-limited) strobes.
 *  5. StageLyrics    — optional kinetic, word-synced lyrics with follow spots.
 *
 * Public API (used by player.js / songSettingsModal.js):
 *   start(audioEl) · stop() · resume() · loadScript(songId, force) · clearScript(songId)
 */
import { Logger } from '../helper/logger.js';
import { useLightshowService } from '../services/lightshow.js';
import { PlaybackClock } from './clock.js';
import { Score } from './score.js';
import { ScoreSource, LiveSource } from './sources.js';
import { Director } from './scenes.js';
import { Renderer } from './fixtures.js';
import { StageLyrics } from './lyrics.js';
import { clamp, lerp, hexToHue, paletteFor, blendPalette, mixRgb } from './palette.js';

const POLL_MS = 8000;
const MIN_FLASH_GAP = 1 / 3;          // ≤ 3 flashes per second (WCAG 2.3.1)
const INTENSITY = { chill: 0.3, balanced: 0.65, hype: 1 };
const QUALITY_SCALE = [1, 0.75, 0.5];
const MIC_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
const HUD_SETTLE = 0.7;      // seconds to wait for the stage layout before the HUD moves to the cover
const GENRE_NAMES ={ edm: 'EDM', pop: 'Pop', rock: 'Rock', hiphop: 'Hip-hop', latin: 'Latin', chill: 'Chill', orchestral: 'Orchestral' };

export class LightShowEngine {
    /**
     * @param {object} opts
     * @param {HTMLCanvasElement} opts.canvas
     * @param {HTMLElement} opts.backdrop   album-art backdrop (pumped with the sub bass)
     * @param {HTMLElement} opts.container  fullscreen container (visibility + layout mode)
     * @param {() => boolean} opts.isPlaying
     */
    constructor({ canvas, backdrop, container, isPlaying }) {
        this.canvas = canvas;
        this.backdrop = backdrop;
        this.container = container;
        this.isPlaying = isPlaying || (() => false);
        this.renderer = canvas ? new Renderer(canvas) : null;

        this.active = false;
        this._raf = null;
        this._lastTs = 0;
        this.audioEl = null;

        this.clock = new PlaybackClock();
        this.director = new Director();
        this.live = null;
        this.score = null;
        this.scoreSrc = null;
        this.songId = 0;
        this.status = 'idle';        // idle | loading | synced | analysing | live
        this._loadToken = 0;
        this._pollTimer = null;

        this.pulse = { k: 0, s: 0, h: 0 };
        this.flashAmt = 0;
        this.flashColor = [255, 255, 255];
        this._lastFlashAt = -1;
        this.blinderAmt = 0;
        this.burstAmt = 0;
        this.dim = 1;
        this._lastSub = -1;

        this.accentHue = 350;
        this.palette = paletteFor({ accentHue: this.accentHue, label: 'intro', genre: 'pop' });

        this._prefs = { disableLasers: false, showBgBlur: false, reduceFlashing: false, intensity: 'auto', offset: 0 };
        this._prefsAt = -1;

        this._quality = 0;
        this._frameEma = 1 / 60;
        this._qualityTimer = 0;

        this._hud = null;
        this._hudTimer = null;
        this.stage = container ? new StageLyrics(container) : null;
        this._stageOn = false;
        this._lastSprayAt = 0;
        this._onLoadStart = () => this._onTrackChange();
    }

    // ------------------------------------------------------------------ API

    start(audioEl) {
        if (!this.renderer) return;
        if (this.audioEl !== audioEl) {
            if (this.audioEl) this.audioEl.removeEventListener('loadstart', this._onLoadStart);
            this.audioEl = audioEl;
            audioEl.addEventListener('loadstart', this._onLoadStart);
        }
        this.active = true;
        this._readAccent();
        this._getPrefs(true);
        this.clock.reset();
        this._lastTs = 0;
        if (this.container) this.container.classList.add('lightshow-on');
        this._ensureHud();
        this._renderHud(true);
        this._startLoop();
    }

    stop() {
        this.active = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
        this._clearPoll();
        if (this.renderer) this.renderer.clear();
        if (this.canvas) this.canvas.style.filter = 'none';
        if (this.container) this.container.classList.remove('lightshow-on');
        if (this._hud) this._hud.classList.remove('show', 'compact');
        this._setStage(false);
    }

    /** Called when the fullscreen player re-opens while the show is active. */
    resume() {
        if (!this.active) return;
        this.clock.reset();
        if (this.live && this.live.graph) this.live.graph.resume();
        this._renderHud(true);
        this._startLoop();
    }

    /**
     * Load the song's score. Without one the server queues the analysis;
     * the live fallback runs and we poll until the score is ready.
     * @param {number} songId
     * @param {boolean} [force] refetch even if this song is already loaded
     */
    async loadScript(songId, force = false) {
        if (!songId) return;
        if (!force && this.songId === songId && (this.score || this.status === 'loading' || this._pollTimer)) return;
        if (this.songId !== songId) {
            this.score = null;
            this.scoreSrc = null;
        }
        this.songId = songId;
        this._clearPoll();
        const token = ++this._loadToken;
        if (!this.score) this._setStatus('loading');
        try {
            const res = await useLightshowService().get(songId);
            if (token !== this._loadToken) return;
            const body = res && !res.error ? res.value : null;
            const score = body && body.success ? Score.from(body.lightshow) : null;
            if (score) {
                this.score = score;
                this.scoreSrc = new ScoreSource(score);
                this.director.reset();
                this._setStatus('synced', true);
                Logger.log(`LightShow: score loaded (${Math.round(score.tempo)} BPM, ${score.sections.length} sections, ${score.profile.genre}).`);
                return;
            }
            this.score = null;
            this.scoreSrc = null;
            const pending = !!(body && body.pending);
            this._setStatus(pending ? 'analysing' : 'live');
            if (pending) this._schedulePoll(songId, token);
        } catch (e) {
            if (token === this._loadToken) this._setStatus('live');
            Logger.error('LightShow: failed to load score.', e);
        }
    }

    /** Drop the loaded score (e.g. after the user removed it server-side). */
    clearScript(songId = 0) {
        if (songId && this.songId !== songId) return;
        this._clearPoll();
        this._loadToken++;
        this.score = null;
        this.scoreSrc = null;
        this.songId = 0;
        this._setStatus('live');
    }

    // ------------------------------------------------------------ internals

    _schedulePoll(songId, token) {
        this._clearPoll();
        this._pollTimer = setTimeout(() => {
            this._pollTimer = null;
            if (!this.active || token !== this._loadToken || this.songId !== songId) return;
            this.loadScript(songId, true);
        }, POLL_MS);
    }

    _clearPoll() {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        this._pollTimer = null;
    }

    _onTrackChange() {
        this.clock.reset();
        this.director.reset();
        this.flashAmt = 0;
        this.blinderAmt = 0;
        this.burstAmt = 0;
        if (this.live) this.live.onTrackChange(performance.now() / 1000);
        if (this.renderer) {
            this.renderer.sparks.length = 0;
            this.renderer.rings.length = 0;
        }
    }

    _readAccent() {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) this.accentHue = hexToHue(v);
        } catch (e) { /* keep previous */ }
    }

    _getPrefs(force = false) {
        const now = performance.now() / 1000;
        if (!force && now - this._prefsAt < 0.5) return this._prefs;
        this._prefsAt = now;
        let p = {};
        try {
            let raw = window.app && window.app.user && window.app.user.preferences;
            if (typeof raw === 'string') raw = JSON.parse(raw);
            p = raw || {};
        } catch (e) { /* ignore */ }
        this._prefs = {
            disableLasers: !!p.disable_lasers,
            showBgBlur: !!p.show_bg_blur,
            reduceFlashing: !!p.lightshow_reduce_flashing,
            intensity: ['auto', 'chill', 'balanced', 'hype'].includes(p.lightshow_intensity) ? p.lightshow_intensity : 'auto',
            offset: clamp(Number(p.lightshow_offset_ms) || 0, -500, 500) / 1000,
            stageLyrics: p.lightshow_lyrics !== false,
        };
        return this._prefs;
    }

    _scoreActive() {
        if (!this.scoreSrc || !this.audioEl) return false;
        const d = this.audioEl.duration;
        return !(d && isFinite(d) && this.score.duration && Math.abs(d - this.score.duration) > 2);
    }

    _liveSource() {
        // While the score request is in flight, idle on a silent clock rather
        // than routing the element through WebAudio for nothing.
        if (!this.live && this.status === 'loading') {
            if (!this._idle) this._idle = new LiveSource(this.audioEl, false);
            return this._idle;
        }
        if (!this.live) this.live = new LiveSource(this.audioEl);
        return this.live;
    }

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

    _resize(dt) {
        // Adaptive quality: drop resolution/effects when frames run long.
        this._frameEma = lerp(this._frameEma, dt, 0.05);
        this._qualityTimer += dt;
        if (this._frameEma > 1 / 40 && this._qualityTimer > 1.5 && this._quality < 2) {
            this._quality++;
            this._qualityTimer = 0;
        } else if (this._frameEma < 1 / 57 && this._qualityTimer > 8 && this._quality > 0) {
            this._quality--;
            this._qualityTimer = 0;
        } else if (this._frameEma >= 1 / 57 && this._frameEma <= 1 / 40) {
            this._qualityTimer = 0;
        }
        const r = this.renderer;
        r.quality = this._quality;
        r.floorPx = this.container && this.container.classList.contains('mode-standard') ? 90 : 0;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        r.resize(window.innerWidth, window.innerHeight, dpr * QUALITY_SCALE[this._quality]);
    }

    _frame(ts) {
        if (!this.container || this.container.classList.contains('hidden') || !this.audioEl) return;
        const now = ts / 1000;
        if (!this._lastTs) this._lastTs = now;
        const dt = clamp(now - this._lastTs, 0.001, 0.1);
        this._lastTs = now;

        const prefs = this._getPrefs();
        this._resize(dt);
        this._alignHud(now);

        // ---- Musical state ----
        const tPrev = this.clock.t;
        const t = this.clock.update(this.audioEl, now, prefs.offset);
        const running = this.clock.running;
        const scripted = this._scoreActive();
        let F;
        if (scripted) {
            F = this.scoreSrc.frame(t, tPrev, this.clock.jumped);
        } else {
            const live = this._liveSource();
            if (live.graph && running) live.graph.resume();
            F = live.frame(now, dt, running && this.isPlaying());
        }
        F.jumped = this.clock.jumped;
        F.running = running;

        const I = prefs.intensity === 'auto'
            ? clamp(0.35 + 0.65 * ((F.profile && F.profile.intensity) ?? 0.6), 0.3, 1)
            : INTENSITY[prefs.intensity];

        // Hit envelopes (instant attack, short release).
        const p = this.pulse;
        p.k = Math.max(p.k * Math.exp(-dt / 0.13), F.hits.k);
        p.s = Math.max(p.s * Math.exp(-dt / 0.15), F.hits.s);
        p.h = Math.max(p.h * Math.exp(-dt / 0.07), F.hits.h);
        if (F.jumped) p.k = p.s = p.h = 0;
        F.pulse = p;

        // ---- Direction ----
        const { a, b, mix } = this.director.update(F, this.palette, { I, lasers: !prefs.disableLasers }, this.accentHue);
        if (this.director.paletteTarget) {
            const snap = this.director.snapPalette || F.jumped;
            blendPalette(this.palette, this.director.paletteTarget, snap ? 1 : 1 - Math.exp(-dt / 0.6));
            this.director.snapPalette = false;
        }
        const P = this.palette;

        // ---- Master dimmer: blackouts, pre-drop suck-back, pause ----
        let dimTarget = running ? 1 : 0.35;
        if (F.stopDepth > 0) dimTarget = 1 - 0.96 * F.stopDepth;
        else if (F.dropIn > 0 && F.dropIn < F.period && F.stopIn > F.dropIn) {
            dimTarget = 1 - 0.45 * (1 - F.dropIn / F.period);
        }
        this.dim = F.stopDepth > 0 || F.jumped ? dimTarget : lerp(this.dim, dimTarget, 1 - Math.exp(-dt / 0.08));

        // ---- Triggers ----
        const S = blendNum(a.strobe, b && b.strobe, mix);
        const flashScale = 0.4 + 0.6 * I;
        let fl = 0;
        if (F.hits.s >= 0.45) fl = Math.max(fl, S.snare * F.hits.s);
        if (F.hits.k >= 0.5) fl = Math.max(fl, S.kick * F.hits.k);
        if (F.newBar) fl = Math.max(fl, S.bar);
        if (S.sub > 0.01) {
            const n = Math.floor(F.beat * (a.strobe.subN || 1));
            if (n !== this._lastSub && this._lastSub !== -1) fl = Math.max(fl, S.sub);
            this._lastSub = n;
        } else this._lastSub = -1;
        if (running && fl > 0.02) this._flash(fl * flashScale, P.w, prefs, now);

        const Bl = blendNum(a.blinders, b && b.blinders, mix);
        let bl = 0;
        if (F.hits.s >= 0.5) bl = Math.max(bl, Bl.snare * F.hits.s);
        if (F.newBar && F.hits.k > 0.2) bl = Math.max(bl, Bl.bar);
        if (bl > 0.05 && running) this.blinderAmt = Math.max(this.blinderAmt, bl * (prefs.reduceFlashing ? 0.4 : 1) * flashScale);

        const R = blendNum(a.rings, b && b.rings, mix);
        const r = this.renderer;
        if (running) {
            if (F.newBar && R.bar > 0.1) r.ring('floor', P.a, 0.5 * R.bar);
            if (F.hits.k > 0.6 && R.kick > 0.1) r.ring('halo', P.b, 0.4 * R.kick * F.hits.k, 1.3);
            const sp = lerp(b ? b.sparks : a.sparks, a.sparks, mix);
            if (sp > 0.05 && F.hits.k > 0.75 && F.newBeat) r.burst(Math.round(10 * sp * I), [P.a, P.b, P.w], 0.6);
        }
        for (const ev of F.events) this._onEvent(ev, P, prefs, now, I);

        // ---- Stage lyrics ----
        const stage = this.stage;
        if (stage && prefs.stageLyrics && this.songId && stage.songId !== this.songId) stage.load(this.songId);
        this._setStage(!!(stage && prefs.stageLyrics && stage.ready && stage.songId === this.songId));
        if (this._stageOn) {
            stage.update(F, t, P, now);
            const lbl = F.section && F.section.label;
            const hot = lbl === 'drop' || lbl === 'chorus';
            const on = stage.onset;
            if (running && on) {
                // Embers fly off words that land on a hit (or are held) in the hot
                // sections, spread along the word instead of from a point.
                if (hot && I > 0.5 && now - this._lastSprayAt > 0.2 && ((on.hit && on.strong) || on.held || F.hits.k > 0.5)) {
                    this._lastSprayAt = now;
                    r.sprayAt(on.x, on.y, Math.round(6 + 8 * I), [P.a, P.b, P.w], Math.max(0, on.r - on.l));
                }
            }
            // Line hand-overs are cues for the rig too.
            const cue = stage.cue;
            if (running && cue && I > 0.4) {
                if (cue.type === 'slam') {
                    this.flashAmt = Math.max(this.flashAmt, 0.3 * I);
                    r.ring('floor', P.a, 0.5 * I, 1);
                } else if (cue.type === 'fall') {
                    r.ring('floor', P.b, 0.4 * I, 0.7);
                } else if (cue.type === 'flicker') {
                    this.blinderAmt = Math.max(this.blinderAmt, 0.5 * I);
                } else if (cue.type === 'break') {
                    // The vocals drop out and the rig takes the stage.
                    this.blinderAmt = Math.max(this.blinderAmt, 0.6 * I);
                    r.ring('floor', P.b, 0.5 * I, 0.9);
                }
            }
        }
        this._syncHudStage(prefs);

        this.flashAmt *= Math.exp(-dt / 0.07);
        this.blinderAmt *= Math.exp(-dt / 0.14);
        this.burstAmt *= Math.exp(-dt / 0.6);

        // ---- Render ----
        const want = prefs.showBgBlur ? 'blur(24px)' : 'none';
        if (this.canvas.style.filter !== want) this.canvas.style.filter = want;
        try {
            this._render(F, a, b, mix, dt, P);
        } catch (e) {
            Logger.error('LightShow render error:', e);
        }

        if (this.backdrop) {
            const scale = 1.02 + 0.05 * p.k * this.dim;
            const opacity = (0.4 + 0.35 * F.bands.rms) * this.dim;
            this.backdrop.style.transform = `scale(${scale.toFixed(3)})`;
            this.backdrop.style.opacity = opacity.toFixed(3);
        }
    }

    _onEvent(ev, P, prefs, now, I) {
        const r = this.renderer;
        if (ev.type === 'drop') {
            this._flash(1, P.w, prefs, now);
            this.burstAmt = 1;
            r.ring('floor', P.w, 1, 1.4);
            r.ring('floor', P.a, 0.8, 0.9);
            r.ring('halo', P.b, 0.9, 1.2);
            r.burst(Math.round(90 + 90 * I), [P.a, P.b, P.c, P.w], 1);
        } else if (ev.type === 'impact') {
            this._flash(0.5, P.w, prefs, now);
            this.burstAmt = Math.max(this.burstAmt, 0.5);
            r.ring('halo', P.a, 0.7, 1.1);
            r.burst(Math.round(40 * I), [P.a, P.w], 0.8);
        }
    }

    /** Strobe with a hard photosensitivity limiter. */
    _flash(amount, color, prefs, now) {
        if (prefs.reduceFlashing) {
            amount = Math.min(amount * 0.3, 0.2);
            color = mixRgb(this.palette.a, color, 0.3);
        }
        if (amount > 0.12) {
            if (now - this._lastFlashAt < MIN_FLASH_GAP) amount = Math.min(amount, 0.08);
            else this._lastFlashAt = now;
        }
        if (amount > this.flashAmt) {
            this.flashAmt = amount;
            this.flashColor = color;
        }
    }

    _render(F, a, b, mix, dt, P) {
        const r = this.renderer;
        const dim = this.dim;
        const boost = 1 + 0.6 * this.burstAmt;
        r.begin(lerp(b ? b.trail : a.trail, a.trail, mix) * (F.stopDepth > 0 ? 0.3 : 1));

        const wash = blendWash(a.wash, b && b.wash, mix);
        r.wash(wash, dim);
        const halo = { alpha: lerp(b ? b.halo.alpha : a.halo.alpha, a.halo.alpha, mix), r: lerp(b ? b.halo.r : a.halo.r, a.halo.r, mix), color: a.halo.color };
        r.halo(halo, dim);

        const ka = mix * dim * boost, kb = (1 - mix) * dim * boost;
        if (b && kb > 0.01) {
            for (const beam of b.beams) r.beam(beam, kb);
            for (const f of b.lasers) r.fan(f, kb);
        }
        for (const beam of a.beams) r.beam(beam, ka);
        for (const f of a.lasers) r.fan(f, ka);

        // The lone laser through the blackout before a drop.
        if (F.stopDepth > 0) {
            const sweep = 0.06 * Math.sin(F.t * 3);
            r.fan({ x: -0.02, y: 0.5, angle: Math.PI / 2 + sweep, spread: 0, count: 1, alpha: 0.85, thick: 1.2, color: P.w }, F.stopDepth);
        }

        const hazeAmt = lerp(b ? b.haze : a.haze, a.haze, mix);
        const lights = r.lightsOf(a, ka);
        if (b && kb > 0.05) lights.push(...r.lightsOf(b, kb));
        r.hazeLayer(hazeAmt, lights.slice(0, 16), this.pulse.h * dim, dt);

        // Follow spots on the word being sung.
        const band = this._stageOn && this.stage.band;
        if (band) {
            // Pull the lasers back behind the lyric band so the words read.
            const w = this.canvas.width / r.s;
            // (Not during an instrumental break: no words to protect, the rig gets the stage.)
            r.scrim(w / 2, band.top + band.height / 2, Math.min(w * 0.46, 620), band.height * 0.5, 0.55 * (1 - this.stage.interlude));
        }
        // Backing vocals get their own small spot and pool in the second colour.
        const ad = this._stageOn && this.stage.adlib;
        if (ad) {
            const k = ad.strength * Math.max(dim, 0.5);
            r.pool(ad.x, ad.y, 90, (0.2 + 0.15 * this.pulse.k) * k, P.b);
            r.followSpot(ad.x < this.canvas.width / r.s / 2 ? 0.95 : 0.05, 0, ad.x, ad.y, 0.03, 0.14 * k, mixRgb(P.w, P.b, 0.35));
        }
        const focus = this._stageOn && this.stage.focus;
        if (focus) {
            const lbl = F.section && F.section.label;
            const quiet = lbl === 'intro' || lbl === 'outro' || lbl === 'breakdown';
            const spotA = (quiet ? 0.44 : 0.36 + 0.2 * F.bands.rms) * Math.max(dim, 0.55) * focus.strength;
            // Each word is picked out in the other palette colour; held notes
            // get a tighter, brighter cone. The two spots are different colours
            // and land together in one pool of light on the word.
            const tone = focus.flip ? P.b : P.a;
            const other = focus.flip ? P.a : P.b;
            const kick = this._prefs.reduceFlashing ? 0.25 * this.pulse.k : this.pulse.k;
            const width = focus.tight ? 0.028 : 0.04;
            const boost = (focus.tight ? 1.2 : 1) * (0.7 + 0.5 * kick);
            r.pool(focus.x, focus.y, 150, (0.2 + 0.3 * kick) * (focus.tight ? 1.2 : 1) * Math.max(dim, 0.5) * Math.min(1, focus.strength * 1.4), mixRgb(tone, other, 0.5));
            r.followSpot(0.05, 0, focus.x - 6, focus.y, width, spotA * boost, mixRgb(tone, P.w, 0.2), { id: 'L', dt, kick });
            r.followSpot(0.95, 0, focus.x + 6, focus.y, width, spotA * boost, mixRgb(other, P.w, 0.2), { id: 'R', dt, kick });
        }
        const bar = this._stageOn && this.stage.bar;
        if (bar) {
            r.lyricBar(bar.x0, bar.x1, bar.y, bar.p, bar.fade * Math.max(dim, 0.5), mixRgb(P.w, P.a, 0.4),
                (bar.hit ? 0.6 : 0) + 0.4 * this.pulse.k);
        }

        const px = b ? blendPixels(a.pixels, b.pixels, mix) : a.pixels;
        r.pixels(px, dim);
        r.effects(dt, Math.max(dim, 0.3));
        r.blinders(this.blinderAmt * dim, P.w);
        r.flash(this.flashAmt, this.flashColor);
        r.vignette();
    }

    // ------------------------------------------------------------------ HUD

    _ensureHud() {
        if (this._hud || !this.container) return;
        const el = document.createElement('div');
        el.className = 'ls-hud';
        el.innerHTML = '<span class="ls-hud-side ls-hud-l"><b></b><small>BPM</small></span>'
            + `<button type="button" class="ls-hud-lyrics" title="Lyrics on stage" aria-pressed="false">${MIC_ICON}</button>`
            + '<span class="ls-hud-side ls-hud-r"><span class="ls-hud-meta"></span></span>';
        el.querySelector('.ls-hud-lyrics').addEventListener('click', (e) => {
            e.stopPropagation();
            const on = !this._getPrefs(true).stageLyrics;
            if (window.app && typeof window.app.savePreferences === 'function') {
                window.app.savePreferences({ lightshow_lyrics: on });
            }
            this._prefs.stageLyrics = on;
            if (on && this.stage && this.songId) this.stage.load(this.songId);
            this._renderHud(true);
            if (on && this.stage && !this.stage.ready) window.showToast?.('No synced lyrics for this song', 'info');
        });
        this.container.appendChild(el);
        this._hud = el;
    }

    /** Enter/leave the stage-lyrics layout (queue hidden, art shrunk). */
    _setStage(on) {
        if (on === this._stageOn) return;
        this._stageOn = on;
        this._stageAt = performance.now() / 1000;
        if (this.container) this.container.classList.toggle('ls-stage', on);
        if (this.stage) {
            this.stage.show(on);
            this.stage.invalidateLayout();
            // Re-measure once the layout transition has settled.
            setTimeout(() => this.stage && this.stage.invalidateLayout(), 600);
        }
    }

    _syncHudStage(prefs) {
        const btn = this._hud && this._hud.querySelector('.ls-hud-lyrics');
        if (!btn) return;
        const pressed = String(!!prefs.stageLyrics);
        if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
        const missing = !!prefs.stageLyrics && !!this.stage && !this.stage.ready;
        btn.classList.toggle('missing', missing);
    }

    _setStatus(status, force = false) {
        const changed = force || status !== this.status;
        this.status = status;
        if (changed) this._renderHud(true);
    }

    /**
     * With lyrics on stage the HUD moves to the cover's centre line. It waits for
     * the cover's own layout transition to settle and then glides there once,
     * rather than chasing the cover while it is still resizing.
     */
    _alignHud(now) {
        const hud = this._hud;
        if (!hud || now - (this._hudAxisAt || 0) < 0.2) return;
        this._hudAxisAt = now;
        if (!this._stageOn) {
            // Plain show: pinned to the top centre of the screen.
            if (this._hudX !== null) {
                this._hudX = null;
                hud.style.left = '';
                hud.classList.remove('stage-pos');
            }
            return;
        }
        if (now - this._stageAt < HUD_SETTLE) return;
        const art = this.container.querySelector('#fs-artwork');
        if (!art) return;
        const r = art.getBoundingClientRect();
        if (!r.width) return;
        const x = Math.round(r.left - this.container.getBoundingClientRect().left + r.width / 2);
        hud.classList.add('stage-pos');
        if (x !== this._hudX) {
            this._hudX = x;
            hud.style.left = `${x}px`;
        }
    }

    _renderHud(expand) {
        const el = this._hud;
        if (!el || !this.active) return;
        const synced = this.status === 'synced' && !!this.score;
        let meta;
        if (synced) {
            el.querySelector('.ls-hud-l b').textContent = String(Math.round(this.score.tempo));
            meta = GENRE_NAMES[this.score.profile.genre] || 'Synced';
        } else if (this.status === 'analysing') meta = 'Analysing song';
        else if (this.status === 'loading') meta = 'Loading show';
        else meta = 'Live';
        el.querySelector('.ls-hud-meta').textContent = meta;
        el.dataset.status = synced ? 'synced' : this.status;
        el.classList.add('show');
        if (expand) {
            el.classList.remove('compact');
            clearTimeout(this._hudTimer);
            this._hudTimer = setTimeout(() => el.classList.add('compact'), 4500);
        }
    }
}

// ---------------------------------------------------------------- blending

function blendNum(a, b, t) {
    if (!b) return a;
    const out = {};
    for (const k of Object.keys(a)) out[k] = lerp(b[k] || 0, a[k] || 0, t);
    return out;
}

function blendWash(a, b, t) {
    if (!b) return a;
    return {
        l: lerp(b.l, a.l, t), r: lerp(b.r, a.r, t), top: lerp(b.top, a.top, t), floor: lerp(b.floor, a.floor, t),
        colL: a.colL, colR: a.colR, colTop: a.colTop, colFloor: a.colFloor,
    };
}

function blendPixels(a, b, t) {
    const cells = new Float32Array(a.cells.length);
    for (let i = 0; i < cells.length; i++) cells[i] = lerp(b.cells[i], a.cells[i], t);
    return { cells, colA: a.colA, colB: a.colB, alpha: lerp(b.alpha, a.alpha, t) };
}

