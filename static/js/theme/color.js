/**
 * Colour helpers for UI themes: turning whatever CSS colour a theme or the
 * browser gives into numbers, and the contrast maths the theme audit uses.
 * Pure functions, except cssColorToRgb, which needs a canvas to read colour
 * syntaxes the parser below does not (names, hsl(), lab(), color-mix()).
 */

/** [r, g, b, a] (0-255, 0-255, 0-255, 0-1) from rgb()/rgba()/#hex/color(srgb …), or null. */
export function parseColor(text) {
    const s = String(text || '').trim().toLowerCase();
    if (!s) return null;
    if (s === 'transparent') return [0, 0, 0, 0];
    let m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
        if (h.length !== 6 && h.length !== 8) return null;
        const n = (i) => parseInt(h.slice(i, i + 2), 16);
        return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
    if (m) {
        const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return [+m[1], +m[2], +m[3], alpha];
    }
    m = s.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
    if (m) {
        const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return [m[1], m[2], m[3]].map((v) => Math.round(Math.min(1, Math.max(0, +v)) * 255)).concat(alpha);
    }
    return null;
}

let probe = null;

/** Any CSS colour as [r, g, b, a], using the browser for syntaxes parseColor does not read. */
export function cssColorToRgb(text) {
    const direct = parseColor(text);
    if (direct) return direct;
    if (typeof document === 'undefined') return null;
    if (!probe) {
        probe = document.createElement('span');
        probe.style.display = 'none';
    }
    probe.style.color = '';
    probe.style.color = String(text || '').trim();
    if (!probe.style.color) return null;
    document.documentElement.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return parseColor(resolved);
}

const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');

/** Any CSS colour as #rrggbb (alpha dropped), or '' when it is not one. */
export function cssColorToHex(text) {
    const c = cssColorToRgb(text);
    return c ? `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}` : '';
}

/** `top` over `bottom` (both [r, g, b, a]), as an opaque [r, g, b, 1] when `bottom` is opaque. */
export function composite(top, bottom) {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const ch = (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
    return [ch(0), ch(1), ch(2), a];
}

/** WCAG relative luminance of an opaque [r, g, b]. */
export function luminance([r, g, b]) {
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1 to 21) between two opaque colours. */
export function contrastRatio(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
