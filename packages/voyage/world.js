/**
 * Voyage world model — the song laid out as a road.
 *
 * The camera never really moves: it sits at the origin looking down -Z and
 * the world scrolls past it. A moment τ of the song lives `(τ - t) · U` units
 * ahead of the camera (U = units per second of music), so the whole world is
 * a function of media time: a seek is just another `t`, and what lies ahead
 * is literally the music that is about to play.
 *
 * This module turns a score into the data the world is built from (no DOM,
 * no three.js): the envelopes as texture rows (the terrain), the palette of
 * every moment (its colours), the beats as gates and the sections as portals.
 */
import { clamp, paletteFor, floorIndex } from '@rainy/lightshow';

export const FAR = 420;             // how far ahead the world is drawn (units)
export const BEHIND = 24;           // and how far behind the camera
export const ROWS_MAX = 2048;       // texture rows a song is baked into, at most
const ROWS_PER_SECOND = 9;

// How "hot" a section is, whatever its measured energy (0..1).
export const LABEL_HEAT = { intro: 0.2, verse: 0.45, build: 0.6, chorus: 0.8, drop: 1, breakdown: 0.25, outro: 0.2 };

export const GATE = { SUB: 0, BEAT: 1, BAR: 2, PHRASE: 3 };

/** Units of road per second of music: faster songs fly faster. */
export function speedFor(tempo) {
    return 26 * clamp((tempo || 120) / 120, 0.8, 1.35);
}

/** How many texture rows a song of this length gets. */
export function rowsFor(duration, maxRows = ROWS_MAX) {
    return clamp(Math.ceil((duration || 0) * ROWS_PER_SECOND), 64, maxRows);
}

/** Resample a 0..255 envelope to `rows` rows keeping each row's peak, so hits survive. */
export function poolEnvelope(src, rows) {
    const out = new Uint8Array(rows);
    const n = src ? src.length : 0;
    if (!n) return out;
    for (let r = 0; r < rows; r++) {
        const a = Math.floor((r * n) / rows);
        const b = Math.max(a + 1, Math.floor(((r + 1) * n) / rows));
        let peak = 0;
        for (let i = a; i < b && i < n; i++) if (src[i] > peak) peak = src[i];
        out[r] = peak;
    }
    return out;
}

/** Moving average over ±radius rows (the slow shape under the hits). */
export function smoothRows(src, radius) {
    const n = src.length;
    const out = new Uint8Array(n);
    let sum = 0, count = 0;
    for (let i = 0; i < Math.min(n, radius); i++) { sum += src[i]; count++; }
    for (let i = 0; i < n; i++) {
        const add = i + radius, drop = i - radius - 1;
        if (add < n) { sum += src[add]; count++; }
        if (drop >= 0) { sum -= src[drop]; count--; }
        out[i] = Math.round(sum / Math.max(1, count));
    }
    return out;
}

/**
 * The score's envelopes as two RGBA textures, one row per moment:
 *   a = [sub, bass, mid, high]      b = [air, rms, mass, harm]
 * `mass` is the loudness smoothed over a couple of seconds: the bulk of the
 * landscape, with the fast bands as the detail on top of it.
 * @returns {{ rows: number, a: Uint8Array, b: Uint8Array }}
 */
export function bakeEnvelopes(score, maxRows = ROWS_MAX) {
    const rows = rowsFor(score.duration, maxRows);
    const band = (k) => poolEnvelope(score.env[k], rows);
    const sub = band('sub'), bass = band('bass'), mid = band('mid'), high = band('high');
    const air = band('air'), rms = band('rms'), harm = band('harm');
    const perSecond = rows / Math.max(1, score.duration);
    const mass = smoothRows(rms, Math.max(1, Math.round(perSecond * 1.2)));
    const a = new Uint8Array(rows * 4), b = new Uint8Array(rows * 4);
    for (let r = 0; r < rows; r++) {
        const o = r * 4;
        a[o] = sub[r]; a[o + 1] = bass[r]; a[o + 2] = mid[r]; a[o + 3] = high[r];
        b[o] = air[r]; b[o + 1] = rms[r]; b[o + 2] = mass[r]; b[o + 3] = harm[r];
    }
    return { rows, a, b };
}

/** The palette of every section, from its key, mode and label (as the conductor would pick it). */
export function sectionPalettes(score, accentHue) {
    const genre = (score.profile && score.profile.genre) || 'pop';
    return score.sections.map((s) => paletteFor({ accentHue, key: s.key, mode: s.mode, label: s.label, genre }));
}

export const PAL_COLS = 4;

/**
 * The colours of every moment as a 4-wide RGBA texture:
 *   column 0 = primary colour,   alpha = the section's energy
 *   column 1 = secondary colour, alpha = its heat (see LABEL_HEAT)
 *   column 2 = tertiary colour,  alpha = build-up tension at that moment
 *   column 3 = tinted white,     alpha = 1 inside the silence before a drop
 * Sections melt into each other over about a second; a drop cuts in.
 * @returns {Uint8Array} rows × PAL_COLS × 4 bytes
 */
export function bakePalettes(score, palettes, rows) {
    const W = PAL_COLS * 4;
    const out = new Uint8Array(rows * W);
    const secs = score.sections;
    const dur = Math.max(1e-3, score.duration);
    const tone = (i) => {
        const s = secs[i], p = palettes[i];
        return [
            p.a[0], p.a[1], p.a[2], 255 * clamp(s.energy ?? 0.5, 0, 1),
            p.b[0], p.b[1], p.b[2], 255 * (LABEL_HEAT[s.label] ?? 0.45),
            p.c[0], p.c[1], p.c[2], 0,
            p.w[0], p.w[1], p.w[2], 0,
        ];
    };
    const stops = score.events.filter((e) => e.type === 'stop');
    const edge = (label) => (label === 'drop' ? 0.12 : 0.9);
    let i = 0;
    for (let r = 0; r < rows; r++) {
        const t = ((r + 0.5) / rows) * dur;
        while (i + 1 < secs.length && secs[i + 1].t0 <= t) i++;
        const sec = secs[i], next = secs[i + 1];
        const cur = tone(i);
        // Blend toward whichever neighbour's border is close.
        let other = null, k = 0;
        if (next && next.t0 - t < edge(next.label)) {
            other = tone(i + 1);
            k = 0.5 * (1 - (next.t0 - t) / edge(next.label));
        } else if (i > 0 && t - sec.t0 < edge(sec.label)) {
            other = tone(i - 1);
            k = 0.5 * (1 - (t - sec.t0) / edge(sec.label));
        }
        const o = r * W;
        for (let c = 0; c < W; c++) out[o + c] = Math.round(other ? cur[c] + (other[c] - cur[c]) * k : cur[c]);
        out[o + 11] = Math.round(255 * buildAt(score, sec, next, t));
        out[o + 15] = stops.some((e) => t >= e.t && t < e.t + (e.dur || 0.3)) ? 255 : 0;
    }
    return out;
}

/** Build-up tension at a moment (the same rule the score source uses for its frame). */
function buildAt(score, sec, next, t) {
    if (sec.label === 'build') return clamp((t - sec.t0) / Math.max(0.1, sec.t1 - sec.t0), 0, 1);
    const lead = score.period * 8;
    if (next && (next.label === 'drop' || next.label === 'chorus') && next.t0 - t < lead) return 0.5 * (1 - (next.t0 - t) / lead);
    return 0;
}

/**
 * Every beat as a gate the camera flies through exactly on the beat.
 * Downbeats are bigger, every 8th bar of a section is a phrase arch, and a
 * build fills in half and quarter beats as it climbs.
 * @returns {{ t: Float64Array, kind: Uint8Array, power: Float32Array }} sorted by time
 */
export function buildGates(score) {
    const list = [];
    const beats = score.beats, downs = score.downbeats;
    const isDown = (t) => {
        const i = floorIndex(downs, t + 0.03);
        return i >= 0 && Math.abs(downs[i] - t) < 0.03;
    };
    const barsIn = new Map();   // section idx -> downbeats seen so far
    for (let i = 0; i < beats.length; i++) {
        const t = beats[i];
        const sec = score.sectionAt(t);
        let kind = GATE.BEAT;
        if (isDown(t)) {
            const n = barsIn.get(sec.idx) || 0;
            barsIn.set(sec.idx, n + 1);
            kind = n % 8 === 0 ? GATE.PHRASE : GATE.BAR;
        }
        list.push({ t, kind, power: Math.max(0.25, score.hitIn('k', t - 0.07, t + 0.07)) });
        if (sec.label !== 'build' || i + 1 >= beats.length) continue;
        const p = (t - sec.t0) / Math.max(0.1, sec.t1 - sec.t0);
        const step = beats[i + 1] - t;
        if (p > 0.45) list.push({ t: t + step / 2, kind: GATE.SUB, power: 0.3 + 0.5 * p });
        if (p > 0.78) {
            list.push({ t: t + step / 4, kind: GATE.SUB, power: 0.2 + 0.5 * p });
            list.push({ t: t + (3 * step) / 4, kind: GATE.SUB, power: 0.2 + 0.5 * p });
        }
    }
    list.sort((x, y) => x.t - y.t);
    return {
        t: Float64Array.from(list.map((g) => g.t)),
        kind: Uint8Array.from(list.map((g) => g.kind)),
        power: Float32Array.from(list.map((g) => g.power)),
    };
}

/** Index range [i0, i1) of the gates whose time falls in (t0, t1]. */
export function gateWindow(gates, t0, t1) {
    return [floorIndex(gates.t, t0) + 1, floorIndex(gates.t, t1) + 1];
}

/**
 * Every section change as a portal across the road, in the colours of the
 * section it opens. A drop's portal is a wall of light.
 * @returns {Array<{ t: number, label: string, drop: boolean, idx: number }>}
 */
export function buildPortals(score) {
    return score.sections.slice(1).map((s) => ({ t: s.t0, label: s.label, drop: s.label === 'drop', idx: s.idx }));
}

/** The last event of a type at or before t (within `horizon` seconds), or null. */
export function lastEvent(score, type, t, horizon = 12) {
    const ev = score.events;
    let lo = 0, hi = ev.length - 1, i = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ev[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (; i >= 0 && t - ev[i].t <= horizon; i--) if (ev[i].type === type) return ev[i];
    return null;
}

/**
 * The last `n` hits of a kind at or before t, newest first, as [time, strength]
 * pairs (padded with far-away hits so the result always has n entries).
 */
export function lastHits(score, type, t, n, minStrength = 0.35) {
    const o = score.onsets[type];
    const out = [];
    for (let i = floorIndex(o.t, t); i >= 0 && out.length < n && t - o.t[i] < 6; i--) {
        if (o.s[i] >= minStrength) out.push([o.t[i], o.s[i]]);
    }
    while (out.length < n) out.push([-1e3, 0]);
    return out;
}
