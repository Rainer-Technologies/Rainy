/**
 * Voyage particles: dust in the air, speed streaks and bursts.
 *
 * None of them carries state. Dust and streaks sit at `fract(seed + travelled)`
 * in a box that rides with the camera, and a burst is its event's time: every
 * spark is where its age says it is, computed in the vertex shader. So they
 * cost no CPU and a seek puts every particle where it belongs.
 */
import { THREE, GLSL_COMMON, setLinear } from './glsl.js';

const BOX = { x: 190, y: 60, z: 340 };
const DUST = [5200, 2800, 1300];        // per quality tier
const STREAKS = [520, 300, 140];
const SPARKS = [1600, 900, 400];
export const BURSTS = 4;                // bursts alive at once

const DUST_VERT = /* glsl */`
${GLSL_COMMON}
attribute vec3 aSeed;
uniform float uTravel, uSize;
varying float vTw, vMix, vFade;
void main() {
    vec3 p;
    p.x = (aSeed.x - 0.5) * ${BOX.x.toFixed(1)} + sin(uNow * 0.21 + aSeed.y * 40.0) * 1.6;
    p.y = aSeed.y * aSeed.y * ${BOX.y.toFixed(1)} + 0.4 + sin(uNow * 0.17 + aSeed.x * 31.0) * 0.8;
    p.z = mod(aSeed.z * ${BOX.z.toFixed(1)} + uTravel, ${BOX.z.toFixed(1)}) - ${(BOX.z - 16).toFixed(1)};
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = max(1.0, -mv.z);
    gl_PointSize = clamp((0.9 + 2.4 * aSeed.x * aSeed.z) * uSize / depth, 1.0, 16.0);
    float twinkle = 0.45 + 0.55 * sin(uNow * (1.0 + 4.0 * aSeed.y) + aSeed.z * 50.0);
    vTw = twinkle + 1.6 * uHat * step(0.75, fract(aSeed.x * 7.3));
    vMix = fract(aSeed.x * 3.7 + aSeed.z);
    vFade = smoothstep(${(BOX.z - 16).toFixed(1)}, ${(BOX.z * 0.55).toFixed(1)}, depth) * smoothstep(0.6, 5.0, depth);
}`;

const DUST_FRAG = /* glsl */`
${GLSL_COMMON}
varying float vTw, vMix, vFade;
void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d);
    vec3 col = mix(mix(uPalA, uPalB, step(0.6, vMix)), uPalW, 0.35) * a * vTw * vFade * 0.5;
    gl_FragColor = vec4(col * uDim, 1.0);
}`;

const STREAK_VERT = /* glsl */`
${GLSL_COMMON}
attribute vec4 aSeed;     // xyz = seed, w = 0 for the head, 1 for the tail
uniform float uTravel, uStreak;
varying float vA;
void main() {
    vec3 p;
    p.x = (aSeed.x - 0.5) * ${BOX.x.toFixed(1)};
    p.y = aSeed.y * ${(BOX.y * 0.8).toFixed(1)} + 0.3;
    p.z = mod(aSeed.z * ${BOX.z.toFixed(1)} + uTravel * 1.6, ${BOX.z.toFixed(1)}) - ${(BOX.z - 16).toFixed(1)};
    // The tail trails behind: the faster the world feels, the longer it is.
    p.z -= aSeed.w * uStreak * (10.0 + 46.0 * aSeed.x);
    // Keep the road clear.
    p.x += sign(p.x) * 5.0;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = -mv.z;
    vA = (1.0 - aSeed.w) * uStreak * smoothstep(${(BOX.z - 16).toFixed(1)}, 120.0, depth) * smoothstep(1.0, 12.0, depth);
}`;

const STREAK_FRAG = /* glsl */`
${GLSL_COMMON}
varying float vA;
void main() {
    gl_FragColor = vec4(mix(uPalA, uPalW, 0.6) * vA * 0.9 * uDim, 1.0);
}`;

const SPARK_VERT = /* glsl */`
${GLSL_COMMON}
attribute vec4 aDir;      // xyz = direction, w = speed 0..1
attribute float aSlot;
uniform vec4 uBurst[${BURSTS}];       // x = media time it went off, y = power, z = life (s), w = 1 if it stays in the world
uniform vec3 uBurstPos[${BURSTS}];    // where (camera space, at that time)
uniform vec3 uBurstCol[${BURSTS}];
uniform float uSize;
varying vec3 vCol;
varying float vA;
void main() {
    int s = int(aSlot + 0.5);
    vec4 b = uBurst[s];
    float age = uT - b.x;
    float life = b.z * (0.5 + 0.5 * aDir.w);
    if (age < 0.0 || age > life || b.y <= 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        vA = 0.0;
        vCol = vec3(0.0);
        return;
    }
    // Fast out, then drag; a little gravity; and the world keeps scrolling under it.
    float reach = (1.0 - exp(-age * 2.6)) * (22.0 + 60.0 * aDir.w) * b.y;
    vec3 p = uBurstPos[s] + aDir.xyz * reach + vec3(0.0, -5.0 * age * age, age * uU * b.w);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float k = 1.0 - age / life;
    gl_PointSize = clamp((1.2 + 2.6 * aDir.w) * uSize * k / max(1.0, -mv.z), 1.0, 9.0);
    vA = k * k * (0.6 + 0.8 * b.y);
    vCol = mix(uBurstCol[s], vec3(1.0), 0.35 * k);
}`;

const SPARK_FRAG = /* glsl */`
${GLSL_COMMON}
varying vec3 vCol;
varying float vA;
void main() {
    float d = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(vCol * smoothstep(0.5, 0.0, d) * vA * max(uDim, 0.4), 1.0);
}`;

/** Deterministic 0..1 sequence, so every device builds the same sky of dust. */
function rng(seed) {
    let a = seed | 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class Particles {
    constructor(globals) {
        const blend = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false };
        this.dustU = { ...globals, uTravel: { value: 0 }, uSize: { value: 300 } };
        this.streakU = { ...globals, uTravel: { value: 0 }, uStreak: { value: 0 } };
        this.sparkU = {
            ...globals,
            uSize: { value: 300 },
            uBurst: { value: Array.from({ length: BURSTS }, () => new THREE.Vector4(-1e3, 0, 1, 1)) },
            uBurstPos: { value: Array.from({ length: BURSTS }, () => new THREE.Vector3()) },
            uBurstCol: { value: Array.from({ length: BURSTS }, () => new THREE.Vector3(1, 1, 1)) },
        };
        this.dust = new THREE.Points(new THREE.BufferGeometry(),
            new THREE.ShaderMaterial({ vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, uniforms: this.dustU, ...blend }));
        this.streaks = new THREE.LineSegments(new THREE.BufferGeometry(),
            new THREE.ShaderMaterial({ vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG, uniforms: this.streakU, ...blend }));
        this.sparks = new THREE.Points(new THREE.BufferGeometry(),
            new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: this.sparkU, ...blend }));
        this.group = new THREE.Group();
        for (const [obj, order] of [[this.dust, 40], [this.streaks, 41], [this.sparks, 60]]) {
            obj.frustumCulled = false;
            obj.renderOrder = order;
            this.group.add(obj);
        }
        this.tier = -1;
        this._slot = 2;
        this.setQuality(0);
    }

    setQuality(tier) {
        if (tier === this.tier) return;
        this.tier = tier;
        const rand = rng(20261011);
        const nd = DUST[tier] || DUST[2], ns = STREAKS[tier] || STREAKS[2], nk = SPARKS[tier] || SPARKS[2];

        const dust = new Float32Array(nd * 3);
        for (let i = 0; i < dust.length; i++) dust[i] = rand();
        const streak = new Float32Array(ns * 2 * 4);
        for (let i = 0; i < ns; i++) {
            const x = rand(), y = rand(), z = rand();
            streak.set([x, y, z, 0, x, y, z, 1], i * 8);
        }
        const dir = new Float32Array(nk * 4), slot = new Float32Array(nk);
        for (let i = 0; i < nk; i++) {
            // Even directions on a sphere, leaning upwards.
            const u = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - u * u);
            dir.set([r * Math.cos(a), Math.abs(u) * 0.8 + 0.2 * u, r * Math.sin(a), rand()], i * 4);
            slot[i] = i % BURSTS;
        }
        const set = (obj, attrs) => {
            const geo = new THREE.BufferGeometry();
            for (const [name, arr, size] of attrs) geo.setAttribute(name, new THREE.BufferAttribute(arr, size));
            // three sizes the draw call from 'position'; these geometries are built from seeds instead.
            geo.setDrawRange(0, attrs[0][1].length / attrs[0][2]);
            obj.geometry.dispose();
            obj.geometry = geo;
        };
        set(this.dust, [['aSeed', dust, 3]]);
        set(this.streaks, [['aSeed', streak, 4]]);
        set(this.sparks, [['aDir', dir, 4], ['aSlot', slot, 1]]);
    }

    /**
     * @param {number} travelled  units of road behind the camera (t · U)
     * @param {number} streak     0..1, how fast the world should feel
     * @param {number} pixelsPerUnit  drawing-buffer pixels a unit covers at distance 1
     * @param {number} amount     dust density multiplier (skin)
     */
    update(travelled, streak, pixelsPerUnit, amount) {
        const wrap = (v, m) => ((v % m) + m) % m;
        this.dustU.uTravel.value = wrap(travelled, BOX.z);
        this.streakU.uTravel.value = wrap(travelled * 1.6, BOX.z) / 1.6;
        this.streakU.uStreak.value = streak;
        this.dustU.uSize.value = pixelsPerUnit * 0.22;
        this.sparkU.uSize.value = pixelsPerUnit * 0.3;
        const n = this.dust.geometry.getAttribute('aSeed').count;
        this.dust.geometry.setDrawRange(0, Math.round(n * Math.min(1, amount / 1.5)));
    }

    /**
     * Set off a burst (in one of the two slots the score's own events do not use).
     * @param {number} t      media time of the event (so it is where it should be after a seek)
     * @param {number[]} pos  camera-space position at that time
     * @param {number[]} rgb  0..255 colour
     * @param {number} power  0..1
     * @param {number} life   seconds
     * @param {boolean} [world=true]  stays in the world (the camera flies on past it)
     */
    burst(t, pos, rgb, power, life = 2.2, world = true) {
        const s = this._slot;
        this._slot = s === 2 ? 3 : 2;
        this.sparkU.uBurst.value[s].set(t, power, life, world ? 1 : 0);
        this.sparkU.uBurstPos.value[s].set(pos[0], pos[1], pos[2]);
        setLinear(this.sparkU.uBurstCol.value[s], rgb);
    }

    /** Forget every burst (a seek or a new song). */
    clearBursts() {
        for (const b of this.sparkU.uBurst.value) b.set(-1e3, 0, 1, 1);
    }

    dispose() {
        for (const obj of [this.dust, this.streaks, this.sparks]) {
            obj.geometry.dispose();
            obj.material.dispose();
        }
    }
}
