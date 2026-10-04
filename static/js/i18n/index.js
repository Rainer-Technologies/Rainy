/**
 * Rainy i18n.
 *
 * English source strings are the keys: t('Your Library') looks the string up
 * in the active language's dictionary and falls back to the English text, so
 * an untranslated string still renders. Placeholders use {name}:
 * t('{count} songs', { count }). A dictionary value may be an object of
 * Intl.PluralRules categories ({ one, few, many, other }) for strings that
 * depend on params.count.
 *
 * Static markup in index.html is translated through attributes:
 *   data-i18n            the element's own text nodes (icons/children untouched)
 *   data-i18n-attr="title aria-label placeholder"   those attributes
 *   data-i18n-html       the element's whole innerHTML (sentences with <code>/<strong>)
 */
import english from './locales/en.js';

export const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'ca', name: 'Català' },
    { code: 'es', name: 'Español' },
    { code: 'pl', name: 'Polski' },
];

const SUPPORTED = LANGUAGES.map((l) => l.code);
const STORAGE_KEY = 'rainy-lang';

/** null until the boot call below, so the first setLanguage always scans the markup. */
let current = null;
let dictionary = english;
const pluralRules = new Map();
const listeners = new Set();

/** Supported code for a BCP 47 tag ('es-ES' -> 'es'), else null. */
export function normalizeLanguage(tag) {
    if (typeof tag !== 'string') return null;
    const code = tag.trim().toLowerCase().replace('_', '-').split('-')[0];
    return SUPPORTED.includes(code) ? code : null;
}

/** The first supported language in the browser's preference list. */
export function browserLanguage() {
    const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const tag of tags) {
        const code = normalizeLanguage(tag);
        if (code) return code;
    }
    return 'en';
}

function storedLanguage() {
    try {
        return normalizeLanguage(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
        return null;
    }
}

export function getLanguage() {
    return current || 'en';
}

function pluralCategory(count) {
    const language = getLanguage();
    let rules = pluralRules.get(language);
    if (!rules) {
        rules = new Intl.PluralRules(language);
        pluralRules.set(language, rules);
    }
    return rules.select(count);
}

/**
 * Translate an English source string.
 * @param {string} key
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
export function t(key, params) {
    if (typeof key !== 'string') return key;
    let value = dictionary[key] ?? english[key] ?? key;
    if (value && typeof value === 'object') {
        const count = Number(params?.count);
        value = value[pluralCategory(count)] ?? value.other ?? key;
    }
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (match, name) =>
        params[name] === undefined || params[name] === null ? match : String(params[name]));
}

async function loadDictionary(code) {
    if (code === 'en') return english;
    const module = await import(`./locales/${code}.js`);
    return module.default;
}

/**
 * Switch the UI language: loads the dictionary, re-translates the static
 * markup and notifies onLanguageChange listeners.
 * @param {string} code
 * @param {{ remember?: boolean }} [options] remember caches the choice for the next page load
 * @returns {Promise<boolean>} whether the choice was cached for the next page load
 */
export async function setLanguage(code, { remember = true } = {}) {
    const next = normalizeLanguage(code) || 'en';
    let remembered = false;
    if (remember) {
        try {
            localStorage.setItem(STORAGE_KEY, next);
            remembered = localStorage.getItem(STORAGE_KEY) === next;
        } catch (e) { /* storage unavailable */ }
    }
    if (next === current) return remembered;

    try {
        dictionary = await loadDictionary(next);
        current = next;
    } catch (e) {
        console.warn(`[i18n] Could not load "${next}", falling back to English`, e);
        dictionary = english;
        current = 'en';
    }
    document.documentElement.lang = current;
    translateDom(document.body);
    for (const fn of listeners) {
        try { fn(current); } catch (e) { console.error('[i18n] listener failed', e); }
    }
    return remembered;
}

/** Fill a <select> with the supported languages, each in its own name. */
export function fillLanguageSelect(select) {
    select.replaceChildren(...LANGUAGES.map(({ code, name }) => new Option(name, code)));
    select.value = getLanguage();
}

/**
 * @param {(language: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onLanguageChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// --- Static markup -------------------------------------------------------

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

/** Text node -> { key, value } as last written by translateDom. */
const textRecords = new WeakMap();
/** Element -> { [attr]: { key, value } } */
const attrRecords = new WeakMap();
/** Element -> { key, value } for data-i18n-html */
const htmlRecords = new WeakMap();
const scanned = new WeakSet();

function translateText(el) {
    if (!scanned.has(el)) {
        for (const node of el.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE) continue;
            const key = normalize(node.data);
            if (key) textRecords.set(node, { key, value: node.data });
        }
        scanned.add(el);
    }
    for (const node of el.childNodes) {
        const record = node.nodeType === Node.TEXT_NODE && textRecords.get(node);
        // Skip text the app has rewritten since (usernames, counts, ...).
        if (!record || node.data !== record.value) continue;
        const [, lead, , trail] = record.value.match(/^(\s*)([\s\S]*?)(\s*)$/);
        node.data = lead + t(record.key) + trail;
        record.value = node.data;
    }
}

function translateAttrs(el) {
    let records = attrRecords.get(el);
    if (!records) {
        records = {};
        for (const attr of el.getAttribute('data-i18n-attr').split(/[\s,]+/)) {
            const value = attr && el.getAttribute(attr);
            if (value) records[attr] = { key: normalize(value), value };
        }
        attrRecords.set(el, records);
    }
    for (const [attr, record] of Object.entries(records)) {
        if (el.getAttribute(attr) !== record.value) continue;
        record.value = t(record.key);
        el.setAttribute(attr, record.value);
    }
}

function translateHtml(el) {
    let record = htmlRecords.get(el);
    if (!record) {
        record = { key: normalize(el.innerHTML), value: el.innerHTML };
        htmlRecords.set(el, record);
    }
    if (el.innerHTML !== record.value) return;
    el.innerHTML = t(record.key);
    record.value = el.innerHTML;
}

/**
 * Translate data-i18n / data-i18n-attr / data-i18n-html elements under root.
 * Safe to call repeatedly; content the app has since replaced is left alone.
 * @param {ParentNode} [root]
 */
export function translateDom(root = document.body) {
    if (!root) return;
    const selector = '[data-i18n],[data-i18n-attr],[data-i18n-html]';
    const elements = Array.from(root.querySelectorAll(selector));
    if (root instanceof Element && root.matches(selector)) elements.unshift(root);
    for (const el of elements) {
        if (el.hasAttribute('data-i18n-html')) translateHtml(el);
        else if (el.hasAttribute('data-i18n')) translateText(el);
        if (el.hasAttribute('data-i18n-attr')) translateAttrs(el);
    }
}

// Boot in the cached language (the signed-in user's, from the last visit) or
// the browser's, before any view renders. The app switches to the account's
// saved language once /api/auth/me answers.
await setLanguage(storedLanguage() || browserLanguage(), { remember: false });
