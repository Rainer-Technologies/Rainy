/**
 * What the app is doing, as attributes on <html> a theme's CSS can select on
 * (`html[data-view="albums"] [data-part~="main"]`), and as events a theme's
 * code can follow. The public names are in contract.json (states).
 *
 * Everything is read from the page itself (the view context, the classes the
 * app already toggles, the audio elements), so new code paths in the app are
 * covered without having to remember to tell this module.
 */
import { useContext } from '../helper/context.js';

const root = document.documentElement;
const listeners = new Set();
let current = {};
let started = false;

/** The state right now: { view, auth, playing, hasTrack, fullscreen, settings, sidebar, track }. */
export function getState() {
    return { ...current };
}

/** Follow changes: `fn(name, value, state)`. Returns a function that stops. */
export function onStateChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function put(name, value) {
    if (current[name] === value) return;
    current[name] = value;
    if (name !== 'track') {
        const attr = 'data-' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        if (value === null || value === undefined) root.removeAttribute(attr);
        else root.setAttribute(attr, String(value));
    }
    for (const fn of [...listeners]) {
        try { fn(name, value, getState()); } catch (e) { console.error('[Rainy theme] state listener failed:', e); }
    }
}

const isShown = (el) => !!el && !el.classList.contains('hidden');

function coverOf(song) {
    if (!song) return null;
    if (song.cover_path) return `/api/music/cover/${encodeURIComponent(song.cover_path)}`;
    return song.cover_url || null;
}

/** Start mirroring the app's state. Safe to call more than once. */
export function startStateBridge() {
    if (started) return;
    started = true;

    const ctx = useContext();
    put('view', ctx.get('current-view-type') || 'library');
    ctx.listen('current-view-type', (_path, _old, value) => put('view', value || 'library'));

    const views = {
        setup: document.getElementById('setup-view'),
        login: document.getElementById('login-view'),
        app: document.getElementById('app-view'),
    };
    const settings = document.getElementById('settings-page');
    const fullscreen = document.getElementById('fullscreen-player');
    const sidebar = document.querySelector('.app-sidebar');

    const readClasses = () => {
        const auth = Object.keys(views).find((k) => isShown(views[k])) || null;
        put('auth', auth);
        put('settings', isShown(settings));
        put('fullscreen', isShown(fullscreen));
        put('sidebar', sidebar && sidebar.classList.contains('collapsed') ? 'collapsed' : 'open');
    };
    readClasses();
    const observer = new MutationObserver(readClasses);
    for (const el of [...Object.values(views), settings, fullscreen, sidebar]) {
        if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    }

    const decks = ['audio-player', 'crossfade-audio'].map((id) => document.getElementById(id)).filter(Boolean);
    const readAudio = () => {
        put('playing', decks.some((a) => !a.paused && !a.ended));
    };
    for (const a of decks) {
        for (const type of ['play', 'playing', 'pause', 'ended', 'emptied']) a.addEventListener(type, readAudio);
    }
    readAudio();

    put('hasTrack', false);
    window.addEventListener('rainy:now-playing', (ev) => {
        const song = ev.detail && ev.detail.song;
        put('hasTrack', !!song);
        put('track', song ? {
            id: song.id ?? null,
            title: song.title || '',
            artist: song.artist || '',
            album: song.album || '',
            cover: coverOf(song),
        } : null);
    });
}
