/**
 * Environment host — what Rainy hands an environment, and what it takes back.
 *
 * An environment never reaches into the page: it gets a `ctx` in `mount(ctx)`
 * and works through that. The host owns everything around it, so whatever an
 * environment adds is gone when it leaves the stage, whether or not it
 * cleaned up after itself:
 *
 *   ctx.api                 version of this contract
 *   ctx.id / ctx.manifest   which environment this is
 *   ctx.root                its own layer over the stage: canvases and DOM go in here
 *   ctx.lyrics              the shared LyricsTimeline (what is sung when)
 *   ctx.locale              language of the interface ('en', 'es', …)
 *   ctx.asset(path)         URL of a file of the package
 *   ctx.ui.safeArea()       { top, right, bottom, left }: how much of the stage the player covers, 0..1 of each side
 *   ctx.ui.addButton(o)     a button of its own in the show's HUD → { el, setPressed(on), remove() }
 *   ctx.ui.toast(message)
 *   ctx.ui.fontFamily       the interface's font
 *   ctx.fail(error)         it cannot go on: Rainy falls back to the default environment
 *
 * The layout is the environment's choice (its `layout`), and the host's job:
 *   'stage'      the player as it is, the show behind it
 *   'immersive'  the show is the whole picture: the queue folds away, the song
 *                becomes one small card, and the chrome dims while the pointer rests
 */
import { getLanguage } from '../../i18n/index.js';
import { API_VERSION } from '../sdk.js';

const IDLE_AFTER = 3;        // seconds without the pointer before an immersive layout dims the player
const SAFE_AREA_TTL = 0.5;   // seconds a measured safe area is good for
const STYLE_TIMEOUT = 3000;  // ms to wait for a package's stylesheet before showing it anyway
const LAYOUT_CLASSES = ['ls-immersive', 'ls-idle', 'ls-queue-peek'];
const WAKE_EVENTS = ['pointermove', 'pointerdown', 'keydown'];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class EnvironmentStage {
    /**
     * @param {object} o
     * @param {object} o.def                 the environment's registry entry
     * @param {HTMLElement} o.container      fullscreen player
     * @param {HTMLElement} o.anchor         element the environment's layer goes right after
     * @param {HTMLElement|null} o.hud       where HUD buttons go
     * @param {object} o.lyrics              LyricsTimeline
     * @param {(err: Error) => void} o.onFatal
     * @param {object} [o.internal]          extras for built-in environments only
     */
    constructor({ def, container, anchor, hud, lyrics, onFatal, internal }) {
        this.def = def;
        this.container = container;
        this.hud = hud;
        this.layout = def.layout === 'immersive' ? 'immersive' : 'stage';
        this._links = [];
        this._buttons = new Set();
        this._idleAt = 0;
        this._safe = { top: 0, right: 0, bottom: 0, left: 0 };
        this._safeAt = -1;
        this._gone = false;
        this._wake = () => {
            this._idleAt = performance.now() / 1000 + IDLE_AFTER;
            this.container.classList.remove('ls-idle');
        };

        const root = this.root = document.createElement('div');
        root.className = 'ls-env-root';
        root.dataset.env = def.id;
        root.setAttribute('aria-hidden', 'true');
        anchor.after(root);

        const base = def.baseUrl || '';
        this.ctx = {
            api: API_VERSION,
            id: def.id,
            manifest: def.manifest || { id: def.id, name: def.name },
            root,
            lyrics,
            locale: getLanguage(),
            asset: (path) => base + String(path || '').replace(/^\/+/, ''),
            ui: {
                safeArea: () => this._safeArea(),
                addButton: (o) => this._addButton(o),
                toast: (message) => window.showToast?.(String(message), 'info'),
                fontFamily: getComputedStyle(container).fontFamily,
            },
            fail: (err) => onFatal(err instanceof Error ? err : new Error(String(err))),
        };
        // Built-in environments also draw on the player's own layers.
        if (internal) this.ctx.internal = internal;
    }

    /** The package's stylesheets, in before it mounts (a slow one does not hold the show up for long). */
    loadStyles() {
        const urls = this.def.styles || [];
        return Promise.all(urls.map((href) => new Promise((resolve) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.dataset.lsEnv = this.def.id;
            const timer = setTimeout(resolve, STYLE_TIMEOUT);
            const done = () => { clearTimeout(timer); resolve(); };
            link.addEventListener('load', done, { once: true });
            link.addEventListener('error', done, { once: true });
            this._links.push(link);
            document.head.appendChild(link);
        })));
    }

    /** The environment is mounted: take the layout it asked for and fade its layer in. */
    enter() {
        const c = this.container;
        c.classList.add(`ls-env-${this.def.id}`);
        if (this.layout === 'immersive') {
            c.classList.add('ls-immersive');
            for (const type of WAKE_EVENTS) window.addEventListener(type, this._wake, { passive: true });
            this._wake();
        }
        void this.root.offsetWidth;   // commit the transparent start of the transition
        this.root.classList.add('on');
    }

    /** Once a frame while it is on stage. */
    tick(now) {
        if (this.layout === 'immersive' && now > this._idleAt) this.container.classList.add('ls-idle');
    }

    /** Another environment is taking over: give the layout back and fade out. */
    leave() {
        this._leaveLayout();
        this.root.classList.remove('on');
    }

    /** Off stage: everything it put on the page goes with it. */
    dispose() {
        if (this._gone) return;
        this._gone = true;
        this._leaveLayout();
        for (const b of [...this._buttons]) b.remove();
        for (const link of this._links) link.remove();
        this._links = [];
        this.root.remove();
    }

    _leaveLayout() {
        for (const type of WAKE_EVENTS) window.removeEventListener(type, this._wake);
        this.container.classList.remove(`ls-env-${this.def.id}`);
        if (this.layout === 'immersive') this.container.classList.remove(...LAYOUT_CLASSES);
    }

    _safeArea() {
        const now = performance.now() / 1000;
        if (now - this._safeAt < SAFE_AREA_TTL) return this._safe;
        this._safeAt = now;
        const c = this.container.getBoundingClientRect();
        const h = Math.max(1, c.height);
        let top = c.top, bottom = c.bottom;
        const hud = this.hud && this.hud.getBoundingClientRect();
        if (hud && hud.height > 0) top = Math.max(top, hud.bottom);
        if (this.layout === 'immersive') {
            // The song's card.
            const card = this.container.querySelector('.fs-current-info');
            const r = card && card.getBoundingClientRect();
            if (r && r.height > 0 && r.top < bottom) bottom = r.top;
        }
        // Standard mode keeps the app's player bar over the bottom of the stage.
        if (this.container.classList.contains('mode-standard')) bottom = Math.min(bottom, c.bottom - 90);
        this._safe = { top: clamp01((top - c.top) / h), right: 0, bottom: clamp01((c.bottom - bottom) / h), left: 0 };
        return this._safe;
    }

    _addButton({ icon = '', title = '', onClick, pressed } = {}) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'ls-hud-btn ls-hud-own';
        el.dataset.env = this.def.id;
        el.innerHTML = icon;
        if (title) el.title = title;
        if (pressed !== undefined) el.setAttribute('aria-pressed', String(!!pressed));
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                if (onClick) onClick(e);
            } catch (err) {
                this.ctx.fail(err);
            }
        });
        const handle = {
            el,
            setPressed: (on) => el.setAttribute('aria-pressed', String(!!on)),
            remove: () => {
                el.remove();
                this._buttons.delete(handle);
            },
        };
        if (this.hud && !this._gone) {
            this.hud.appendChild(el);
            this._buttons.add(handle);
        }
        return handle;
    }
}
