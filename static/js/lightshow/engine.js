/**
 * Rainy Light Show — a choreographed show for the fullscreen player.
 *
 * The engine is the part every environment shares. Per frame:
 *  1. PlaybackClock  — smooth media time from <audio>.currentTime (+ user offset).
 *  2. Source         — ScoreSource (server-analysed song: exact beats, bars,
 *                      sections, hits, drops/silences ahead) or LiveSource
 *                      (real-time guessing while the analysis is pending).
 *  3. Conductor      — intensity, hit pulses, 8-bar phrases, key-derived
 *                      palettes, master dimmer and the flash limiter.
 *  4. Environment    — the kind of show on stage (see environments/index.js).
 *                      It stages that state its own way, lyrics included
 *                      (LyricsTimeline says what is sung when).
 *
 * Public API (used by player.js / songSettingsModal.js):
 *   start(audioEl) · stop() · resume() · loadScript(songId, force) · clearScript(songId)
 *   setTrack(track) · resetStageLyrics()
 *
 * Which environment runs is the `lightshow_environment` preference: the
 * engine follows it live, so Settings and the HUD button only have to save it.
 */
import { Logger } from '../helper/logger.js';
import { t } from '../i18n/index.js';
import { useLightshowService } from '../services/lightshow.js';
import { PlaybackClock } from './clock.js';
import { Score } from './score.js';
import { ScoreSource, LiveSource } from './sources.js';
import { Conductor } from './conductor.js';
import { LyricsTimeline } from './lyricsTimeline.js';
import {
    ENVIRONMENTS, ENVIRONMENT_IDS, DEFAULT_ENVIRONMENT, normalizeEnvironment, resolveEnvironment,
} from './environments/index.js';
import { clamp, lerp, hexToHue } from './palette.js';
// The default environment ships with the engine, so the show starts without a round trip.
import './environments/classic/index.js';

const POLL_MS = 8000;
const QUALITY_SCALE = [1, 0.75, 0.5];
// Low performance mode: fixed render scale (ignores DPR) and a 30 fps cap.
const LOW_SCALE = 0.6;
const LOW_FRAME_MS = 1000 / 30 - 2;
const LOW_POWER_KEY = 'rainy-ls-lowpower';
const SLOW_HINT_AFTER = 10;  // seconds at the lowest auto quality, still slow, before suggesting low power
const SLOW_HINT_KEY = 'rainy-ls-slow-hint';
const ENV_FADE_MS = 600;     // an environment fades out this long before it is unmounted
const MIC_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
const ENV_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/></svg>';
const QUEUE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 6h13v2H3zm0 5h13v2H3zm0 5h9v2H3zm14-3v6l5-3z"/></svg>';
const HUD_BTN = 26;          // px, a HUD button
const HUD_GAP = 4;
const GENRE_NAMES ={ edm: 'EDM', pop: 'Pop', rock: 'Rock', hiphop: 'Hip-hop', latin: 'Latin', chill: 'Chill', orchestral: 'Orchestral' };

export class LightShowEngine {
    /**
     * @param {object} opts
     * @param {HTMLCanvasElement} opts.canvas   2D canvas of the classic environment
     * @param {HTMLElement} opts.backdrop   album-art backdrop (pumped with the sub bass)
     * @param {HTMLElement} opts.container  fullscreen container (visibility + layout mode)
     * @param {() => boolean} opts.isPlaying
     */
    constructor({ canvas, backdrop, container, isPlaying }) {
        this.canvas = canvas;
        this.backdrop = backdrop;
        this.container = container;
        this.isPlaying = isPlaying || (() => false);

        this.active = false;
        this._raf = null;
        this._lastTs = 0;
        this.audioEl = null;

        this.clock = new PlaybackClock();
        this.conductor = new Conductor();
        this.lyrics = new LyricsTimeline();
        this.live = null;
        this.score = null;
        this.scoreSrc = null;
        this.songId = 0;
        this.track = null;           // { id, title, artist, cover } of the song on stage
        this.status = 'idle';        // idle | loading | synced | analysing | live
        this._loadToken = 0;
        this._pollTimer = null;

        this.env = null;             // environment on stage
        this.envId = '';
        this._envWanted = '';        // environment on stage or on its way
        this._envToken = 0;
        this._envFailed = new Set(); // environments that broke on this device this session
        this._retired = null;        // previous environment, fading out
        this._retireTimer = null;

        this._prefs = { disableLasers: false, showBgBlur: false, reduceFlashing: false, intensity: 'auto', offset: 0, lowPower: false, environment: DEFAULT_ENVIRONMENT };
        this._prefsAt = -1;

        this._quality = 0;
        this._frameEma = 1 / 60;
        this._qualityTimer = 0;
        this._lowPower = false;
        this._lastFrameAt = 0;
        this._slowFor = 0;

        this._hud = null;
        this._lpPrompt = null;
        this._lpPending = false;
        this._lpTimer = null;
        this._hudTimer = null;
        // Stage lyrics are opt-in per queue: off for every new queue, and once
        // switched on they stay on for the songs that follow in that queue.
        this.stageLyrics = false;
        this._onLoadStart = () => this._onTrackChange();
    }

    // ------------------------------------------------------------------ API

    start(audioEl) {
        if (!this.canvas || !this.container) return;
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
        this.container.classList.add('lightshow-on');
        this._ensureHud();
        this._renderHud(true);
        // An unanswered low-power offer comes back with the show.
        if (this._lpPending && this._lpPrompt) this._lpPrompt.classList.add('show');
        this._useEnvironment(this._prefs.environment);
        this._startLoop();
    }

    stop() {
        this.active = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
        this._clearPoll();
        this._dropEnvironment();
        if (this.container) this.container.classList.remove('lightshow-on', 'ls-lowpower');
        this._lowPower = false;
        if (this._hud) this._hud.classList.remove('show', 'compact');
        if (this._lpPrompt) this._lpPrompt.classList.remove('show');
    }

    /** A new queue started: stage lyrics go back to off until picked again. */
    resetStageLyrics() {
        if (!this.stageLyrics) return;
        this.stageLyrics = false;
        if (this.env) this.env.dropLyrics();
        this._renderHud(true);
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
     * The song on stage, for environments that show it (cover, title).
     * @param {{ id?: number, title?: string, artist?: string, cover?: string|null }|null} track
     */
    setTrack(track) {
        this.track = track || null;
        if (this.env) this.env.setTrack(this.track);
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
        if (this.songId !== songId) this._setScore(null);
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
                this._setScore(score);
                this._setStatus('synced', true);
                Logger.log(`LightShow: score loaded (${Math.round(score.tempo)} BPM, ${score.sections.length} sections, ${score.profile.genre}).`);
                return;
            }
            this._setScore(null);
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
        this._setScore(null);
        this.songId = 0;
        this._setStatus('live');
    }

    // ------------------------------------------------------------ internals

    _setScore(score) {
        if (score === this.score) return;
        this.score = score;
        this.scoreSrc = score ? new ScoreSource(score) : null;
        if (score) this.conductor.reset();
        if (this.env) this.env.setScore(score);
    }

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
        this.conductor.onTrackChange();
        if (this.live) this.live.onTrackChange(performance.now() / 1000);
        if (this.env) this.env.onTrackChange();
    }

    _readAccent() {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) this.conductor.accentHue = hexToHue(v);
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
            lowPower: readLowPower(),
            environment: normalizeEnvironment(p.lightshow_environment),
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

    // --------------------------------------------------------- environments

    /**
     * Put an environment on stage (the default one when this device cannot
     * run it). The one it replaces fades out and is unmounted afterwards.
     */
    async _useEnvironment(wanted) {
        const id = resolveEnvironment(wanted, this._envFailed);
        if (id === this._envWanted) return;
        this._envWanted = id;
        const token = ++this._envToken;   // whatever was on its way is no longer wanted
        if (this.env && this.envId === id) return;
        this._flushRetired();
        let env = null;
        try {
            const Env = await ENVIRONMENTS[id].load();
            if (token !== this._envToken) return;
            env = new Env();
            await env.mount({
                container: this.container,
                canvas: this.canvas,
                backdrop: this.backdrop,
                lyrics: this.lyrics,
                onFatal: (e) => this._environmentFailed(id, e),
            });
            if (token !== this._envToken) {
                env.unmount();
                return;
            }
        } catch (e) {
            if (env) {
                try { env.unmount(); } catch (err) { /* already broken */ }
            }
            if (token === this._envToken) this._environmentFailed(id, e);
            return;
        }
        const old = this.env;
        this.env = env;
        this.envId = id;
        this.container.dataset.lsEnv = id;
        env.setTrack(this.track);
        env.setScore(this.score);
        if (old) this._retire(old);
        this._hudAxisAt = 0;
        this._renderHud(true);
    }

    /** An environment could not start, or died on stage: fall back to the default. */
    _environmentFailed(id, err) {
        Logger.error(`LightShow: the "${id}" environment failed.`, err);
        this._envFailed.add(id);
        if (id !== DEFAULT_ENVIRONMENT) {
            window.showToast?.(t('{name} is not available on this device. Back to Classic.', { name: ENVIRONMENTS[id].name }), 'info');
        }
        // It never made it on stage: keep what is there.
        if (this.env && this.envId !== id) {
            this._envWanted = this.envId;
            return;
        }
        if (this.env) {
            const dead = this.env;
            this.env = null;
            this.envId = '';
            try { dead.unmount(); } catch (e) { /* already broken */ }
        }
        this._envWanted = '';
        if (id !== DEFAULT_ENVIRONMENT && this.active) this._useEnvironment(DEFAULT_ENVIRONMENT);
    }

    _retire(env) {
        try { env.leave(); } catch (e) { Logger.error('LightShow: environment leave error:', e); }
        this._retired = env;
        this._retireTimer = setTimeout(() => this._flushRetired(), ENV_FADE_MS);
    }

    _flushRetired() {
        clearTimeout(this._retireTimer);
        this._retireTimer = null;
        const env = this._retired;
        this._retired = null;
        if (!env) return;
        try { env.unmount(); } catch (e) { Logger.error('LightShow: environment unmount error:', e); }
    }

    /** Take everything off stage (the show stopped). */
    _dropEnvironment() {
        this._envToken++;
        this._envWanted = '';
        this._flushRetired();
        const env = this.env;
        this.env = null;
        this.envId = '';
        if (this.container) delete this.container.dataset.lsEnv;
        if (!env) return;
        try { env.unmount(); } catch (e) { Logger.error('LightShow: environment unmount error:', e); }
    }

    // ----------------------------------------------------------------- loop

    _startLoop() {
        if (this._raf) return;
        const loop = (ts) => {
            this._raf = null;
            if (!this.active) return;
            // Low power: render every other frame on a 60 Hz display (the loop itself keeps running).
            if (!this._prefs.lowPower || ts - this._lastFrameAt >= LOW_FRAME_MS) {
                this._lastFrameAt = ts;
                this._frame(ts);
            }
            if (this.active) this._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
    }

    _resize(dt, lowPower) {
        const env = this.env;
        if (lowPower) {
            // Fixed lowest quality; the adaptive state is left as it was.
            this._slowFor = 0;
            env.resize(window.innerWidth, window.innerHeight, { tier: 2, lowPower: true, scale: LOW_SCALE });
            return;
        }
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
        this._slowFor = this._quality === 2 && this._frameEma > 1 / 40 ? this._slowFor + dt : 0;
        if (this._slowFor > SLOW_HINT_AFTER) this._hintLowPower();
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        env.resize(window.innerWidth, window.innerHeight, { tier: this._quality, lowPower: false, scale: dpr * QUALITY_SCALE[this._quality] });
    }

    _frame(ts) {
        if (!this.container || this.container.classList.contains('hidden') || !this.audioEl) return;
        const now = ts / 1000;
        if (!this._lastTs) this._lastTs = now;
        const dt = clamp(now - this._lastTs, 0.001, 0.1);
        this._lastTs = now;

        const prefs = this._getPrefs();
        const wantedEnv = resolveEnvironment(prefs.environment, this._envFailed);
        if (wantedEnv !== this._envWanted) this._useEnvironment(wantedEnv);
        const env = this.env;
        if (!env) return;   // still on its way

        if (prefs.lowPower !== this._lowPower) {
            this._lowPower = prefs.lowPower;
            // Leaving low power: the ~30 fps frame times would otherwise read as a slow machine.
            if (!prefs.lowPower) this._frameEma = 1 / 60;
            this.container.classList.toggle('ls-lowpower', prefs.lowPower);
        }
        this._resize(dt, prefs.lowPower);
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

        // ---- Direction ----
        const S = this.conductor.update(F, prefs, t, now, dt);

        // ---- Lyrics on stage ----
        const lyrics = this.lyrics;
        const wantLyrics = prefs.stageLyrics && this.stageLyrics;
        if (wantLyrics && this.songId && lyrics.songId !== this.songId) lyrics.load(this.songId);
        S.songId = this.songId;
        S.lyrics = lyrics;
        S.lyricsOn = !!(wantLyrics && lyrics.ready && lyrics.songId === this.songId);

        // ---- Environment ----
        try {
            env.update(S);
            this.conductor.settle(dt);
            env.render(S);
        } catch (e) {
            Logger.error('LightShow render error:', e);
        }
        this._syncHud(prefs);
    }

    /**
     * The show is still struggling at the lowest auto quality: offer low power
     * on stage. The card stays until it is answered (once per session).
     */
    _hintLowPower() {
        this._slowFor = -Infinity;
        if (this._lpPending) return;
        try {
            if (sessionStorage.getItem(SLOW_HINT_KEY)) return;
        } catch (e) { /* offer it anyway */ }
        this._lpPending = true;
        this._ensureLowPowerPrompt();
        this._lpPrompt.classList.remove('done');
        this._lpPrompt.classList.add('show');
    }

    _ensureLowPowerPrompt() {
        if (this._lpPrompt || !this.container) return;
        const el = document.createElement('div');
        el.className = 'ls-lp-prompt';
        el.setAttribute('role', 'status');
        el.innerHTML = `<p class="ls-lp-ask"><b>${t('The light show is running slowly on this device.')}</b>`
            + ` ${t('Low Performance Mode keeps it smooth with lighter effects.')}</p>`
            + `<p class="ls-lp-done"><b>${t('Low Performance Mode is on.')}</b> ${t('You can change it in Settings → Light Show.')}</p>`
            + `<div class="ls-lp-actions"><button type="button" class="ls-lp-later">${t('Not now')}</button>`
            + `<button type="button" class="ls-lp-on">${t('Turn on')}</button></div>`;
        const answer = (on) => {
            this._lpPending = false;
            try { sessionStorage.setItem(SLOW_HINT_KEY, '1'); } catch (e) { /* ignore */ }
            if (!on) {
                el.classList.remove('show');
                return;
            }
            try { localStorage.setItem(LOW_POWER_KEY, '1'); } catch (e) { /* ignore */ }
            this._prefsAt = -1;   // apply on the next frame
            el.classList.add('done');
            clearTimeout(this._lpTimer);
            this._lpTimer = setTimeout(() => el.classList.remove('show'), 4000);
        };
        el.querySelector('.ls-lp-later').addEventListener('click', (e) => { e.stopPropagation(); answer(false); });
        el.querySelector('.ls-lp-on').addEventListener('click', (e) => { e.stopPropagation(); answer(true); });
        this.container.appendChild(el);
        this._lpPrompt = el;
    }

    // ------------------------------------------------------------------ HUD

    _ensureHud() {
        if (this._hud || !this.container) return;
        const el = document.createElement('div');
        el.className = 'ls-hud';
        el.innerHTML = '<span class="ls-hud-side ls-hud-l"><b></b><small>BPM</small></span>'
            + '<span class="ls-hud-mid">'
            + `<button type="button" class="ls-hud-btn ls-hud-env" hidden>${ENV_ICON}</button>`
            + `<button type="button" class="ls-hud-btn ls-hud-lyrics" title="${t('Lyrics on stage')}" aria-pressed="false">${MIC_ICON}</button>`
            + `<button type="button" class="ls-hud-btn ls-hud-queue" title="${t('Up Next')}" aria-pressed="false" hidden>${QUEUE_ICON}</button>`
            + '</span>'
            + '<span class="ls-hud-side ls-hud-r"><span class="ls-hud-meta"></span></span>';
        el.querySelector('.ls-hud-lyrics').addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleStageLyrics();
        });
        el.querySelector('.ls-hud-env').addEventListener('click', (e) => {
            e.stopPropagation();
            this._nextEnvironment();
        });
        el.querySelector('.ls-hud-queue').addEventListener('click', (e) => {
            e.stopPropagation();
            this.container.classList.toggle('ls-queue-peek');
        });
        this.container.appendChild(el);
        this._hud = el;
    }

    /** Environments this device can run (and that have not failed here). */
    _usableEnvironments() {
        return ENVIRONMENT_IDS.filter((id) => resolveEnvironment(id, this._envFailed) === id);
    }

    /** The HUD's environment button: on to the next one, and remember it. */
    _nextEnvironment() {
        const usable = this._usableEnvironments();
        if (usable.length < 2) return;
        const id = usable[(usable.indexOf(this._envWanted) + 1) % usable.length];
        if (window.app && window.app.savePreferences) window.app.savePreferences({ lightshow_environment: id });
        this._prefsAt = -1;   // picked up on the next frame
        window.showToast?.(t('Environment: {name}', { name: t(ENVIRONMENTS[id].name) }), 'info');
        this._renderHud(true);
    }

    _toggleStageLyrics() {
        const on = !this.stageLyrics;
        this.stageLyrics = on;
        this._renderHud(true);
        const songId = this.songId;
        if (!on || !songId) return;
        this.lyrics.load(songId).then(() => {
            if (this.stageLyrics && this.songId === songId && this.lyrics.songId === songId && !this.lyrics.ready) {
                window.showToast?.('No synced lyrics for this song', 'info');
            }
        });
    }

    _syncHud(prefs) {
        const hud = this._hud;
        const btn = hud && hud.querySelector('.ls-hud-lyrics');
        if (!btn) return;
        // The settings toggle decides whether stage lyrics are offered at all.
        btn.hidden = !prefs.stageLyrics;
        const on = !!prefs.stageLyrics && this.stageLyrics;
        const pressed = String(on);
        if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
        const missing = on && !this.lyrics.ready;
        btn.classList.toggle('missing', missing);

        // The environment button is only there when there is a choice.
        const env = hud.querySelector('.ls-hud-env');
        env.hidden = this._usableEnvironments().length < 2;
        if (this.envId && env.dataset.env !== this.envId) {
            env.dataset.env = this.envId;
            env.title = t('Environment: {name}', { name: t(ENVIRONMENTS[this.envId].name) });
        }
        // An immersive environment folds the queue away: this button brings it back over the show.
        const queue = hud.querySelector('.ls-hud-queue');
        queue.hidden = !(this.env && this.env.layout === 'immersive');
        const peek = String(!queue.hidden && this.container.classList.contains('ls-queue-peek'));
        if (queue.getAttribute('aria-pressed') !== peek) queue.setAttribute('aria-pressed', peek);
        // Compact, the HUD is just its buttons.
        const n = (btn.hidden ? 0 : 1) + (env.hidden ? 0 : 1) + (queue.hidden ? 0 : 1);
        if (n !== this._hudButtons) {
            this._hudButtons = n;
            hud.style.setProperty('--ls-hud-mid', `${Math.max(0, n * HUD_BTN + (n - 1) * HUD_GAP)}px`);
        }
    }

    _setStatus(status, force = false) {
        const changed = force || status !== this.status;
        this.status = status;
        if (changed) this._renderHud(true);
    }

    /** The environment says where the HUD sits: top centre, or on some axis of its layout. */
    _alignHud(now) {
        const hud = this._hud;
        if (!hud || now - (this._hudAxisAt || 0) < 0.2) return;
        this._hudAxisAt = now;
        const x = this.env.hudAxis(now);
        if (x === undefined) return;
        if (x === null) {
            // Plain show: pinned to the top centre of the screen.
            if (this._hudX !== null) {
                this._hudX = null;
                hud.style.left = '';
                hud.classList.remove('stage-pos');
            }
            return;
        }
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
            meta = t(GENRE_NAMES[this.score.profile.genre] || 'Synced');
        } else if (this.status === 'analysing') meta = t('Analysing song');
        else if (this.status === 'loading') meta = t('Loading show');
        else meta = t('Live');
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

function readLowPower() {
    try {
        return localStorage.getItem(LOW_POWER_KEY) === '1';
    } catch (e) {
        return false;
    }
}
