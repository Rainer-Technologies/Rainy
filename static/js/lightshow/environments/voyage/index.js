/**
 * Voyage environment — fly through the song.
 *
 * The song is a road (see world.js): the land on both sides is its
 * envelopes, so what lies ahead is the music that is about to play. Drawn
 * with three.js in HDR and finished in post.js.
 *
 *  - Sky       — horizon in the coming section's colour, stars, nebula, aurora.
 *  - Sun       — the album cover at the end of the road; eclipsed in a silence.
 *  - Terrain   — the envelopes as a landscape (or islands in a sea), kicks
 *                rolling over it as rings, a drop as one shockwave.
 *  - Gates     — one per beat, crossed on the beat; portals at section changes.
 *  - Beams     — the rig: lasers and searchlights, a pattern per section.
 *  - Particles — dust, speed streaks, bursts.
 *  - Camera    — a shot per section and phrase (camera.js).
 *
 * Skins (skins.js) restyle all of it per genre profile.
 */
import { clamp, lerp } from '../../palette.js';
import { THREE, createGlobals, setLinear, blankTexture, rowsTexture } from './glsl.js';
import {
    FAR, GATE, LABEL_HEAT, PAL_COLS, speedFor, bakeEnvelopes, bakePalettes, sectionPalettes,
    buildGates, gateWindow, buildPortals, lastEvent, lastHits,
} from './world.js';
import { Post } from './post.js';
import { Sky } from './sky.js';
import { Sun } from './sun.js';
import { Terrain } from './terrain.js';
import { Gates, Portals } from './gates.js';
import { Beams } from './beams.js';
import { Particles } from './particles.js';
import { Cinematographer } from './camera.js';
import { skinFor } from './skins.js';

// Per quality tier: bloom depth, the extras that go first, how much of the rig is lit.
const TIERS = [
    { levels: 5, speedBlur: true, beams: 1 },
    { levels: 4, speedBlur: false, beams: 0.85 },
    { levels: 3, speedBlur: false, beams: 0.6 },
];
const ROAD_W = 6.5;

export class VoyageEnvironment {
    static id = 'voyage';

    constructor() {
        this.container = null;
        this.canvas = null;
        this.renderer = null;
        this.onFatal = null;
        this.score = null;
        this.track = null;
        this.skin = skinFor('pop');
        this.world = null;           // { gates, portals, palettes } of the score on stage
        this._baked = undefined;     // score the world was last built from (null = live)
        this._bakedHue = -1;
        this._textures = [];
        this._tier = -1;
        this._lowPower = false;
        this._w = 0;
        this._h = 0;
        this._heat = 0.4;
        this._dead = false;
        this._liveDrop = -1e3;       // when the live source last called a drop (wall clock)
        this._colA = new THREE.Vector3();
        this._colB = new THREE.Vector3();
        this._hz = [0, 0, 0];
        this._still = false;
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
        this._motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

        const G = this.globals = createGlobals();
        this._blank = blankTexture(0, 0, 0, 0);
        G.uEnvA.value = G.uEnvB.value = G.uPal.value = this._blank;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 3000);
        this.sky = new Sky(G);
        this.sun = new Sun(G);
        this.terrain = new Terrain(G);
        this.gates = new Gates(G);
        this.portals = new Portals(G);
        this.beams = new Beams(G);
        this.particles = new Particles(G);
        this.cine = new Cinematographer();
        this.scene.add(this.sky.mesh, this.sun.mesh, this.terrain.mesh, this.gates.mesh, this.portals.group,
            this.beams.mesh, this.particles.group);
        this.post = new Post(renderer);
        this.sun.setCover(this.track && this.track.cover);

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
        for (const part of [this.sky, this.sun, this.terrain, this.gates, this.portals, this.beams, this.particles, this.post]) part.dispose();
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
        if (this.sun) this.sun.setCover(this.track && this.track.cover);
    }

    onTrackChange() {
        if (!this.cine) return;
        this.cine.reset();
        this.beams.reset();
        this.particles.clearBursts();
        this._liveDrop = -1e3;
    }

    resize(cssW, cssH, { tier, lowPower, scale }) {
        const w = Math.max(2, Math.round(cssW * scale));
        const h = Math.max(2, Math.round(cssH * scale));
        if (w === this._w && h === this._h && tier === this._tier && lowPower === this._lowPower) return;
        this._w = w;
        this._h = h;
        this._tier = tier;
        this._lowPower = lowPower;
        const q = lowPower ? 2 : clamp(tier, 0, 2);
        this.renderer.setSize(w, h, false);
        this.post.setSize(w, h, TIERS[q]);
        this.camera.aspect = w / h;
        this.terrain.setQuality(q);
        this.sky.setQuality(q);
        this.particles.setQuality(q);
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
        this.cine.reset();
        this.beams.reset();
        this.particles.clearBursts();
        const G = this.globals;
        if (!score) {
            G.uEnvA.value = G.uEnvB.value = G.uPal.value = this._blank;
            G.uScored.value = 0;
            G.uDuration.value = 1;
            G.uU.value = speedFor(120);
            this.world = null;
            return;
        }
        const env = bakeEnvelopes(score);
        const palettes = sectionPalettes(score, S.accentHue);
        const pal = bakePalettes(score, palettes, env.rows);
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
        this.world = { palettes, gates: buildGates(score), portals: buildPortals(score) };
    }

    // ---------------------------------------------------------------- frame

    update(S) {
        if (this._dead) return;
        this._syncWorld(S);
        const { F, dt, prefs } = S;
        const G = this.globals;
        const P = S.palette;
        const score = this._baked;
        const world = this.world;
        // Without a score the road is laid as it is flown: the wall clock is its time.
        const t = score ? S.t : S.now % 1800;
        const U = G.uU.value;
        const label = (F.section && F.section.label) || 'verse';
        const skin = this.skin = skinFor((F.profile && F.profile.genre) || 'pop');
        const q = TIERS[this._lowPower ? 2 : clamp(this._tier, 0, 2)];
        this._still = prefs.reduceFlashing || !!(this._motion && this._motion.matches);

        // ---- The state of the show, for every shader ----
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
        G.uFogK.value = skin.fog;
        this._heat = lerp(this._heat, LABEL_HEAT[label] ?? 0.45, F.jumped ? 1 : 1 - Math.exp(-dt / 0.5));
        G.uHeat.value = this._heat;
        setLinear(G.uPalA.value, P.a);
        setLinear(G.uPalB.value, P.b);
        setLinear(G.uPalC.value, P.c);
        setLinear(G.uPalW.value, P.w);
        setLinear(G.uDeep.value, P.deep);
        // The horizon takes the colour of the section that is coming.
        const next = world && F.nextSection ? world.palettes[F.nextSection.idx] : null;
        const near = next ? clamp(1 - (F.nextIn - 1) / 9, 0, 1) : 0;
        const hz = this._hz;
        for (let i = 0; i < 3; i++) hz[i] = lerp(lerp(P.deep[i], P.a[i], 0.55), next ? next.a[i] : P.a[i], near * near);
        setLinear(G.uHorizon.value, hz);

        // ---- Events: what the score says just happened ----
        // A drop and an impact are read from the score by time, not caught as they fire,
        // so their shockwave and sparks are still where they should be after a seek.
        let drop = score ? lastEvent(score, 'drop', t, 6) : null;
        const impact = score ? lastEvent(score, 'impact', t, 3) : null;
        for (const ev of F.events) {
            if (ev.type === 'drop') {
                S.flash(1, P.w);
                S.burst(1);
                if (!score) this._liveDrop = t;
            } else if (ev.type === 'impact') {
                S.flash(0.45, P.w);
                S.burst(0.5);
            }
        }
        if (!score && t - this._liveDrop < 6) drop = { t: this._liveDrop };
        const dropAge = drop ? t - drop.t : -1;
        // In a drop the snare cracks the sky (the flash itself goes through the limiter).
        if (S.running && label === 'drop' && F.hits.s >= 0.5) S.flash(0.16 * S.I * F.hits.s * skin.lightning, P.w);

        // ---- Terrain ----
        const tu = this.terrain.uniforms;
        this.terrain.scroll(t * U);
        tu.uRoadW.value = ROAD_W;
        tu.uAmp.value = skin.amp;
        tu.uRough.value = skin.rough;
        tu.uCell.value = skin.cell;
        tu.uGridGain.value = skin.grid;
        tu.uSea.value = skin.sea * skin.amp;
        tu.uThread.value = Math.max(0.1, F.stopDepth || 0);
        const kicks = score ? lastHits(score, 'k', t, 4) : null;
        for (let i = 0; i < 4; i++) tu.uRing.value[i].set(kicks ? kicks[i][0] : -1e3, kicks ? kicks[i][1] * S.I : 0, 0, 0);
        tu.uShock.value.set(drop ? drop.t : -1e3, drop ? 1 : 0, 0, 0);

        // ---- Sky and sun ----
        const su = this.sky.uniforms;
        const quiet = label === 'breakdown' || label === 'intro' || label === 'outro';
        su.uStars.value = skin.stars;
        su.uNebula.value = skin.nebula;
        su.uAurora.value = lerp(su.uAurora.value, quiet ? skin.aurora : 0.12 * skin.aurora, 1 - Math.exp(-dt / 1.5));
        su.uEnergy.value = lerp(su.uEnergy.value, F.bands.rms * (0.4 + this._heat), 1 - Math.exp(-dt / 0.4));
        su.uLightning.value = label === 'drop' ? S.pulse.s * S.I * skin.lightning * (prefs.reduceFlashing ? 0.25 : 1) : 0;
        const sunU = this.sun.uniforms;
        sunU.uStripes.value = skin.sunStripes;
        sunU.uPulse.value = clamp(0.55 * F.bands.sub + 0.6 * S.pulse.k * S.I, 0, 1);

        // ---- Gates: the beat grid, standing on the road ----
        const gates = this.gates;
        const ahead = FAR / U, behind = 0.35;
        gates.begin();
        if (world) {
            const [i0, i1] = gateWindow(world.gates, t - behind, t + ahead);
            const g = world.gates;
            for (let i = i0; i < i1; i++) gates.add(-(g.t[i] - t) * U, g.kind[i], g.power[i], g.t[i]);
        } else {
            // Live: the grid the source is guessing, a bar every four beats.
            const period = F.period || 0.5;
            const first = Math.ceil(F.beat - behind / period);
            for (let n = first; (n - F.beat) * period < ahead; n++) {
                const tau = t + (n - F.beat) * period;
                gates.add(-(tau - t) * U, ((n % 4) + 4) % 4 === 0 ? GATE.BAR : GATE.BEAT, 0.5, tau);
            }
        }
        gates.end();
        // The eight gates ahead light the road under them.
        const lit = tu.uGateZ.value;
        let n = 0;
        for (let i = 0; i < gates.count && n < 8; i++) {
            const z = gates.data[i * 4];
            if (z < 0.5) lit[n++].set(z, gates.data[i * 4 + 1], gates.data[i * 4 + 2], 0);
        }
        for (; n < 8; n++) lit[n].set(1e4, 0, 0, 0);
        gates.uniforms.uSides.value = skin.gate;
        gates.uniforms.uRot.value = skin.gateSpin * Math.PI * 2 * F.bar;

        // ---- Portals: the sections ----
        const portals = this.portals;
        portals.begin();
        if (world) {
            for (const p of world.portals) {
                if (p.t < t - 0.25 || p.t > t + ahead) continue;
                const pal = world.palettes[p.idx];
                portals.add(-(p.t - t) * U, setLinear(this._colA, pal.a), setLinear(this._colB, pal.b), p.drop);
            }
        }
        portals.end();

        // ---- Rig, particles ----
        this.beams.update(S, { on: !prefs.disableLasers, amount: skin.beams * q.beams });
        const streak = clamp(0.9 * (F.buildProgress || 0) + (dropAge >= 0 ? Math.exp(-dropAge * 1.2) : 0) + 0.25 * this._heat * F.bands.rms, 0, 1.4);
        const fovRad = (this.camera.fov * Math.PI) / 180;
        this.particles.update(t * U, this._still ? streak * 0.3 : streak, this._h / (2 * Math.tan(fovRad / 2)), skin.dust * (this._lowPower ? 0.6 : 1));
        if (drop && dropAge < 5) this._burstAt(0, drop.t, [0, 9, -10], P.w, 1, 3.2);
        if (impact) this._burstAt(1, impact.t, [0, 12, -40], P.a, 0.6, 2);

        // ---- Camera ----
        const pose = this.cine.update(S, { fly: skin.fly, low: skin.low, still: this._still, dropAge });
        const cam = this.camera;
        cam.position.set(pose.x, pose.y, pose.z);
        cam.up.set(0, 1, 0);
        cam.lookAt(pose.lx, pose.ly, pose.lz);
        cam.rotateZ(pose.roll);
        if (Math.abs(cam.fov - pose.fov) > 0.01) {
            cam.fov = pose.fov;
            cam.updateProjectionMatrix();
        } else if (cam.aspect !== this._aspect) cam.updateProjectionMatrix();
        this._aspect = cam.aspect;
        this.sky.follow(cam);
        this._dropAge = dropAge;
    }

    /** Keep a burst slot on a score event (set every frame: a burst is only its event's time). */
    _burstAt(slot, t, pos, rgb, power, life) {
        const u = this.particles.sparkU;
        u.uBurst.value[slot].set(t, power, life, 1);
        u.uBurstPos.value[slot].set(pos[0], pos[1], pos[2]);
        setLinear(u.uBurstCol.value[slot], rgb);
    }

    render(S) {
        if (this._dead || !this.post.sceneTarget) return;
        const u = this.post.uniforms;
        const prefs = S.prefs;
        const soft = prefs.showBgBlur && !prefs.lowPower;
        const hit = this._dropAge >= 0 ? Math.exp(-this._dropAge * 2) : 0;
        u.uNow.value = S.now % 60;
        u.uBloom.value = (soft ? 0.75 : 0.5) * (0.7 + 0.5 * S.I);
        u.uSoft.value = soft ? 0.35 : 0;
        u.uExposure.value = 1.05 + 0.25 * hit;
        u.uCA.value = this._still ? 0 : 0.006 * S.pulse.k * S.I + 0.03 * hit;
        u.uSpeed.value = this._still ? 0 : clamp((S.F.buildProgress || 0) + 0.8 * hit, 0, 1);
        u.uFlash.value = S.flashAmt;
        setLinear(u.uFlashCol.value, S.flashColor);
        u.uBlind.value = S.blinderAmt * S.dim;
        setLinear(u.uBlindCol.value, S.palette.w);
        this.post.render(this.scene, this.camera);
    }
}
