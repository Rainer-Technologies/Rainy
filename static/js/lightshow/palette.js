/**
 * Colour for the light show: small math helpers + section palettes.
 *
 * A palette is derived from the section's musical key (circle-of-fifths
 * position → hue, so related keys get related colours), its mode (major
 * warmer/brighter, minor cooler), the section label, the genre profile and
 * the user's accent colour — so the whole app still feels like one theme.
 */
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);

export function hsl(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
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

export function hexToHue(hex) {
    const r = parseInt(hex.substring(1, 3), 16) / 255;
    const g = parseInt(hex.substring(3, 5), 16) / 255;
    const b = parseInt(hex.substring(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return h * 60;
}

/** Shortest-arc hue interpolation. */
export function mixHue(a, b, t) {
    const d = ((((b - a) % 360) + 540) % 360) - 180;
    return a + d * t;
}

export const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;
export const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const toWhite = (c, t) => mixRgb(c, [255, 255, 255], t);

const FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, 'G#': 8, 'D#': 9, 'A#': 10, F: 11 };

// Genre colour temperament: [hue pull, pull strength, saturation, secondary offset]
const GENRE_TONE = {
    edm:        [270, 0.15, 1.0, 180],
    pop:        [320, 0.10, 0.95, 150],
    rock:       [18, 0.40, 0.95, 35],
    hiphop:     [285, 0.30, 0.9, 140],
    latin:      [335, 0.25, 1.0, 120],
    chill:      [200, 0.25, 0.6, 45],
    orchestral: [42, 0.40, 0.75, 180],
};

// Per-section tweaks: [secondary offset multiplier, saturation, lightness]
const LABEL_TONE = {
    intro:     [0.4, 0.75, 0.5],
    verse:     [0.6, 0.9, 0.52],
    build:     [0.8, 0.95, 0.55],
    chorus:    [1.0, 1.0, 0.56],
    drop:      [1.0, 1.0, 0.58],
    breakdown: [0.3, 0.8, 0.45],
    outro:     [0.4, 0.7, 0.48],
};

/**
 * @returns {{a:number[], b:number[], c:number[], w:number[], deep:number[]}}
 *   a = primary, b = secondary, c = tertiary, w = tinted white, deep = ambience
 */
export function paletteFor({ accentHue, key, mode, label, genre, swap }) {
    let h = accentHue;
    if (key && key in FIFTHS) h = mixHue(accentHue, FIFTHS[key] * 30, 0.5);
    h = mode === 'minor' ? mixHue(h, 235, 0.18) : mixHue(h, 30, 0.1);
    const [pull, strength, sat, off] = GENRE_TONE[genre] || GENRE_TONE.pop;
    h = mixHue(h, pull, strength);
    const [offMul, satMul, light] = LABEL_TONE[label] || LABEL_TONE.verse;
    const s = sat * satMul;
    const o = off * offMul;
    let a = hsl(h, s, light);
    let b = hsl(h + o, s, light);
    if (swap) [a, b] = [b, a];
    return {
        a,
        b,
        c: hsl(h - o * 0.5, s * 0.9, light + 0.06),
        w: hsl(h, 0.3, 0.93),
        deep: hsl(h, s * 0.8, 0.16),
    };
}

/** Move palette `cur` toward `target` by t (0..1), in place. */
export function blendPalette(cur, target, t) {
    for (const k of ['a', 'b', 'c', 'w', 'deep']) {
        const c = cur[k], d = target[k];
        c[0] = lerp(c[0], d[0], t);
        c[1] = lerp(c[1], d[1], t);
        c[2] = lerp(c[2], d[2], t);
    }
}

