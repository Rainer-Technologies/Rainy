/**
 * Light show environments.
 *
 * An environment is a kind of show: one way of staging the music. They all
 * run on the same core (clock, score, sources, conductor, lyrics timeline)
 * and differ only in what they draw and how the lyrics are set.
 *
 * The engine hosts one at a time and talks to it through this contract
 * (only mount, unmount, update and render are required):
 *
 *   mount(ctx)              may be async; `ctx` is what the host gives it (see host.js)
 *   leave()                 another environment is taking over (its layer is already fading out)
 *   unmount()               release everything (DOM, GPU)
 *   setScore(score | null)  the song's score arrived or went away
 *   setTrack(track | null)  { id, title, artist, cover } of the song on stage
 *   onTrackChange()
 *   resize(cssW, cssH, { tier, lowPower, scale })
 *   update(S)               read the show state, fire cues (S.flash/blind/burst), move the lyrics
 *   render(S)               draw the frame
 *   dropLyrics()            take the lyrics off stage now (a new queue started)
 *   hudAxis(now)            where the HUD sits: null = top centre, number = px, undefined = not yet
 *
 * `S` is the conductor (see conductor.js): the musical frame `F`, media time,
 * intensity, hit pulses, phrase, palette, dimmer and the flash limiter.
 *
 * Its registry entry says how it is laid out: `layout` is 'stage' (the
 * player's own layout, the show behind it) or 'immersive' (the show fills the
 * screen). The host arranges the player accordingly.
 *
 * Classic is built in. The others are packages an administrator installed
 * on the server (utils/environments.py, docs/ENVIRONMENTS.md): the server
 * lists them, `setInstalled` puts them in this registry, and a package's
 * module is only fetched when it is picked.
 */

import { API_VERSION } from '../sdk.js';

export const DEFAULT_ENVIRONMENT = 'classic';

const probes = {};

/** Whether this device has a graphics API (checked once each). */
function can(feature) {
    if (feature in probes) return probes[feature];
    let ok = false;
    try {
        if (feature === 'webgpu') ok = typeof navigator !== 'undefined' && 'gpu' in navigator;
        else if (typeof document !== 'undefined') {
            const gl = document.createElement('canvas').getContext(feature);
            ok = !!gl;
            const lose = gl && gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
        }
    } catch (e) { /* not here */ }
    probes[feature] = ok;
    return ok;
}

const BUILTIN = {
    classic: {
        id: 'classic',
        name: 'Classic',
        description: 'The concert rig: lasers, beams and strobes over the album art (default)',
        layout: 'stage',
        builtin: true,
        requires: [],
        load: () => import('./classic/index.js').then((m) => m.ClassicEnvironment),
    },
};

/** Every environment this server offers, by id. Changed in place by `setInstalled`. */
export const ENVIRONMENTS = { ...BUILTIN };

let loaded = false;
const listeners = new Set();

/** The installed environments have been fetched (until then only the built-in one is known). */
export function environmentsLoaded() {
    return loaded;
}

/** Call `fn(changedIds)` whenever the installed environments change. Returns a function that stops it. */
export function onEnvironmentsChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Replace the installed environments with the server's list (`GET /api/environments`).
 * An environment whose files did not change keeps its entry, so whatever holds it can tell.
 * @param {Array<object>} list
 * @returns {string[]} ids that were added, removed or replaced
 */
export function setInstalled(list) {
    const next = {};
    for (const view of list || []) {
        if (!view || typeof view.id !== 'string' || BUILTIN[view.id] || view.enabled === false) continue;
        const old = ENVIRONMENTS[view.id];
        next[view.id] = old && !old.builtin && old.baseUrl === view.base ? old : {
            id: view.id,
            name: view.name || view.id,
            description: view.description || '',
            author: view.author || '',
            version: view.version || '',
            api: view.api,
            layout: view.layout === 'immersive' ? 'immersive' : 'stage',
            requires: Array.isArray(view.requires) ? view.requires : [],
            i18n: view.i18n || {},
            preview: view.preview || null,
            baseUrl: view.base,
            styles: view.styles || [],
            dev: !!view.dev,
            manifest: view,
            load: () => import(view.entry).then((m) => m.default),
        };
    }
    const changed = [];
    for (const id of Object.keys(ENVIRONMENTS)) {
        if (BUILTIN[id]) continue;
        if (next[id] !== ENVIRONMENTS[id]) changed.push(id);
        if (!next[id]) delete ENVIRONMENTS[id];
    }
    for (const id of Object.keys(next)) {
        if (!ENVIRONMENTS[id]) changed.push(id);
        ENVIRONMENTS[id] = next[id];
    }
    const first = !loaded;
    loaded = true;
    const unique = [...new Set(changed)];
    if (unique.length || first) for (const fn of [...listeners]) fn(unique);
    return unique;
}

/** Ids of every environment on offer: the built-in one first, then the installed ones by name. */
export function environmentIds() {
    const rest = Object.keys(ENVIRONMENTS).filter((id) => !BUILTIN[id])
        .sort((a, b) => ENVIRONMENTS[a].name.localeCompare(ENVIRONMENTS[b].name) || a.localeCompare(b));
    return [...Object.keys(BUILTIN), ...rest];
}

/**
 * Why this device cannot run an environment: '' when it can, 'api' when it
 * was written for another version of the contract, otherwise the graphics
 * API it needs and this device lacks.
 */
export function unsupportedReason(id) {
    const def = ENVIRONMENTS[id];
    if (!def) return 'missing';
    if (!def.builtin && def.api !== API_VERSION) return 'api';
    return def.requires.find((feature) => !can(feature)) || '';
}

/** An environment's name or description in a language, as its package translated it. */
export function environmentText(id, field, lang) {
    const def = ENVIRONMENTS[id];
    if (!def) return '';
    const own = def.i18n && (def.i18n[lang] || def.i18n[String(lang || '').split('-')[0]]);
    return (own && own[field]) || def[field] || '';
}

/** A known environment id, whatever was stored in the preferences. */
export function normalizeEnvironment(id) {
    return Object.prototype.hasOwnProperty.call(ENVIRONMENTS, id) ? id : DEFAULT_ENVIRONMENT;
}

/**
 * The environment to actually run for a wanted id: itself when this device
 * can run it and it has not already failed here, the default otherwise.
 * @param {string} id
 * @param {Set<string>} [failed] environments that broke on this device this session
 */
export function resolveEnvironment(id, failed) {
    id = normalizeEnvironment(id);
    if ((failed && failed.has(id)) || unsupportedReason(id)) return DEFAULT_ENVIRONMENT;
    return id;
}

/** The environment after `id` in the list (for the in-show switcher). */
export function nextEnvironment(id) {
    const ids = environmentIds();
    return ids[(ids.indexOf(normalizeEnvironment(id)) + 1) % ids.length];
}
