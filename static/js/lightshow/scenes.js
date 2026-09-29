/**
 * Scene library + director.
 *
 * A scene is a pure function of the musical frame: (frame, palette, opts)
 * → "look" (what every fixture should do right now). Because looks are
 * computed from beat/bar positions instead of accumulated state, motion is
 * locked to the music by construction and a seek lands on the exact same
 * picture as uninterrupted playback.
 *
 * Coordinates are normalised: x 0..1 across, y 0 = top truss, 1 = floor.
 * Angles: 0 = pointing up, π = pointing down, positive = clockwise.
 *
 * The director picks a scene per section (label × genre profile), rotates
 * alternates every 8-bar phrase, and crossfades between looks.
 */
import { TAU, clamp, lerp, smooth, paletteFor } from './palette.js';

const PI = Math.PI;
export const N_PIX = 24;

/** Snap-and-hold motion: move during the first ~45% of each beat, then hold. */
const stepEase = (b) => {
    const i = Math.floor(b);
    return i + smooth(Math.min(1, (b - i) * 2.2));
};
/** ±1 alternating on every beat, with an eased swing between. */
const altBeat = (b) => Math.cos(PI * stepEase(b));
const hash = (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
};

function cells(fn) {
    const a = new Float32Array(N_PIX);
    for (let i = 0; i < N_PIX; i++) a[i] = clamp(fn(i, i / (N_PIX - 1)), 0, 1);
    return a;
}

/** Wrapped distance behind a chase head (for comet tails). */
const behind = (head, i) => (((head - i) % N_PIX) + N_PIX) % N_PIX;

function baseLook(P) {
    return {
        lasers: [],
        beams: [],
        wash: { l: 0, r: 0, top: 0, floor: 0, colL: P.a, colR: P.b, colTop: P.deep, colFloor: P.c },
        pixels: { cells: cells(() => 0), colA: P.a, colB: P.b, alpha: 0.6 },
        halo: { alpha: 0.2, r: 0.32, color: P.a },
        strobe: { snare: 0, kick: 0, bar: 0, sub: 0, subN: 1 },
        rings: { bar: 0, kick: 0 },
        blinders: { snare: 0, bar: 0 },
        sparks: 0,
        haze: 0.6,
        trail: 0.5,
    };
}

// ------------------------------------------------------------------ scenes

function ambient(F, P, o) {
    const L = baseLook(P);
    const t = F.t, br = 0.45 + 0.55 * F.bands.harm, slow = t * 0.22;
    [0.18, 0.39, 0.61, 0.82].forEach((x, i) => L.beams.push({
        x, y: 0, angle: PI + 0.38 * Math.sin(slow + i * 1.7), width: 0.075,
        alpha: 0.2 * br, color: i % 2 ? P.b : P.a,
    }));
    if (o.lasers && o.I > 0.35) {
        L.lasers.push({ x: 0.5, y: 1, angle: 0.12 * Math.sin(slow * 0.7), spread: 1.9, count: 14, alpha: 0.05 * br, thick: 0.8, color: P.c });
    }
    Object.assign(L.wash, { l: 0.2 * br, r: 0.2 * br, top: 0.06, floor: 0.18 * br });
    L.pixels = { cells: cells((i, u) => 0.25 + 0.25 * Math.sin(t * 0.9 + u * 6)), colA: P.a, colB: P.b, alpha: 0.45 * br };
    L.halo = { alpha: 0.18 + 0.35 * F.bands.rms, r: 0.34, color: P.a };
    L.haze = 0.75;
    L.trail = 0.78;
    return L;
}

function sweep(F, P, o) {
    const L = baseLook(P);
    const k = F.pulse.k, dir = o.variant % 2 ? -1 : 1;
    for (let i = 0; i < 6; i++) {
        const x = 0.1 + 0.8 * i / 5;
        const side = i < 3 ? -1 : 1;
        const sway = 0.5 + 0.5 * Math.sin(TAU * F.bar / 2 + i * 0.35 * dir);
        L.beams.push({
            x, y: 1, angle: side * (0.14 + 0.36 * sway), width: 0.05 + 0.02 * F.bands.bass,
            alpha: (0.2 + 0.42 * k) * (0.6 + 0.4 * F.bands.rms), color: i % 2 ? P.a : P.b,
        });
    }
    if (o.lasers) {
        const swing = 0.35 * Math.sin(TAU * F.bar / 4);
        const spread = 0.4 + 0.35 * F.bands.bass;
        L.lasers.push({ x: 0.02, y: 1, angle: 0.75 + swing, spread, count: 5, alpha: 0.26, thick: 1, color: P.c });
        L.lasers.push({ x: 0.98, y: 1, angle: -0.75 - swing, spread, count: 5, alpha: 0.26, thick: 1, color: P.c });
    }
    const head = (F.beat * 2) % N_PIX;
    L.pixels = { cells: cells((i) => Math.exp(-behind(head, i) * 0.45) + 0.1), colA: P.a, colB: P.b, alpha: 0.8 };
    Object.assign(L.wash, { l: 0.12 + 0.32 * k, r: 0.12 + 0.32 * k, floor: 0.15 + 0.2 * F.bands.bass });
    L.halo = { alpha: 0.25 + 0.4 * k, r: 0.3 + 0.05 * k, color: P.a };
    L.haze = 0.55;
    L.trail = 0.5;
    return L;
}

function cross(F, P, o) {
    const L = baseLook(P);
    const k = F.pulse.k, s = altBeat(F.beat), barPar = Math.floor(F.bar) & 1;
    [0.14, 0.37, 0.63, 0.86].forEach((x, i) => {
        const inward = x < 0.5 ? 1 : -1;
        const flip = i % 2 ? 1 : -1;
        L.beams.push({
            x, y: 0, angle: PI - inward * (0.32 + 0.22 * s * flip), width: 0.055,
            alpha: 0.24 + 0.4 * k, color: (i + barPar) % 2 ? P.a : P.b,
        });
    });
    if (o.lasers) {
        const sw = 0.4 * Math.sin(TAU * F.bar / 2);
        L.lasers.push({ x: 0, y: 0, angle: PI * 0.72 + sw, spread: 0.32, count: 4, alpha: 0.24, thick: 1, color: P.c });
        L.lasers.push({ x: 1, y: 0, angle: -PI * 0.72 - sw, spread: 0.32, count: 4, alpha: 0.24, thick: 1, color: P.c });
    }
    const head = N_PIX / 2 - 0.5 + (N_PIX / 2 - 1) * Math.sin(TAU * F.beat / 4);
    L.pixels = { cells: cells((i) => Math.exp(-((i - head) ** 2) / 6) + 0.08), colA: P.b, colB: P.a, alpha: 0.8 };
    Object.assign(L.wash, { l: 0.15 + 0.25 * k, r: 0.15 + 0.25 * k, top: 0.1, floor: 0.12 });
    L.halo = { alpha: 0.25 + 0.35 * k, r: 0.3, color: P.b };
    L.haze = 0.6 + 0.3 * F.pulse.h;
    L.trail = 0.5;
    return L;
}

function groove(F, P, o) {
    const L = baseLook(P);
    const k = Math.pow(F.pulse.k, 1.3), latin = o.genre === 'latin';
    const par = Math.floor(F.beat) & 1;
    [0.12, 0.3, 0.7, 0.88].forEach((x, i) => {
        const side = x < 0.5 ? -1 : 1;
        L.beams.push({
            x, y: 1, angle: side * (0.26 + 0.07 * (i % 2)), width: 0.06,
            alpha: 0.1 + 0.75 * k, color: latin ? ((i + par) % 2 ? P.a : P.b) : (i % 2 ? P.a : P.c),
        });
    });
    if (o.lasers) {
        L.lasers.push({ x: -0.02, y: 0.78, angle: PI / 2 - 0.03, spread: 0.18, count: 9, alpha: 0.12 + 0.4 * F.pulse.s, thick: 1, color: P.b });
        if (latin) L.lasers.push({ x: 1.02, y: 0.64, angle: -PI / 2 + 0.03, spread: 0.14, count: 7, alpha: 0.1 + 0.35 * F.pulse.s, thick: 1, color: P.c });
    }
    const level = F.bands.sub;
    L.pixels = {
        cells: cells((i) => (Math.abs(i - (N_PIX - 1) / 2) / ((N_PIX - 1) / 2) < level ? 1 : 0.07)),
        colA: P.a, colB: P.b, alpha: 0.85,
    };
    Object.assign(L.wash, { l: 0.12 + 0.3 * F.bands.bass, r: 0.12 + 0.3 * F.bands.bass, floor: 0.2 + 0.5 * k });
    L.halo = { alpha: 0.25 + 0.5 * k, r: 0.3 + 0.06 * k, color: P.a };
    L.strobe.snare = o.genre === 'hiphop' ? 0.15 : 0.1;
    L.rings.kick = 0.25;
    L.haze = 0.55;
    L.trail = 0.45;
    return L;
}

function fan(F, P, o) {
    const L = baseLook(P);
    const k = F.pulse.k, s = altBeat(F.beat);
    if (o.lasers) {
        L.lasers.push({
            x: 0.5, y: 1, angle: 0.3 * Math.sin(TAU * F.bar / 2), spread: 0.8 + 0.6 * F.bands.bass,
            count: o.I > 0.7 ? 13 : 9, alpha: 0.4, thick: 1.2, color: P.a,
        });
        const side = 0.35 + 0.25 * Math.sin(TAU * F.beat / 4);
        L.lasers.push({ x: 0.1, y: 1, angle: side, spread: 0.5, count: 5, alpha: 0.3, thick: 1, color: P.b });
        L.lasers.push({ x: 0.9, y: 1, angle: -side, spread: 0.5, count: 5, alpha: 0.3, thick: 1, color: P.b });
    }
    [0.15, 0.38, 0.62, 0.85].forEach((x, i) => {
        const inward = x < 0.5 ? 1 : -1;
        L.beams.push({
            x, y: 0, angle: PI - inward * (0.15 + 0.3 * (0.5 + 0.5 * s * (i % 2 ? 1 : -1))), width: 0.06,
            alpha: 0.28 + 0.42 * k, color: i % 2 ? P.c : P.b,
        });
    });
    const h1 = (F.beat * 2) % N_PIX, h2 = N_PIX - 1 - h1;
    L.pixels = {
        cells: cells((i) => Math.max(Math.exp(-behind(h1, i) * 0.5), Math.exp(-behind(i, h2) * 0.5)) + 0.1),
        colA: P.a, colB: P.b, alpha: 0.9,
    };
    Object.assign(L.wash, { l: 0.28 + 0.35 * F.bands.sub, r: 0.28 + 0.35 * F.bands.sub, top: 0.12, floor: 0.35 });
    L.halo = { alpha: 0.45 + 0.35 * k, r: 0.36, color: P.a };
    L.strobe.snare = 0.3;
    L.rings.bar = 0.6;
    L.blinders.bar = o.genre === 'rock' ? 0.4 : 0.15;
    L.haze = 0.7;
    L.trail = 0.4;
    return L;
}

function storm(F, P, o) {
    const L = baseLook(P);
    const k = F.pulse.k, dir = o.variant % 2 ? -1 : 1;
    const swing = 0.45 * Math.sin(TAU * F.beat / 2);
    if (o.lasers) {
        L.lasers.push({ x: 0, y: 1, angle: 0.6 + swing, spread: 0.7, count: 8, alpha: 0.48, thick: 1.2, color: P.a });
        L.lasers.push({ x: 1, y: 1, angle: -0.6 - swing, spread: 0.7, count: 8, alpha: 0.48, thick: 1.2, color: P.b });
        L.lasers.push({ x: 0, y: 0, angle: PI - 0.6 + swing, spread: 0.5, count: 6, alpha: 0.36, thick: 1, color: P.c });
        L.lasers.push({ x: 1, y: 0, angle: PI + 0.6 - swing, spread: 0.5, count: 6, alpha: 0.36, thick: 1, color: P.c });
        if (o.I > 0.6) {
            L.lasers.push({
                x: 0.5, y: 0.45, r0: 0.2, angle: dir * TAU * F.bar / 2, spread: TAU, count: 16,
                alpha: 0.14 + 0.22 * F.bands.sub, thick: 0.9, color: P.w,
            });
        }
    }
    const s = altBeat(F.beat);
    for (let i = 0; i < 4; i++) {
        const x = 0.12 + 0.76 * i / 3, side = x < 0.5 ? -1 : 1;
        L.beams.push({ x, y: 1, angle: side * (0.12 + 0.42 * (0.5 + 0.5 * s * (i % 2 ? 1 : -1))), width: 0.05, alpha: 0.3 + 0.45 * k, color: i % 2 ? P.a : P.b });
        L.beams.push({ x: 0.2 + 0.6 * i / 3, y: 0, angle: PI + 0.45 * s * (i % 2 ? 1 : -1), width: 0.045, alpha: 0.25 + 0.4 * k, color: P.c });
    }
    const head = (F.beat * 4) % N_PIX;
    L.pixels = { cells: cells((i) => Math.max(Math.exp(-behind(head, i) * 0.6), 0.8 * k)), colA: P.a, colB: P.b, alpha: 1 };
    Object.assign(L.wash, { l: 0.3 + 0.45 * k, r: 0.3 + 0.45 * k, top: 0.2 * k, floor: 0.35 + 0.4 * k });
    L.halo = { alpha: 0.6 + 0.4 * k, r: 0.4, color: P.a };
    L.strobe.snare = 0.75;
    L.strobe.kick = 0.2;
    L.rings.bar = 1;
    L.rings.kick = 0.45;
    L.blinders.bar = 0.45;
    L.sparks = 0.5;
    L.haze = 0.85;
    L.trail = 0.3;
    return L;
}

function rock(F, P, o) {
    const L = baseLook(P);
    const k = F.pulse.k;
    for (let i = 0; i < 6; i++) {
        const x = 0.08 + 0.84 * i / 5, side = x < 0.5 ? -1 : 1;
        L.beams.push({
            x, y: 1, angle: side * (0.08 + 0.42 * (0.5 + 0.5 * Math.sin(TAU * F.bar / 2 + i * 0.4))),
            width: 0.1, alpha: 0.3 + 0.5 * k, color: i % 3 === 1 ? P.c : P.a,
        });
    }
    if (o.lasers && o.I > 0.5) {
        L.lasers.push({ x: 0.5, y: 1, angle: 0.25 * Math.sin(TAU * F.bar / 4), spread: 1.4, count: 7, alpha: 0.16, thick: 1, color: P.c });
    }
    L.pixels = { cells: cells(() => 0.12 + 0.88 * k), colA: P.a, colB: P.c, alpha: 0.9 };
    Object.assign(L.wash, { l: 0.3 + 0.2 * F.bands.mid, r: 0.3 + 0.2 * F.bands.mid, floor: 0.2 + 0.5 * k });
    L.halo = { alpha: 0.45 + 0.4 * k, r: 0.38, color: P.a };
    L.blinders.snare = 0.85;
    L.blinders.bar = 0.5;
    L.strobe.snare = 0.18;
    L.rings.bar = 0.5;
    L.haze = 0.8;
    L.trail = 0.45;
    return L;
}

function build(F, P, o) {
    const L = baseLook(P);
    const p = clamp(F.buildProgress, 0, 1), t = F.t;
    const sub = p < 0.5 ? 1 : p < 0.8 ? 2 : 4;
    if (o.lasers) {
        [0.22, 0.5, 0.78].forEach((x, i) => L.lasers.push({
            x, y: 1, angle: (0.5 - x) * 0.9 + 0.05 * p * Math.sin(t * 20 + i),
            spread: lerp(1.1, 0.06, Math.pow(p, 0.8)), count: 7, alpha: 0.18 + 0.5 * p, thick: 1, color: i === 1 ? P.a : P.b,
        }));
    }
    for (let i = 0; i < 6; i++) {
        const x = 0.1 + 0.8 * i / 5, side = x < 0.5 ? -1 : 1;
        L.beams.push({
            x, y: 1, angle: side * lerp(0.5, 0.04, p) + 0.03 * p * Math.sin(t * 13 + i),
            width: lerp(0.07, 0.03, p), alpha: 0.18 + 0.5 * p, color: i % 2 ? P.a : P.c,
        });
    }
    const head = (F.beat * 2 * sub) % N_PIX;
    L.pixels = { cells: cells((i) => Math.exp(-behind(head, i) * 0.5) + 0.05), colA: P.a, colB: P.w, alpha: 0.5 + 0.5 * p };
    Object.assign(L.wash, { l: 0.1 + 0.4 * p, r: 0.1 + 0.4 * p, floor: 0.1 + 0.3 * p });
    L.halo = { alpha: 0.3 + 0.6 * p, r: lerp(0.4, 0.12, p), color: P.w };
    if (p > 0.55) {
        L.strobe.sub = ((p - 0.55) / 0.45) * 0.55;
        L.strobe.subN = sub * 2;
    }
    L.haze = 0.7;
    L.trail = 0.35;
    return L;
}

function float(F, P, o) {
    const L = baseLook(P);
    const t = F.t, harm = F.bands.harm;
    if (o.lasers) {
        L.lasers.push({ x: -0.02, y: 0.45, angle: PI / 2 + 0.12 * Math.sin(t * 0.4), spread: 0.9, count: 22, alpha: 0.05 + 0.08 * harm, thick: 0.8, color: P.a });
        L.lasers.push({ x: 1.02, y: 0.55, angle: -PI / 2 + 0.12 * Math.sin(t * 0.33 + 1), spread: 0.7, count: 16, alpha: 0.04 + 0.06 * harm, thick: 0.8, color: P.b });
    }
    [0.3, 0.7].forEach((x, i) => L.beams.push({
        x, y: 0, angle: PI + (i ? -1 : 1) * 0.25 * Math.sin(t * 0.3 + i), width: 0.06, alpha: 0.13, color: i ? P.b : P.a,
    }));
    Object.assign(L.wash, { l: 0.25 * harm, r: 0.25 * harm, top: 0.15, floor: 0.15 });
    L.pixels = { cells: cells((i, u) => 0.2 + 0.2 * Math.sin(t * 1.2 + u * 3)), colA: P.a, colB: P.b, alpha: 0.5 };
    L.halo = { alpha: 0.3 + 0.3 * harm, r: 0.38, color: P.b };
    L.haze = 0.9;
    L.trail = 0.85;
    return L;
}

function tunnel(F, P, o) {
    const L = baseLook(P);
    const k = F.pulse.k, dir = o.variant % 2 ? -1 : 1;
    if (o.lasers) {
        const n = o.I > 0.7 ? 24 : 18;
        L.lasers.push({ x: 0.5, y: 0.45, r0: 0.22, angle: dir * TAU * F.bar / 4, spread: TAU, count: n, alpha: 0.12 + 0.28 * k, thick: 1, color: P.a });
        L.lasers.push({ x: 0.5, y: 0.45, r0: 0.3, angle: -dir * TAU * F.bar / 6, spread: TAU, count: n, alpha: 0.1, thick: 0.8, color: P.b });
    }
    [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([x, y], i) => {
        const a = Math.atan2(0.5 - x, -(0.45 - y) * 0.6);
        L.beams.push({ x, y, angle: a + 0.08 * Math.sin(TAU * F.beat / 2 + i), width: 0.05, alpha: 0.2 + 0.4 * k, color: i % 2 ? P.a : P.c });
    });
    const q = Math.floor(F.beat * 4);
    L.pixels = { cells: cells((i) => (hash(q * 31 + i) > 0.72 ? 1 : 0.08)), colA: P.a, colB: P.b, alpha: 0.6 + 0.4 * F.pulse.h };
    Object.assign(L.wash, { l: 0.2 + 0.3 * k, r: 0.2 + 0.3 * k, floor: 0.25 });
    L.halo = { alpha: 0.5 + 0.3 * k, r: 0.3, color: P.a };
    L.rings.kick = 0.5;
    L.strobe.snare = 0.25;
    L.haze = 0.7;
    L.trail = 0.35;
    return L;
}

function swell(F, P, o) {
    const L = baseLook(P);
    const e = F.bands.rms, slow = F.t * 0.18;
    for (let i = 0; i < 5; i++) {
        L.beams.push({
            x: 0.1 + 0.8 * i / 4, y: 0, angle: PI + 0.45 * Math.sin(slow + i * 0.9) * (0.4 + 0.6 * e),
            width: 0.06 + 0.04 * e, alpha: 0.1 + 0.45 * Math.pow(e, 1.3), color: i % 2 ? P.a : P.c,
        });
    }
    if (o.lasers && e > 0.7 && o.I > 0.4) {
        L.lasers.push({ x: 0.5, y: 1, angle: 0.2 * Math.sin(slow), spread: 1.6, count: 11, alpha: (e - 0.7) * 1.2, thick: 0.9, color: P.w });
    }
    L.pixels = { cells: cells((i, u) => (Math.min(u, 1 - u) * 2 < e ? 0.9 : 0.06)), colA: P.c, colB: P.a, alpha: 0.7 };
    Object.assign(L.wash, { l: 0.15 + 0.35 * e, r: 0.15 + 0.35 * e, top: 0.1, floor: 0.2 * e });
    L.halo = { alpha: 0.25 + 0.5 * e, r: 0.36, color: P.c };
    L.haze = 0.8;
    L.trail = 0.7;
    return L;
}

export const SCENES = { ambient, sweep, cross, groove, fan, storm, rock, build, float, tunnel, swell };

const TABLE = {
    edm:        { intro: ['ambient'], verse: ['sweep', 'cross'], build: ['build'], chorus: ['fan', 'tunnel'], drop: ['storm', 'tunnel', 'storm'], breakdown: ['float'], outro: ['ambient'] },
    pop:        { intro: ['ambient'], verse: ['sweep', 'cross'], build: ['build'], chorus: ['fan', 'tunnel'], drop: ['fan', 'storm'], breakdown: ['float'], outro: ['ambient'] },
    rock:       { intro: ['ambient'], verse: ['cross', 'sweep'], build: ['build'], chorus: ['rock', 'fan'], drop: ['rock'], breakdown: ['float'], outro: ['ambient'] },
    hiphop:     { intro: ['ambient'], verse: ['groove', 'cross'], build: ['build'], chorus: ['groove', 'fan'], drop: ['storm', 'groove'], breakdown: ['float'], outro: ['ambient'] },
    latin:      { intro: ['ambient'], verse: ['groove', 'sweep'], build: ['build'], chorus: ['fan', 'groove', 'tunnel'], drop: ['storm', 'fan'], breakdown: ['float'], outro: ['ambient'] },
    chill:      { intro: ['ambient'], verse: ['ambient', 'sweep'], build: ['sweep'], chorus: ['sweep', 'float'], drop: ['sweep'], breakdown: ['float'], outro: ['ambient'] },
    orchestral: { intro: ['swell'], verse: ['swell'], build: ['swell'], chorus: ['swell', 'fan'], drop: ['swell'], breakdown: ['float'], outro: ['swell'] },
};
const CALMER = { storm: 'fan', tunnel: 'sweep', rock: 'sweep', build: 'sweep' };

function pickScene(genre, label, phrase, I) {
    const g = TABLE[genre] || TABLE.pop;
    let list = g[label] || g.verse;
    if (I > 0.85 && label === 'chorus') list = g.drop;
    let name = list[phrase % list.length];
    if (I < 0.35 && CALMER[name]) name = CALMER[name];
    return name;
}

// ---------------------------------------------------------------- director

const PHRASE_BARS = 8;

export class Director {
    constructor() {
        this.reset();
    }

    reset() {
        this.key = '';
        this.cur = null;     // { name, variant }
        this.prev = null;
        this.mixStart = 0;
        this.mixDur = 0;
        this.paletteKey = '';
        this.paletteTarget = null;
        this.snapPalette = false;
        this._secIdx = -1;
        this._phrase = 0;
    }

    /**
     * Decide the scene(s) for this frame.
     * @returns {{ a: object, b: object|null, mix: number }} looks + crossfade
     */
    update(F, P, opts, accentHue) {
        const sec = F.section || { label: 'verse', idx: 0 };
        const genre = (F.profile && F.profile.genre) || 'pop';
        let phrase = Math.floor(F.sectionBar / PHRASE_BARS);
        // Don't start a new phrase in the last two bars of a section — the
        // section change right after would make it a one-bar blip.
        if (sec.idx === this._secIdx && phrase !== this._phrase && F.nextIn < (F.period || 0.5) * 8) phrase = this._phrase;
        this._secIdx = sec.idx;
        this._phrase = phrase;
        const name = pickScene(genre, sec.label, phrase, opts.I);
        const variant = sec.idx + phrase;
        const key = `${name}:${sec.idx}:${phrase}`;

        const palKey = `${sec.idx}:${phrase & 1}`;
        if (palKey !== this.paletteKey) {
            this.paletteKey = palKey;
            this.paletteTarget = paletteFor({
                accentHue, key: sec.key, mode: sec.mode, label: sec.label, genre, swap: (phrase & 1) === 1,
            });
            this.snapPalette = sec.label === 'drop' && F.sectionBar === 0;
        }

        if (key !== this.key) {
            const sectionChanged = !this.cur || this.key.split(':')[1] !== String(sec.idx);
            this.prev = this.cur;
            this.cur = { name, variant };
            this.key = key;
            this.mixStart = F.t;
            if (F.jumped || !this.prev) this.mixDur = 0;
            else if (sec.label === 'drop' && sectionChanged) this.mixDur = 0.05;
            else this.mixDur = (sectionChanged ? 1 : 2) * (F.period || 0.5);
        }
        let mix = this.mixDur > 0 ? clamp((F.t - this.mixStart) / this.mixDur, 0, 1) : 1;
        if (F.t < this.mixStart) mix = 1;
        const o = { ...opts, genre };
        const a = SCENES[this.cur.name](F, P, { ...o, variant: this.cur.variant });
        const b = mix < 1 && this.prev ? SCENES[this.prev.name](F, P, { ...o, variant: this.prev.variant }) : null;
        if (mix >= 1) this.prev = null;
        return { a, b, mix: smooth(mix) };
    }
}
