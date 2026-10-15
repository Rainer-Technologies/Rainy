/**
 * Checks a UI theme against Rainy: on every view, every control that can be
 * seen and used with Rainy's own look must still be seen and used with the
 * theme on. What a theme hides, covers, shrinks to nothing, pushes off screen
 * or makes unreadable is reported.
 *
 * It compares the page with the theme's styles switched off and on again,
 * so whatever the app adds later is checked with no list to keep: a new
 * button is a control like any other. Run it from Settings → Appearance
 * (administrators), from tests/browser/theme-audit.js, or as
 * `(await import('/js/theme/audit.js')).auditAllViews()` in the console.
 *
 * compareSignatures and the colour maths are pure, for tests/js/theme.test.mjs.
 */
import { composite, contrastRatio, parseColor } from './color.js';

export const CONTROL_SELECTOR = [
    'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="radio"]', '[role="checkbox"]',
    '[role="switch"]', '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Problems that make a control unusable, and those that only make it worse to use. */
export const BLOCKING = new Set(['hidden', 'covered', 'tiny', 'offscreen']);

const MIN_SIZE = 8;
const MIN_CONTRAST = 3;

/** Whether a control described by a signature can be used. */
export function usable(sig) {
    if (!sig || !sig.visible) return false;
    if (sig.w < MIN_SIZE || sig.h < MIN_SIZE) return false;
    if (sig.inView && sig.hit === false) return false;
    return true;
}

/**
 * What a theme did to a control, from its signature with the theme off and on.
 * A signature: { visible, w, h, inView, hit (true|false|null), scrollable, contrast (number|null) }.
 * @returns {string[]} 'hidden' | 'tiny' | 'offscreen' | 'covered' | 'contrast'
 */
export function compareSignatures(off, on) {
    if (!usable(off)) return [];
    const problems = [];
    if (!on || !on.visible) return ['hidden'];
    if (on.w < MIN_SIZE || on.h < MIN_SIZE) problems.push('tiny');
    else if (off.inView && !on.inView && !on.scrollable) problems.push('offscreen');
    else if (on.inView && on.hit === false) problems.push('covered');
    if (off.contrast != null && on.contrast != null && off.contrast >= MIN_CONTRAST && on.contrast < MIN_CONTRAST) {
        problems.push('contrast');
    }
    return problems;
}

// ------------------------------------------------------------ the page

function hasOwnText(el) {
    for (const node of el.childNodes) if (node.nodeType === 3 && node.textContent.trim()) return true;
    return false;
}

/** The colour behind an element, as an opaque [r, g, b]. */
function backdropOf(el) {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // a picture or gradient: cannot tell
        const c = parseColor(cs.backgroundColor);
        if (c && c[3] > 0) {
            layers.push(c);
            if (c[3] >= 1) break;
        }
    }
    let colour = [255, 255, 255, 1];
    const canvas = parseColor(getComputedStyle(document.documentElement).backgroundColor);
    if (canvas && canvas[3] > 0) colour = composite(canvas, colour);
    for (let i = layers.length - 1; i >= 0; i--) colour = composite(layers[i], colour);
    return colour;
}

function textContrast(el) {
    const target = hasOwnText(el) ? el : [...el.querySelectorAll('*')].find((c) => hasOwnText(c) && c.offsetParent !== null);
    if (!target) return null;
    const fg = parseColor(getComputedStyle(target).color);
    const bg = backdropOf(target);
    if (!fg || !bg) return null;
    return contrastRatio(composite(fg, bg), bg);
}

function scrollableAncestor(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return true;
    }
    return document.documentElement.scrollHeight > innerHeight;
}

/** How a control stands on the page right now. */
export function signature(el) {
    const visible = typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        : el.offsetParent !== null;
    const r = el.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    let hit = null;
    if (visible && inView) {
        const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
        const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
        const at = document.elementFromPoint(x, y);
        hit = !!at && (el === at || el.contains(at) || at.contains(el) || (at.tagName === 'LABEL' && at.control === el));
    }
    return {
        visible,
        w: r.width,
        h: r.height,
        inView,
        hit,
        scrollable: !inView && scrollableAncestor(el),
        contrast: visible ? textContrast(el) : null,
    };
}

/** A name a person can recognise a control by. */
export function describeControl(el) {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const where = el.id ? `#${el.id}` : (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase());
    const part = el.closest('[data-part]')?.getAttribute('data-part');
    return { label: label || where, where, part: part || null };
}

function themeStyles() {
    return [...document.querySelectorAll('style[data-rainy-theme]')];
}

function setThemeOn(on) {
    for (const el of themeStyles()) el.disabled = !on;
    const layer = document.getElementById('rainy-theme-layer');
    if (layer) layer.style.visibility = on ? '' : 'hidden';
}

const freeze = () => {
    const el = document.createElement('style');
    el.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; }';
    document.head.appendChild(el);
    return () => el.remove();
};

/** Compare the controls on the page with the theme's styles off and on. */
export function auditPage() {
    const controls = [...document.querySelectorAll(CONTROL_SELECTOR)]
        .filter((el) => !el.closest('#rainy-theme-layer, #rainy-splash, #rainy-rescue'));
    const unfreeze = freeze();
    try {
        setThemeOn(false);
        const off = controls.map(signature);
        setThemeOn(true);
        const on = controls.map(signature);
        const problems = [];
        let checked = 0;
        controls.forEach((el, i) => {
            if (!usable(off[i])) return;
            checked++;
            const found = compareSignatures(off[i], on[i]);
            if (found.length) problems.push({ ...describeControl(el), problems: found, el });
        });
        return { checked, problems };
    } finally {
        setThemeOn(true);
        unfreeze();
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const VIEWS = ['/library', '/albums', '/artists', '/recent', '/smart-mix', '/discover', '/friends',
    '/settings/appearance', '/settings/player', '/settings/lightshow', '/settings/account', '/settings/about'];

/**
 * Check every view of the app with the theme in use. Comes back to the page
 * it started on.
 * @returns {Promise<{ theme: string, width: number, views: Array<{ view: string, checked: number, problems: object[] }>, problems: object[] }>}
 */
export async function auditAllViews({ views = VIEWS, settle = 700 } = {}) {
    const app = window.app;
    const start = location.pathname + location.search;
    const report = { theme: document.documentElement.getAttribute('data-theme') || 'rainy', width: innerWidth, views: [], problems: [] };
    try {
        for (const view of views) {
            app?.navigateTo?.(view);
            await sleep(settle);
            const { checked, problems } = auditPage();
            report.views.push({ view, checked, problems });
            for (const p of problems) report.problems.push({ ...p, view });
        }
        // The full player, when there is a song to show in it.
        const player = window.player;
        if (player?.currentSong && player.fsContainer?.classList.contains('hidden')) {
            app?.navigateTo?.('/library');
            await sleep(settle);
            player.toggleFullscreen();
            await sleep(settle);
            const { checked, problems } = auditPage();
            report.views.push({ view: 'fullscreen', checked, problems });
            for (const p of problems) report.problems.push({ ...p, view: 'fullscreen' });
            player.toggleFullscreen();
        }
    } finally {
        app?.navigateTo?.(start);
    }
    return report;
}

const PROBLEM_TEXT = {
    hidden: 'hidden',
    tiny: 'shrunk to nothing',
    offscreen: 'pushed off screen',
    covered: 'covered by something else',
    contrast: 'hard to read',
};

/** A report as lines for people (`t` translates). */
export function describeReport(report, t = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v?.[k] ?? '')) {
    const checked = report.views.reduce((n, v) => n + v.checked, 0);
    const blocking = report.problems.filter((p) => p.problems.some((x) => BLOCKING.has(x)));
    const lines = [];
    if (!report.problems.length) {
        lines.push(t('No problems: every control works ({checked} checked on {views} views).', { checked, views: report.views.length }));
        return lines;
    }
    lines.push(t('Controls with problems: {count}, of which {blocking} cannot be used ({checked} checked on {views} views):', {
        count: report.problems.length, blocking: blocking.length, checked, views: report.views.length,
    }));
    for (const p of report.problems.slice(0, 60)) {
        const what = p.problems.map((x) => t(PROBLEM_TEXT[x] || x)).join(', ');
        lines.push(`${p.view} · ${p.label} (${p.part || p.where}): ${what}`);
    }
    if (report.problems.length > 60) lines.push(t('…and {count} more.', { count: report.problems.length - 60 }));
    return lines;
}
