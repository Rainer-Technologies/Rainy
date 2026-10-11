/**
 * Voyage environment — fly through the song.
 *
 * The song is a road (see world.js): the land on both sides is its
 * envelopes, so what lies ahead is the music that is about to play. Drawn
 * with three.js in HDR and finished in post.js.
 *
 *  - Sky      — horizon in the coming section's colour, stars, nebula, aurora.
 *  - Terrain  — the envelopes as a landscape, kicks rolling over it as rings.
 */
import { clamp, lerp } from '../../palette.js';
import { THREE, createGlobals, setLinear, blankTexture, rowsTexture } from './glsl.js';
import {
    speedFor, bakeEnvelopes, bakePalettes, sectionPalettes, lastEvent, lastHits, LABEL_HEAT, PAL_COLS,
} from './world.js';
import { Post } from './post.js';
import { Sky } from './sky.js';
import { Terrain } from './terrain.js';

// Per quality tier: bloom depth and the extras that go first.
const TIERS = [
    { levels: 5, speedBlur: true },
    { levels: 4, speedBlur: false },
    { levels: 3, speedBlur: false },
];

export class VoyageEnvironment {
    static id = 'voyage';

    constructor() {
        this.container = null;
        this.canvas = null;
        this.renderer = null;
        this.onFatal = null;
        this.score = null;
        this.track = null;
        this._baked = undefined;     // score the world was last built from (null = live)
        this._bakedHue = -1;
        this._textures = [];
        this._tier = -1;
        this._lowPower = false;
        this._w = 0;
        this._h = 0;
        this._heat = 0.4;
        this._dead = false;
    }

    /**
     * @param {object} o
     * @param {HTMLElement} o.container       fullscreen container
     * @param {HTMLCanvasElement} o.canvas    the classic environment's canvas (ours goes right after it)
     * @param {(err: Error) => void} o.onFatal  the environment cannot go on (context lost, broken shader)
     */
    mount({ container, canvas, onFatal }) {
        this.container = container;
        this.onFatal = onFatal;
        const el = document.createElement('canvas');
        el.className = 'ls-voyage-canvas';
        el.setAttribute('aria-hidden', 'true');
        canvas.after(el);
        this.canvas = el;

        const renderer = new THREE.WebGLRenderer({
            canvas: el, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance',
        });
        if (!renderer.capabilities.isWebGL2) {
            renderer.dispose();
            el.remove();
            throw new Error('WebGL 2 is not available');
        }
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // post.js encodes for the screen
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.setPixelRatio(1);
        renderer.setClearColor(0x000000, 1);
        renderer.debug.onShaderError = (gl, program, vs, fs) => {
            const log = gl.getShaderInfoLog(vs) || gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(program);
            this._fail(new Error(`shader failed to compile: ${log}`));
        };
        this.renderer = renderer;
        this._onLost = (e) => {
            e.preventDefault();
            this._fail(new Error('WebGL context lost'));
        };
        el.addEventListener('webglcontextlost', this._onLost);

        this.globals = createGlobals();
        this._blank = blankTexture(0, 0, 0, 0);
        this.globals.uEnvA.value = this._blank;
        this.globals.uEnvB.value = this._blank;
        this.globals.uPal.value = this._blank;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 3000);
        this.sky = new Sky(this.globals);
        this.terrain = new Terrain(this.globals);
        this.scene.add(this.sky.mesh, this.terrain.mesh);
        this.post = new Post(renderer);

        // Fade in (the reflow commits the transparent start of the transition).
        void el.offsetWidth;
        el.classList.add('on');
    }

    _fail(err) {
        if (this._dead) return;
        this._dead = true;
        if (this.onFatal) this.onFatal(err);
    }

    leave() {
        if (this.canvas) this.canvas.classList.remove('on');
    }

    unmount() {
        this._dead = true;
        const el = this.canvas;
        if (!el) return;
        el.removeEventListener('webglcontextlost', this._onLost);
        this._disposeWorld();
        this._blank.dispose();
        this.sky.dispose();
        this.terrain.dispose();
        this.post.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        el.remove();
        this.canvas = null;
        this.renderer = null;
    }

    setScore(score) {
        this.score = score || null;
    }

    setTrack(track) {
        this.track = track || null;
    }

    onTrackChange() { /* the world is rebuilt when the new score (or none) arrives */ }

    resize(cssW, cssH, { tier, lowPower, scale }) {
        const w = Math.max(2, Math.round(cssW * scale));
        const h = Math.max(2, Math.round(cssH * scale));
        if (w === this._w && h === this._h && tier === this._tier && lowPower === this._lowPower) return;
        this._w = w;
        this._h = h;
        this._tier = tier;
        this._lowPower = lowPower;
        this.renderer.setSize(w, h, false);
        this.post.setSize(w, h, lowPower ? TIERS[2] : TIERS[tier] || TIERS[2]);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.terrain.setQuality(lowPower ? 2 : tier);
        this.sky.setQuality(lowPower ? 2 : tier);
    }

    get lyricsOn() {
        return false;
    }

    dropLyrics() { /* no lyrics on this stage yet */ }

    hudAxis() {
        return null;
    }

    // ---------------------------------------------------------------- world

    _disposeWorld() {
        for (const tex of this._textures) tex.dispose();
        this._textures = [];
    }

    /** (Re)build the world when the score on stage or the accent colour changed. */
    _syncWorld(S) {
        const score = S.F.scripted ? this.score : null;
        const hue = Math.round(S.accentHue);
        if (score === this._baked && (!score || hue === this._bakedHue)) return;
        this._baked = score;
        this._bakedHue = hue;
        this._disposeWorld();
        const G = this.globals;
        if (!score) {
            G.uEnvA.value = G.uEnvB.value = G.uPal.value = this._blank;
            G.uScored.value = 0;
            G.uDuration.value = 1;
            G.uU.value = speedFor(120);
            this.palettes = null;
            return;
        }
        const env = bakeEnvelopes(score);
        this.palettes = sectionPalettes(score, S.accentHue);
        const pal = bakePalettes(score, this.palettes, env.rows);
        const a = rowsTexture(env.a, 1, env.rows);
        const b = rowsTexture(env.b, 1, env.rows);
        const p = rowsTexture(pal, PAL_COLS, env.rows);
        this._textures.push(a, b, p);
        G.uEnvA.value = a;
        G.uEnvB.value = b;
        G.uPal.value = p;
        G.uScored.value = 1;
        G.uDuration.value = Math.max(1, score.duration);
        G.uU.value = speedFor(score.tempo);
    }

    // ---------------------------------------------------------------- frame

    update(S) {
        if (this._dead) return;
        this._syncWorld(S);
        const { F, dt } = S;
        const G = this.globals;
        const P = S.palette;
        const score = this._baked;
        const t = score ? S.t : S.now;

        G.uT.value = t;
        G.uNow.value = S.now % 3600;
        G.uDim.value = S.dim;
        G.uKick.value = S.pulse.k;
        G.uSnare.value = S.pulse.s;
        G.uHat.value = S.pulse.h;
        G.uRms.value = F.bands.rms;
        G.uSub.value = F.bands.sub;
        G.uBuild.value = F.buildProgress || 0;
        G.uStop.value = F.stopDepth || 0;
        const label = (F.section && F.section.label) || 'verse';
        this._heat = lerp(this._heat, LABEL_HEAT[label] ?? 0.45, F.jumped ? 1 : 1 - Math.exp(-dt / 0.5));
        G.uHeat.value = this._heat;
        setLinear(G.uPalA.value, P.a);
        setLinear(G.uPalB.value, P.b);
        setLinear(G.uPalC.value, P.c);
        setLinear(G.uPalW.value, P.w);
        setLinear(G.uDeep.value, P.deep);

        // The horizon takes the colour of the section that is coming.
        const next = score && F.nextSection && this.palettes ? this.palettes[F.nextSection.idx] : null;
        const near = next ? clamp(1 - (F.nextIn - 1) / 9, 0, 1) : 0;
        const hz = this._hz || (this._hz = [0, 0, 0]);
        for (let i = 0; i < 3; i++) hz[i] = lerp(lerp(P.deep[i], P.a[i], 0.55), next ? next.a[i] : P.a[i], near * near);
        setLinear(G.uHorizon.value, hz);

        // ---- Terrain ----
        const tu = this.terrain.uniforms;
        this.terrain.scroll(t * G.uU.value);
        tu.uThread.value = Math.max(0.12, F.stopDepth || 0);
        const kicks = score ? lastHits(score, 'k', t, 4) : null;
        for (let i = 0; i < 4; i++) tu.uRing.value[i].set(kicks ? kicks[i][0] : -1e3, kicks ? kicks[i][1] * S.I : 0, 0, 0);
        const drop = score ? lastEvent(score, 'drop', t, 6) : null;
        tu.uShock.value.set(drop ? drop.t : -1e3, drop ? 1 : 0, 0, 0);

        // ---- Sky ----
        const su = this.sky.uniforms;
        const quiet = label === 'breakdown' || label === 'intro' || label === 'outro';
        su.uAurora.value = lerp(su.uAurora.value, quiet ? 1 : 0, 1 - Math.exp(-dt / 1.5));
        su.uEnergy.value = lerp(su.uEnergy.value, F.bands.rms * (0.4 + this._heat), 1 - Math.exp(-dt / 0.4));
        su.uLightning.value = label === 'drop' ? S.pulse.s * S.I * (S.prefs.reduceFlashing ? 0.25 : 1) : 0;

        // ---- Camera ----
        const cam = this.camera;
        const sway = Math.sin(F.bar * Math.PI / 2);
        cam.position.set(1.6 * sway, 3.4 + 0.3 * Math.sin(S.now * 0.4), 0);
        cam.up.set(0, 1, 0);
        cam.lookAt(0.4 * sway, 5, -80);
        cam.rotateZ(-0.03 * sway);
        this.sky.follow(cam);
    }

    render(S) {
        if (this._dead || !this.post.sceneTarget) return;
        const u = this.post.uniforms;
        const soft = S.prefs.showBgBlur && !S.prefs.lowPower;
        u.uNow.value = S.now % 60;
        u.uBloom.value = (soft ? 1.5 : 1.1) / this.post.levels * (0.7 + 0.5 * S.I);
        u.uSoft.value = soft ? 0.35 : 0;
        u.uExposure.value = 1.05;
        u.uCA.value = S.prefs.reduceFlashing ? 0 : 0.006 * S.pulse.k * S.I + 0.02 * S.burstAmt;
        u.uSpeed.value = S.F.buildProgress || 0;
        u.uFlash.value = S.flashAmt;
        setLinear(u.uFlashCol.value, S.flashColor);
        u.uBlind.value = S.blinderAmt * S.dim;
        setLinear(u.uBlindCol.value, S.palette.w);
        this.post.render(this.scene, this.camera);
    }
}
