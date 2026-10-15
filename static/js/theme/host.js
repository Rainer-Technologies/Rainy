/**
 * Puts a UI theme on the page and takes it off again.
 *
 * A theme is three things, all optional but the first two together:
 *   - tokens, written as `@layer theme { :root { … } }`;
 *   - stylesheets, imported into the `theme` layer (style.css fixes the order:
 *     guard, rainy, theme), so they win over Rainy's own rules without any
 *     specificity games, and never over the guard layer;
 *   - a module for decorative layers, given a narrow `ctx` (below).
 * Rainy's markup is never the theme's: every button and view is built by
 * the app, the theme only styles them.
 *
 * Changing themes is atomic: the new stylesheets load first and the old ones
 * go once they have. If a stylesheet does not load, the page goes back to
 * Rainy's own look; if the module throws, the module goes and the styles stay.
 *
 * The module's default export is a class:
 *   mount(ctx)   may be async (5 s at most)
 *   unmount()    release what the page cannot release for you
 * and `ctx` holds:
 *   api, id, manifest, locale, reducedMotion, lowPower
 *   asset(path)                 the address of a file of the package
 *   layers.back, layers.front   its own layers: behind the app and over it (they never take clicks)
 *   state.get()                 { view, auth, playing, hasTrack, fullscreen, settings, sidebar, track }
 *   on(event, fn)               'state' (name, value, state), 'track' (track|null), 'view', 'playing',
 *                               'fullscreen', 'settings', 'accent' (#rrggbb), 'visibility' (visible);
 *                               returns a function that stops
 *   setVar(name, value)         set one of its own --theme-* variables on the page
 *   colors(url)                 the average and the most vivid colour of a picture, [r, g, b] each
 *   signal                      an AbortSignal, aborted when the theme comes off
 *   toast(message), fail(error)
 */
import { getLanguage, t } from '../i18n/index.js';
import {
    CACHE_KEY, DEFAULT_THEME, SAFE_KEY, THEME_API, THEMES, buildTokenCss, cacheEntry, chooseTheme, isThemeUrl,
    readSafeMode,
} from './index.js';
import { cssColorToHex } from './color.js';
import { getState, onStateChange } from './state.js';

const STYLE_TIMEOUT = 5000;
const MOUNT_TIMEOUT = 5000;
const MAX_ERRORS = 3;
const THEME_VAR = /^--theme-[a-z0-9-]{1,48}$/;
const BAD_VALUE = /[;{}<>\\]|!\s*important|url\s*\(|expression\s*\(/i;

const root = document.documentElement;

let worn = null;            // id of the theme on the page
let wanted = undefined;     // the user's pick (ui_theme), as last given
let safe = false;
let mounted = null;         // { instance, abort, stops: [], vars: Set, layers }
let token = 0;              // newest change wins
const failed = new Set();   // themes whose styles or module broke here this session
const listeners = new Set();

const withTimeout = (promise, ms, what) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms)),
]);

function storage(kind) {
    try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
}

/** The theme on the page right now. */
export function currentTheme() {
    return worn || DEFAULT_THEME;
}

/** Whether safe mode (Rainy's own look for this tab) is on. */
export function isSafe() {
    return safe;
}

/** Follow theme changes: `fn(id)`. Returns a function that stops. */
export function onThemeChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Read safe mode and adopt what the boot script in index.html already put on. Call once, early. */
export function startThemes() {
    const read = readSafeMode(location.search, storage('session')?.getItem(SAFE_KEY));
    safe = read.safe;
    if (read.remember !== null) {
        try {
            if (read.remember) storage('session').setItem(SAFE_KEY, '1');
            else storage('session').removeItem(SAFE_KEY);
        } catch (e) { /* ignore */ }
    }
    worn = root.getAttribute('data-theme') || DEFAULT_THEME;
    if (!root.hasAttribute('data-theme')) root.setAttribute('data-theme', worn);
    if (!root.hasAttribute('data-color-scheme')) root.setAttribute('data-color-scheme', 'dark');
}

/**
 * Wear the theme the user wants (their `ui_theme` preference), or the best
 * stand-in: the server's default, or Rainy's own.
 * @param {string|null|undefined} pick
 */
export function wearPreferred(pick) {
    if (pick !== undefined) wanted = pick;
    return wear(chooseTheme(wanted, { safe, failed }));
}

/** Turn safe mode on or off for this tab, and wear what follows from it. */
export function setSafeMode(on) {
    safe = !!on;
    try {
        if (safe) storage('session').setItem(SAFE_KEY, '1');
        else storage('session').removeItem(SAFE_KEY);
    } catch (e) { /* ignore */ }
    return wearPreferred();
}

function themeElements() {
    return [...document.head.querySelectorAll('style[data-rainy-theme]')];
}

function styleElement(kind, css) {
    const el = document.createElement('style');
    el.dataset.rainyTheme = kind;
    el.textContent = css;
    return el;
}

/** A stylesheet of the theme, imported into the theme layer; resolves true once loaded, false if it failed. */
function sheetElement(url) {
    const el = styleElement('sheet', `@import url("${url}") layer(theme);`);
    const loaded = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), STYLE_TIMEOUT);
        el.addEventListener('load', () => { clearTimeout(timer); resolve(true); }, { once: true });
        el.addEventListener('error', () => { clearTimeout(timer); resolve(false); }, { once: true });
    });
    return { el, loaded };
}

/**
 * Put a theme on (an id of the registry). Resolves once it is on, or once
 * the page went back to Rainy's own because it could not be.
 */
export async function wear(id) {
    const def = THEMES[id] || THEMES[DEFAULT_THEME];
    const mine = ++token;
    if (def.id === worn && themeElements().every((el) => el.dataset.rev === (def.rev || 'builtin'))) {
        if (!mounted && def.entry) mountModule(def, mine);
        return def.id;
    }

    const old = themeElements();
    const added = [];
    let ok = true;
    if (!def.builtin) {
        const tokens = styleElement('tokens', buildTokenCss(def));
        added.push(tokens);
        const sheets = def.styles.filter(isThemeUrl).map(sheetElement);
        for (const el of [tokens, ...sheets.map((s) => s.el)]) {
            el.dataset.rev = def.rev;
            el.dataset.themeId = def.id;
            document.head.appendChild(el);
        }
        added.push(...sheets.map((s) => s.el));
        ok = (await Promise.all(sheets.map((s) => s.loaded))).every(Boolean);
        if (mine !== token) {
            for (const el of added) el.remove();
            return worn;
        }
    }
    if (!ok) {
        for (const el of added) el.remove();
        failed.add(def.id);
        console.error(`[Rainy theme] ${def.id}: a stylesheet did not load; back to Rainy's own look.`);
        window.showToast?.(t('The theme {name} could not be loaded', { name: def.name }), 'error');
        return wear(DEFAULT_THEME);
    }

    unmountModule();
    for (const el of old) el.remove();
    worn = def.id;
    root.setAttribute('data-theme', def.id);
    root.setAttribute('data-color-scheme', def.colorScheme || 'dark');
    remember(def);
    for (const fn of [...listeners]) {
        try { fn(def.id); } catch (e) { console.error(e); }
    }
    document.dispatchEvent(new CustomEvent('rainy:theme', { detail: { id: def.id } }));
    if (def.entry) mountModule(def, mine);
    return def.id;
}

function remember(def) {
    const store = storage('local');
    if (!store) return;
    try {
        const entry = cacheEntry(def);
        if (entry) store.setItem(CACHE_KEY, JSON.stringify(entry));
        else store.removeItem(CACHE_KEY);
    } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------ the module

function layerHost() {
    let host = document.getElementById('rainy-theme-layer');
    if (!host) {
        host = document.createElement('div');
        host.id = 'rainy-theme-layer';
        host.setAttribute('aria-hidden', 'true');
        document.body.appendChild(host);
    }
    return host;
}

async function mountModule(def, mine) {
    const abort = new AbortController();
    const host = layerHost();
    const back = document.createElement('div');
    back.className = 'theme-layer-back';
    const front = document.createElement('div');
    front.className = 'theme-layer-front';
    host.append(back, front);
    const state = { instance: null, abort, stops: [], vars: new Set(), layers: [back, front], def, errors: 0 };
    mounted = state;

    const fail = (err) => moduleFailed(state, err);
    const guarded = (fn) => (...args) => {
        if (abort.signal.aborted) return;
        try {
            fn(...args);
            state.errors = 0;
        } catch (e) {
            if (++state.errors >= MAX_ERRORS) fail(e);
            else console.error(`[Rainy theme] ${def.id}:`, e);
        }
    };
    const on = (event, fn) => {
        const call = guarded(fn);
        let stop;
        if (event === 'accent') {
            const h = () => call(cssColorToHex(getComputedStyle(root).getPropertyValue('--accent-primary')));
            document.addEventListener('rainy:accent', h);
            document.addEventListener('rainy:theme', h);
            stop = () => { document.removeEventListener('rainy:accent', h); document.removeEventListener('rainy:theme', h); };
        } else if (event === 'visibility') {
            const h = () => call(!document.hidden);
            document.addEventListener('visibilitychange', h);
            stop = () => document.removeEventListener('visibilitychange', h);
        } else if (event === 'state') {
            stop = onStateChange((name, value, s) => call(name, value, s));
        } else {
            stop = onStateChange((name, value) => {
                if (name === event || (event === 'playing' && name === 'playing')) call(value);
            });
        }
        state.stops.push(stop);
        return stop;
    };
    const ctx = {
        api: THEME_API,
        id: def.id,
        manifest: { id: def.id, name: def.name, version: def.version, colorScheme: def.colorScheme },
        locale: getLanguage(),
        reducedMotion: !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
        lowPower: storage('local')?.getItem('rainy-ls-lowpower') === '1',
        asset: (path) => (def.base || '') + String(path || '').replace(/^\/+/, ''),
        layers: { back, front },
        state: { get: getState },
        on,
        setVar: (name, value) => {
            if (abort.signal.aborted || !THEME_VAR.test(name)) return;
            const v = value == null ? '' : String(value);
            if (v.length > 200 || BAD_VALUE.test(v)) return;
            if (v) root.style.setProperty(name, v);
            else root.style.removeProperty(name);
            state.vars.add(name);
        },
        colors: (url) => pictureColors(url),
        signal: abort.signal,
        toast: (message) => window.showToast?.(String(message), 'info'),
        fail,
    };

    try {
        const Theme = await withTimeout(import(def.entry).then((m) => m.default), MOUNT_TIMEOUT, 'Loading');
        if (typeof Theme !== 'function') throw new Error('the module\'s default export is not a class');
        if (mine !== token || mounted !== state) return;
        state.instance = new Theme();
        await withTimeout(Promise.resolve(state.instance.mount(ctx)), MOUNT_TIMEOUT, 'mount()');
    } catch (e) {
        if (mounted === state) moduleFailed(state, e);
    }
}

function moduleFailed(state, err) {
    if (mounted !== state) return;
    console.error(`[Rainy theme] ${state.def.id}: its module failed and was taken off (the styles stay).`, err);
    window.showToast?.(t('Part of the theme {name} stopped working', { name: state.def.name }), 'error');
    unmountModule();
}

function unmountModule() {
    const state = mounted;
    if (!state) return;
    mounted = null;
    state.abort.abort();
    for (const stop of state.stops) {
        try { stop(); } catch (e) { /* ignore */ }
    }
    try { state.instance?.unmount?.(); } catch (e) { console.error(`[Rainy theme] ${state.def.id}: unmount()`, e); }
    for (const name of state.vars) root.style.removeProperty(name);
    for (const layer of state.layers) layer.remove();
}

// ------------------------------------------------------------ colours

const colorCache = new Map();

/** The average and the most vivid colour of a picture (same-origin), as [r, g, b]. */
function pictureColors(url) {
    if (!url) return Promise.resolve(null);
    if (colorCache.has(url)) return colorCache.get(url);
    const job = new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
            try {
                const size = 24;
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = size;
                const g = canvas.getContext('2d', { willReadFrequently: true });
                g.drawImage(img, 0, 0, size, size);
                const data = g.getImageData(0, 0, size, size).data;
                let r = 0, gr = 0, b = 0, n = 0, best = null, bestScore = -1;
                for (let i = 0; i < data.length; i += 4) {
                    const [cr, cg, cb] = [data[i], data[i + 1], data[i + 2]];
                    r += cr; gr += cg; b += cb; n++;
                    const max = Math.max(cr, cg, cb), min = Math.min(cr, cg, cb);
                    const score = (max - min) * (0.4 + max / 255);
                    if (score > bestScore) { bestScore = score; best = [cr, cg, cb]; }
                }
                resolve({ average: [r / n, gr / n, b / n].map(Math.round), vivid: best });
            } catch (e) {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
    colorCache.set(url, job);
    if (colorCache.size > 64) colorCache.delete(colorCache.keys().next().value);
    return job;
}
