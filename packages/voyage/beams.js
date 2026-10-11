/**
 * Voyage rig: lasers and searchlights in the sky over the road.
 *
 * Like the classic scenes, a pattern is a pure function of the musical frame
 * (beat and bar positions, not accumulated state), so the beams are locked to
 * the music and a seek lands on the same picture. The director picks a
 * pattern per section × genre, rotates alternates every 8-bar phrase and
 * crossfades.
 *
 * Space: camera at the origin looking down -Z, the road along Z, Y up.
 * A beam is { o: origin, d: direction (unit), len, w: width, c: colour, a: alpha }.
 */
import { TAU, clamp, lerp, smooth, altBeat } from '@rainy/lightshow';
import { THREE, GLSL_COMMON, setLinear } from './glsl.js';

export const MAX_BEAMS = 72;

const VERT = /* glsl */`
${GLSL_COMMON}
attribute vec4 aA;     // origin, length
attribute vec4 aB;     // direction, width
attribute vec4 aC;     // colour, alpha
varying float vAcross, vAlong, vAlpha;
varying vec3 vCol;
void main() {
    float along = position.y * 0.5 + 0.5;
    vec3 c = aA.xyz + aB.xyz * (along * aA.w);
    vec3 side = normalize(cross(aB.xyz, normalize(cameraPosition - c)));
    // A beam opens up a little as it goes.
    vec3 p = c + side * position.x * aB.w * (1.0 + 2.2 * along);
    vAcross = position.x;
    vAlong = along;
    vAlpha = aC.a;
    vCol = aC.rgb;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */`
${GLSL_COMMON}
varying float vAcross, vAlong, vAlpha;
varying vec3 vCol;
void main() {
    float x = vAcross * vAcross;
    float core = exp(-x * 22.0);
    float body = exp(-x * 3.5) * 0.3;
    float fade = pow(1.0 - vAlong, 1.4) * smoothstep(0.0, 0.015, vAlong);
    vec3 col = mix(vCol, vec3(1.0), core * 0.45) * (core + body) * fade * vAlpha;
    gl_FragColor = vec4(col * uDim, 1.0);
}`;

// ---------------------------------------------------------------- patterns

const norm = (x, y, z) => {
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
};
/** Direction from yaw (around Y, 0 = down the road) and pitch (0 = level, π/2 = straight up). */
const aim = (yaw, pitch) => [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];

/** Slow searchlights from the horizon. */
function ambient(F, P, o, out) {
    const slow = F.t * 0.18, br = 0.5 + 0.5 * F.bands.harm;
    [-150, -60, 60, 150].forEach((x, i) => out.push({
        o: [x, 0, -330], d: aim(-x / 400 + 0.25 * Math.sin(slow + i * 1.7), 1.05 + 0.2 * Math.sin(slow * 0.7 + i)),
        len: 420, w: 2.2, c: i % 2 ? P.b : P.a, a: 0.16 * br,
    }));
}

/** Pairs from both sides of the road sweeping over it. */
function sweep(F, P, o, out) {
    const k = F.pulse.k, dir = o.variant % 2 ? -1 : 1;
    for (let i = 0; i < 6; i++) {
        const side = i % 2 ? 1 : -1;
        const z = -50 - 55 * Math.floor(i / 2);
        const sway = Math.sin(TAU * F.bar / 2 + i * 0.5 * dir);
        out.push({
            o: [side * 30, 0, z - 60], d: aim(-side * (0.25 + 0.35 * sway), 0.95 + 0.2 * sway),
            len: 300, w: 0.45 + 0.2 * F.bands.bass, c: i % 2 ? P.a : P.b, a: (0.18 + 0.35 * k) * (0.6 + 0.4 * F.bands.rms),
        });
    }
}

/** Beams crossing over the road, swapping on every beat. */
function cross(F, P, o, out) {
    const k = F.pulse.k, s = altBeat(F.beat), par = Math.floor(F.bar) & 1;
    for (let i = 0; i < 8; i++) {
        const side = i % 2 ? 1 : -1;
        const z = -40 - 45 * Math.floor(i / 2);
        const flip = Math.floor(i / 2) % 2 ? 1 : -1;
        out.push({
            o: [side * 34, 0, z - 70], d: aim(-side * (0.5 + 0.3 * s * flip), 0.75 + 0.15 * s * flip),
            len: 280, w: 0.42, c: (i + par) % 2 ? P.a : P.b, a: 0.2 + 0.35 * k,
        });
    }
}

/** A great fan from the end of the road, opening with the bass. */
function fan(F, P, o, out) {
    const k = F.pulse.k;
    const n = o.I > 0.7 ? 13 : 9;
    const spread = 0.9 + 0.8 * F.bands.bass;
    const lean = 0.25 * Math.sin(TAU * F.bar / 2);
    for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : i / (n - 1) - 0.5;
        out.push({
            o: [0, 2, -340], d: norm(Math.sin(u * spread + lean), Math.cos(u * spread + lean), 0.35),
            len: 460, w: 0.8, c: i % 2 ? P.a : P.c, a: 0.26 + 0.3 * k,
        });
    }
    const side = 0.35 + 0.25 * Math.sin(TAU * F.beat / 4);
    for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
            out.push({ o: [sx * 40, 0, -130], d: aim(-sx * (side + 0.18 * i), 0.7 + 0.12 * i), len: 320, w: 0.45, c: P.b, a: 0.2 + 0.25 * k });
        }
    }
}

/** Everything at once: fans from four corners and a wheel round the vanishing point. */
function storm(F, P, o, out) {
    const k = F.pulse.k, dir = o.variant % 2 ? -1 : 1;
    const swing = 0.45 * Math.sin(TAU * F.beat / 2);
    for (const sx of [-1, 1]) {
        for (let i = 0; i < 5; i++) {
            const u = i / 4 - 0.5;
            out.push({ o: [sx * 44, 0, -120], d: aim(-sx * (0.5 + swing * sx + u * 0.7), 0.6 + 0.25 * Math.abs(u)), len: 340, w: 0.5, c: sx < 0 ? P.a : P.b, a: 0.3 + 0.35 * k });
            out.push({ o: [sx * 120, 0, -300], d: aim(-sx * (0.3 - swing * sx + u * 0.5), 1.0 + 0.3 * u), len: 420, w: 0.9, c: P.c, a: 0.2 + 0.25 * k });
        }
    }
    if (o.I > 0.6) {
        const n = 14, turn = dir * TAU * F.bar / 2;
        for (let i = 0; i < n; i++) {
            const a = turn + (TAU * i) / n;
            out.push({ o: [0, 14, -360], d: norm(Math.sin(a), Math.cos(a), 0.55), len: 380, w: 0.6, c: P.w, a: 0.1 + 0.2 * F.bands.sub });
        }
    }
}

/** A build: wide beams that close in on the vanishing point as the tension climbs. */
function build(F, P, o, out) {
    const p = clamp(F.buildProgress, 0, 1), t = F.t;
    for (let i = 0; i < 10; i++) {
        const side = i % 2 ? 1 : -1;
        const z = -30 - 26 * Math.floor(i / 2);
        const open = lerp(0.7, 0.02, Math.pow(p, 0.8)) + 0.03 * p * Math.sin(t * 17 + i);
        out.push({
            o: [side * lerp(46, 10, p), 0, z - 70], d: aim(-side * open, lerp(0.95, 0.06, p)),
            len: 420, w: lerp(0.6, 0.3, p), c: i % 3 ? P.a : P.w, a: 0.15 + 0.5 * p,
        });
    }
}

/** A breakdown: a few soft pillars far away, barely moving. */
function float(F, P, o, out) {
    const t = F.t, harm = F.bands.harm;
    [-90, -30, 30, 90].forEach((x, i) => out.push({
        o: [x, 0, -260 - 20 * (i % 2)], d: aim(0.1 * Math.sin(t * 0.3 + i), 1.4 + 0.1 * Math.sin(t * 0.21 + i * 2)),
        len: 320, w: 3.2, c: i % 2 ? P.b : P.a, a: 0.07 + 0.1 * harm,
    }));
}

/** A wheel of light round the vanishing point, turning with the bars. */
function tunnel(F, P, o, out) {
    const k = F.pulse.k, dir = o.variant % 2 ? -1 : 1;
    const n = o.I > 0.7 ? 18 : 12;
    for (let i = 0; i < n; i++) {
        const a = dir * TAU * F.bar / 4 + (TAU * i) / n;
        out.push({ o: [0, 12, -370], d: norm(Math.sin(a), Math.cos(a), 0.7), len: 400, w: 0.6, c: i % 2 ? P.a : P.b, a: 0.12 + 0.28 * k });
    }
    for (const sx of [-1, 1]) {
        out.push({ o: [sx * 40, 0, -130], d: aim(-sx * 0.3, 0.5 + 0.1 * Math.sin(TAU * F.beat / 2)), len: 320, w: 0.5, c: P.c, a: 0.2 + 0.3 * k });
    }
}

export const PATTERNS = { ambient, sweep, cross, fan, storm, build, float, tunnel };

const TABLE = {
    edm:        { intro: ['ambient'], verse: ['sweep', 'cross'], build: ['build'], chorus: ['fan', 'tunnel'], drop: ['storm', 'tunnel', 'storm'], breakdown: ['float'], outro: ['ambient'] },
    pop:        { intro: ['ambient'], verse: ['sweep', 'cross'], build: ['build'], chorus: ['fan', 'tunnel'], drop: ['fan', 'storm'], breakdown: ['float'], outro: ['ambient'] },
    rock:       { intro: ['ambient'], verse: ['cross', 'sweep'], build: ['build'], chorus: ['fan', 'cross'], drop: ['storm', 'fan'], breakdown: ['float'], outro: ['ambient'] },
    hiphop:     { intro: ['ambient'], verse: ['cross', 'sweep'], build: ['build'], chorus: ['fan', 'cross'], drop: ['storm', 'fan'], breakdown: ['float'], outro: ['ambient'] },
    latin:      { intro: ['ambient'], verse: ['sweep', 'cross'], build: ['build'], chorus: ['fan', 'tunnel'], drop: ['storm', 'fan'], breakdown: ['float'], outro: ['ambient'] },
    chill:      { intro: ['ambient'], verse: ['ambient', 'float'], build: ['sweep'], chorus: ['sweep', 'float'], drop: ['sweep'], breakdown: ['float'], outro: ['ambient'] },
    orchestral: { intro: ['float'], verse: ['ambient'], build: ['sweep'], chorus: ['fan', 'ambient'], drop: ['fan'], breakdown: ['float'], outro: ['ambient'] },
};
const CALMER = { storm: 'fan', tunnel: 'sweep', build: 'sweep', fan: 'sweep' };

function pickPattern(genre, label, phrase, I) {
    const g = TABLE[genre] || TABLE.pop;
    let list = g[label] || g.verse;
    if (I > 0.85 && label === 'chorus') list = g.drop;
    let name = list[phrase % list.length];
    if (I < 0.35 && CALMER[name]) name = CALMER[name];
    return name;
}

// --------------------------------------------------------------------- rig

export class Beams {
    constructor(globals) {
        const quad = new THREE.PlaneGeometry(2, 2);
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = quad.index;
        geo.setAttribute('position', quad.getAttribute('position'));
        this.a = new Float32Array(MAX_BEAMS * 4);
        this.b = new Float32Array(MAX_BEAMS * 4);
        this.c = new Float32Array(MAX_BEAMS * 4);
        this.attrs = [this.a, this.b, this.c].map((arr, i) => {
            const attr = new THREE.InstancedBufferAttribute(arr, 4);
            attr.setUsage(THREE.DynamicDrawUsage);
            geo.setAttribute(['aA', 'aB', 'aC'][i], attr);
            return attr;
        });
        geo.instanceCount = 0;
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT, fragmentShader: FRAG, uniforms: { ...globals },
            blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 30;
        this.count = 0;
        this._col = new THREE.Vector3();
        this.reset();
    }

    reset() {
        this.key = '';
        this.cur = null;      // { name, variant }
        this.prev = null;
        this.mixStart = 0;
        this.mixDur = 0;
    }

    /**
     * Fill the rig for this frame.
     * @param {object} S        show state
     * @param {{ on: boolean, amount: number, extra?: object[] }} o  lasers allowed, how many (skin), follow beams to add
     */
    update(S, o) {
        const F = S.F, P = S.palette;
        this.count = 0;
        if (o.on) {
            const sec = F.section || { label: 'verse', idx: 0 };
            const genre = (F.profile && F.profile.genre) || 'pop';
            const name = pickPattern(genre, sec.label, S.phrase, S.I);
            const key = `${name}:${sec.idx}:${S.phrase}`;
            if (key !== this.key) {
                const sectionChanged = !this.cur || this.key.split(':')[1] !== String(sec.idx);
                this.prev = this.cur;
                this.cur = { name, variant: sec.idx + S.phrase };
                this.key = key;
                this.mixStart = F.t;
                if (F.jumped || !this.prev) this.mixDur = 0;
                else if (sec.label === 'drop' && sectionChanged) this.mixDur = 0.05;
                else this.mixDur = (sectionChanged ? 1 : 2) * (F.period || 0.5);
            }
            let mix = this.mixDur > 0 ? clamp((F.t - this.mixStart) / this.mixDur, 0, 1) : 1;
            if (F.t < this.mixStart) mix = 1;
            mix = smooth(mix);
            const boost = (1 + 0.6 * S.burstAmt) * o.amount;
            const opts = { I: S.I, genre };
            const list = [];
            PATTERNS[this.cur.name](F, P, { ...opts, variant: this.cur.variant }, list);
            this._push(list, mix * boost);
            if (mix < 1 && this.prev) {
                list.length = 0;
                PATTERNS[this.prev.name](F, P, { ...opts, variant: this.prev.variant }, list);
                this._push(list, (1 - mix) * boost);
            } else this.prev = null;
        }
        if (o.extra) this._push(o.extra, 1);
        this.mesh.geometry.instanceCount = this.count;
        for (const attr of this.attrs) attr.needsUpdate = true;
    }

    _push(list, k) {
        for (const beam of list) {
            const alpha = beam.a * k;
            if (alpha < 0.01 || this.count >= MAX_BEAMS) continue;
            const o = this.count++ * 4;
            const col = setLinear(this._col, beam.c);
            const A = this.a, B = this.b, C = this.c;
            A[o] = beam.o[0]; A[o + 1] = beam.o[1]; A[o + 2] = beam.o[2]; A[o + 3] = beam.len;
            B[o] = beam.d[0]; B[o + 1] = beam.d[1]; B[o + 2] = beam.d[2]; B[o + 3] = beam.w;
            C[o] = col.x; C[o + 1] = col.y; C[o + 2] = col.z; C[o + 3] = alpha;
        }
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
