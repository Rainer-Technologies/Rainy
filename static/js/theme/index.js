/**
 * UI themes: the registry of the themes on offer, and the pure decisions
 * about them (which one to wear, what its tokens look like as CSS, what the
 * page remembers between visits). Nothing here touches the page: host.js
 * puts a theme on, audit.js checks one.
 *
 * Rainy's own look is the built-in theme `rainy`. The others are packages an
 * administrator installed on the server (utils/themes.py, docs/THEMES.md):
 * the server lists them and `setInstalled` puts them here.
 */

/** Version of the theme contract this Rainy speaks (static/js/theme/contract.json `api`). */
export const THEME_API = 1;

export const DEFAULT_THEME = 'rainy';

/** localStorage key of what the page wears before it has talked to the server. */
export const CACHE_KEY = 'rainy-theme';
/** sessionStorage key of safe mode: Rainy's own look for this tab, whatever was picked. */
export const SAFE_KEY = 'rainy-theme-safe';

const BUILTIN = {
    rainy: {
        id: 'rainy',
        builtin: true,
        name: 'Rainy',
        description: "Rainy's own look",
        colorScheme: 'dark',
        tokens: {},
        styles: [],
        icons: {},
        strings: {},
        entry: null,
        preview: null,
        api: THEME_API,
        rev: 'builtin',
        i18n: {},
    },
};

/** @type {Record<string, object>} */
export const THEMES = { ...BUILTIN };

let serverDefault = null;
let loaded = false;
const listeners = new Set();

/** Follow changes to the list: `fn(changedIds)`. Returns a function that stops. */
export function onThemesChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Whether the server's list has arrived at least once. */
export function themesLoaded() {
    return loaded;
}

/** The theme of users who have not picked one (an id), as the server says. */
export function defaultTheme() {
    return serverDefault && THEMES[serverDefault] ? serverDefault : DEFAULT_THEME;
}

/**
 * Replace the installed themes with the server's list (`GET /api/themes`).
 * A theme whose files did not change keeps its entry.
 * @param {Array<object>} list
 * @param {string|null} [defaultId] the server's default theme
 * @returns {string[]} ids that were added, removed or replaced
 */
export function setInstalled(list, defaultId = null) {
    const next = {};
    for (const view of list || []) {
        if (!view || typeof view.id !== 'string' || BUILTIN[view.id] || view.enabled === false) continue;
        const old = THEMES[view.id];
        next[view.id] = old && !old.builtin && old.rev === view.rev && old.base === view.base ? old : {
            id: view.id,
            name: view.name || view.id,
            description: view.description || '',
            author: view.author || '',
            version: view.version || '',
            api: view.api,
            rev: view.rev || '',
            base: view.base || '',
            colorScheme: view.colorScheme === 'light' ? 'light' : 'dark',
            tokens: view.tokens && typeof view.tokens === 'object' ? view.tokens : {},
            styles: Array.isArray(view.styles) ? view.styles : [],
            icons: cleanIcons(view.icons),
            strings: cleanStrings(view.strings),
            entry: view.entry || null,
            preview: view.preview || null,
            i18n: view.i18n || {},
            dev: !!view.dev,
        };
    }
    const changed = [];
    for (const id of Object.keys(THEMES)) {
        if (BUILTIN[id]) continue;
        if (next[id] !== THEMES[id]) changed.push(id);
        if (!next[id]) delete THEMES[id];
    }
    for (const id of Object.keys(next)) {
        if (!THEMES[id]) changed.push(id);
        THEMES[id] = next[id];
    }
    const defaultChanged = serverDefault !== (defaultId || null);
    serverDefault = defaultId || null;
    const first = !loaded;
    loaded = true;
    const unique = [...new Set(changed)];
    if (unique.length || first || defaultChanged) for (const fn of [...listeners]) fn(unique);
    return unique;
}

/** Ids of every theme on offer: Rainy's own first, then the installed ones by name. */
export function themeIds() {
    const rest = Object.keys(THEMES).filter((id) => !BUILTIN[id])
        .sort((a, b) => THEMES[a].name.localeCompare(THEMES[b].name) || a.localeCompare(b));
    return [...Object.keys(BUILTIN), ...rest];
}

/** Why a theme cannot be worn here: '' when it can, 'api' for another contract version, 'missing'. */
export function unsupportedReason(id) {
    const def = THEMES[id];
    if (!def) return 'missing';
    if (!def.builtin && def.api !== THEME_API) return 'api';
    return '';
}

/** A theme's name or description in a language, as its package translated it. */
export function themeText(id, field, lang) {
    const def = THEMES[id];
    if (!def) return '';
    const own = def.i18n && (def.i18n[lang] || def.i18n[String(lang || '').split('-')[0]]);
    return (own && own[field]) || def[field] || '';
}

/**
 * The theme to wear: the user's pick when it is installed and usable, else
 * the server's default, else Rainy's own. Safe mode and themes that broke on
 * this device this session always give Rainy's own (for the broken one).
 * @param {string|null|undefined} wanted the `ui_theme` preference
 * @param {{ safe?: boolean, failed?: Set<string> }} [opts]
 */
export function chooseTheme(wanted, { safe = false, failed = null } = {}) {
    if (safe) return DEFAULT_THEME;
    const usable = (id) => id && THEMES[id] && !unsupportedReason(id) && !(failed && failed.has(id));
    if (usable(wanted)) return wanted;
    if (!wanted || !THEMES[wanted]) {
        const fallback = defaultTheme();
        if (usable(fallback)) return fallback;
    }
    return DEFAULT_THEME;
}

const TOKEN_NAME = /^--[a-z][a-z0-9-]{0,63}$/;
const BAD_VALUE = /[;{}<>\\]|!\s*important|url\s*\(|expression\s*\(/i;

/** The tokens that are safe to write into a stylesheet (the server checked them; this is a second line). */
export function cleanTokens(tokens) {
    const out = {};
    for (const [name, value] of Object.entries(tokens || {})) {
        if (!TOKEN_NAME.test(name) || typeof value !== 'string' || !value.trim() || value.length > 200) continue;
        if (BAD_VALUE.test(value)) continue;
        out[name] = value.trim();
    }
    return out;
}

const ICON_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/** A theme's icons that point at its own files: { name: url }. */
export function cleanIcons(icons) {
    const out = {};
    for (const [name, url] of Object.entries(icons || {})) {
        if (ICON_NAME.test(name) && isThemeUrl(url) && /\.svg$/i.test(url)) out[name] = url;
    }
    return out;
}

/** A theme's words, plain text only: { lang: { english source: text } }. */
export function cleanStrings(strings) {
    const out = {};
    for (const [lang, table] of Object.entries(strings || {})) {
        if (!LANG.test(lang) || !table || typeof table !== 'object') continue;
        const words = {};
        for (const [key, value] of Object.entries(table)) {
            if (typeof key !== 'string' || !key || key.length > 300) continue;
            if (typeof value !== 'string' || value.length > 160 || /[<>]/.test(value)) continue;
            words[key] = value;
        }
        if (Object.keys(words).length) out[lang] = words;
    }
    return out;
}

/** A theme's tokens and colour scheme as the CSS of its `theme` layer. */
export function buildTokenCss(def) {
    if (!def) return '';
    const lines = [`color-scheme: ${def.colorScheme === 'light' ? 'light' : 'dark'};`];
    for (const [name, value] of Object.entries(cleanTokens(def.tokens))) lines.push(`${name}: ${value};`);
    return `@layer theme {\n:root {\n    ${lines.join('\n    ')}\n}\n}\n`;
}

/** Whether an address belongs to a theme's files (only those go into the page's styles). */
export function isThemeUrl(url) {
    return typeof url === 'string' && /^\/themes\/[a-z][a-z0-9-]{1,31}\/[\w-]{1,40}\/[^"'\s()\\]+$/.test(url) && !url.includes('..');
}

/** What the page remembers of a theme, to put it on before it has talked to the server. */
export function cacheEntry(def) {
    if (!def || def.builtin) return null;
    return {
        id: def.id,
        rev: def.rev,
        api: def.api,
        colorScheme: def.colorScheme,
        tokens: cleanTokens(def.tokens),
        styles: (def.styles || []).filter(isThemeUrl),
        icons: cleanIcons(def.icons),
        strings: cleanStrings(def.strings),
    };
}

/** Read back a remembered theme (null for none, or for anything malformed). */
export function readCache(raw) {
    if (!raw) return null;
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!v || typeof v.id !== 'string' || !TOKEN_NAME.test('--' + v.id) || v.id === DEFAULT_THEME) return null;
        if (v.api !== THEME_API) return null;
        return {
            id: v.id,
            rev: String(v.rev || ''),
            api: v.api,
            colorScheme: v.colorScheme === 'light' ? 'light' : 'dark',
            tokens: cleanTokens(v.tokens),
            styles: Array.isArray(v.styles) ? v.styles.filter(isThemeUrl) : [],
            icons: cleanIcons(v.icons),
            strings: cleanStrings(v.strings),
        };
    } catch (e) {
        return null;
    }
}

/**
 * Safe mode, from the page's address and the tab's memory:
 * `?theme=off` turns it on for the tab, `?theme=on` off again.
 * @returns {{ safe: boolean, remember: boolean|null }} remember: what to store (null: leave it)
 */
export function readSafeMode(search, stored) {
    const param = new URLSearchParams(search || '').get('theme');
    if (param === 'off') return { safe: true, remember: true };
    if (param === 'on') return { safe: false, remember: false };
    return { safe: stored === '1', remember: null };
}
