/**
 * Stage lyrics — kinetic, word-synced lyrics as part of the light show.
 *
 * This is the classic environment's staging of the shared LyricsTimeline
 * (what is sung when). The current line is set in big type in the free band
 * under the (shrunk) artwork; each word fills with light as it is sung.
 * Styling follows the show: section/genre classes pick the typography, and
 * per-frame CSS variables carry the palette, kick pulse, energy, build
 * tension and blackout depth. The engine reads `focus` to aim two follow
 * spots at the word being sung.
 *
 * Everything is derived from media time, like the rest of the show.
 *
 * Words are split into letters that are lit one by one as the word is sung:
 * a letter strikes white-hot, then cools into the palette (see the CSS
 * `ls-ignite` keyframes). The engine reads `focus` (follow-spot target),
 * `onset` (a word just started) and `bar` (the word being sung, for the
 * light bar under it) to make the rig answer the words.
 *
 * Two things are handled apart from the main line:
 *  - Words in (parentheses) are backing vocals / ad-libs. They are pulled out
 *    of the sentence and float on their own layer as echoing italic text
 *    (`adlib` tells the engine where to aim a secondary spot).
 *  - A ♪ line, or a long gap with no vocals, is an instrumental break: the
 *    lyrics step aside for a big ♪ that fills with light as the break runs
 *    out, with notes drifting up on the beat (`interlude` 0..1, and a
 *    `break` cue when it starts).
 */
import { clamp, lerp } from '../../palette.js';
import { HELD, pickTransition } from '../../lyricsTimeline.js';

const OUT_MS = 900;
const SNAP = 0.4;           // media-time jump (s) that counts as a seek

const AD_TAIL = 0.9;        // ad-libs linger this long after their last word

// Note shapes (24×24). Drawn as SVG so the break looks identical everywhere,
// with no dependence on which font happens to carry ♪.
const NOTE_A = '<ellipse cx="8.4" cy="18.6" rx="4.3" ry="3.1" transform="rotate(-22 8.4 18.6)"/>'
    + '<rect x="11.5" y="3.4" width="1.7" height="15.4" rx="0.8"/>'
    + '<path d="M12.4 3.4H13.2c1.6 4.6 7.2 5.2 6.6 11.4-2-3-4.6-4-6.6-4.4H12.4z"/>';
const NOTE_B = '<ellipse cx="6.4" cy="19.4" rx="4" ry="2.9" transform="rotate(-22 6.4 19.4)"/>'
    + '<ellipse cx="17.4" cy="17.4" rx="4" ry="2.9" transform="rotate(-22 17.4 17.4)"/>'
    + '<rect x="9.4" y="5" width="1.7" height="14.6" rx="0.8"/>'
    + '<rect x="20.2" y="3" width="1.7" height="14.6" rx="0.8"/>'
    + '<path d="M9.4 5.2 21.9 3v4.6L9.4 9.9z"/>';
// The big note is a vessel: a wavy liquid surface rises inside it as the break runs out.
const WAVE = `M-12 0q2-2.4 4 0${' t4 0'.repeat(11)}V40H-12z`;
const GLYPH = '<svg class="ls-inter-glyph" viewBox="0 0 24 24" aria-hidden="true"><defs>'
    + `<clipPath id="ls-note-clip">${NOTE_A}</clipPath>`
    // Outline of the merged silhouette (no inner seams): stroked shapes minus the shapes themselves.
    + '<mask id="ls-note-mask" maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">'
    + `<rect x="-2" y="-2" width="28" height="28" fill="#fff"/><g fill="#000">${NOTE_A}</g></mask>`
    + '<linearGradient id="ls-note-grad" gradientUnits="userSpaceOnUse" x1="0" y1="25" x2="0" y2="0">'
    + '<stop offset="0" style="stop-color:var(--c1)"/><stop offset="1" style="stop-color:var(--c2)"/></linearGradient></defs>'
    + `<g class="ls-glyph-body">${NOTE_A}</g>`
    + `<g class="ls-glyph-line" mask="url(#ls-note-mask)">${NOTE_A}</g>`
    + '<g clip-path="url(#ls-note-clip)"><g class="ls-liquid">'
    + `<path class="ls-wave ls-wave-back" d="${WAVE}" fill="url(#ls-note-grad)"/>`
    + `<path class="ls-wave" d="${WAVE}" fill="url(#ls-note-grad)"/></g></g></svg>`;

export class StageLyrics {
    /**
     * @param {HTMLElement} container fullscreen container
     * @param {import('../../lyricsTimeline.js').LyricsTimeline} timeline
     */
    constructor(container, timeline) {
        this.container = container;
        this.timeline = timeline;
        this._version = timeline.version;
        this.idx = -2;
        this.focus = null;       // { x, y, strength } container px
        this.onset = null;       // word that started this frame { x, y, l, r, held, hit, first, strong }
        this.bar = null;         // word being sung { x0, x1, y, p, fade, held, hit }
        this._t = 0;
        this._words = 0;         // words started so far (alternates the spot colour)
        this._band = null;
        this._bandAt = -1;
        this._cur = null;        // { el, words: [{el, s, e, cx, cy, state}] }
        this._next = null;
        this._lastWord = -1;
        this._varsAt = 0;
        this._focusPx = null;
        this._fs = 0;            // smoothed spot strength (fades in/out instead of cutting)
        this._lastNow = 0;
        this._lastTr = '';
        this.cue = null;         // { type } set on the frame a line hands over to the next
        this.adlib = null;       // ad-lib being sung { x, y, strength }
        this.interlude = 0;      // 0..1, how far the stage has gone over to an instrumental break
        this._it = 0;
        this._interOn = false;
        this._noteCount = 0;
        this._axis = 0;          // px the stage is shifted to sit on the cover's centre line
        this.lowPower = false;   // set by the engine: cheaper styling for slow machines
        this._vars = {};         // last value written per CSS variable

        const el = document.createElement('div');
        el.className = 'ls-lyrics';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<div class="ls-lyrics-stack"></div><div class="ls-lyrics-dots"><i></i><i></i><i></i></div>'
            + '<div class="ls-adlibs"></div>'
            + `<div class="ls-interlude">${GLYPH}<div class="ls-notes"></div></div>`;
        this.el = el;
        this.stack = el.children[0];
        this.dots = el.children[1];
        this.adlibLayer = el.children[2];
        this.notes = el.querySelector('.ls-notes');
        container.appendChild(el);
        // Re-measure once the web font is in: word positions drive the spots.
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.invalidateLayout());
    }

    get ready() {
        return this.timeline.ready;
    }

    get lines() {
        return this.timeline.lines;
    }

    /** Backing vocals; the stage keeps each one's element and position on it (el, x, y). */
    get adlibs() {
        return this.timeline.adlibs;
    }

    /** Current lyric band in container px ({ top, height }) once laid out. */
    get band() {
        return this._band;
    }

    /** The timeline swapped its lines (new song, word timings arrived): start over. */
    sync() {
        if (this._version === this.timeline.version) return;
        this._version = this.timeline.version;
        this._reset();
        this.invalidateLayout();
    }

    destroy() {
        this._reset();
        this.el.remove();
    }

    _reset() {
        this.idx = -2;
        this._cur = null;
        this._next = null;
        this._lastWord = -1;
        this.focus = null;
        this.bar = null;
        this._focusPx = null;
        this._fs = 0;
        this._lastTr = '';
        this.stack.textContent = '';
        for (const a of this.adlibs) a.el = null;
        this.adlibLayer.textContent = '';
        this.notes.textContent = '';
        this._noteCount = 0;
        this.adlib = null;
        this.interlude = 0;
        this._it = 0;
        this._interOn = false;
        this.el.classList.remove('resting', 'dots-on');
    }

    /**
     * Lock a line's typography. Anything that changes the size of the text
     * (size, weight, tracking, family) is decided once, from the section and
     * genre at the moment the line takes the stage, and never touched again.
     * If it followed the live section it would reflow the line mid-phrase and
     * push it into the one waiting underneath.
     * @returns {boolean} true if the style changed (so the line needs re-fitting)
     */
    _stamp(line, F) {
        const sec = (F.section && F.section.label) || 'verse';
        const genre = (F.profile && F.profile.genre) || 'pop';
        const build = sec === 'build' ? +(F.buildProgress || 0).toFixed(2) : 0;
        const key = `${sec}|${genre}|${build}`;
        if (line.stamp === key) return false;
        line.stamp = key;
        const el = line.el;
        el.className = el.className.replace(/\s(?:st|sg)-\S+/g, '');
        el.classList.add(`st-${sec}`, `sg-${genre}`);
        el.style.setProperty('--fs-mul', sec === 'chorus' || sec === 'drop' ? '1.06' : '1');
        el.style.setProperty('--lsp', String(build));
        line.measured = false;
        return true;
    }

    _makeLine(i, cls, F) {
        const line = this.lines[i];
        const el = document.createElement('div');
        el.className = `ls-line ${cls}`;
        const words = line.words.map((w, wi) => {
            const span = document.createElement('span');
            span.className = 'ls-w';
            span.style.setProperty('--wi', wi);
            span.style.setProperty('--wd', Math.abs(wi - (line.words.length - 1) / 2).toFixed(2));
            const held = w.e - w.s >= HELD;
            if (held) span.classList.add('held');
            const mask = document.createElement('span');
            mask.className = 'ls-wm';
            const letters = Array.from(w.text).map((ch) => {
                const c = document.createElement('span');
                c.className = 'ls-c';
                c.textContent = ch;
                mask.appendChild(c);
                return c;
            });
            span.appendChild(mask);
            el.appendChild(span);
            el.appendChild(document.createTextNode(' '));
            return {
                el: span, letters, lit: 0, s: w.s, e: w.e, held, hit: false,
                cx: 0, cy: 0, l: 0, r: 0, b: 0, state: 0, p: -1,
            };
        });
        if (line.blank) el.classList.add('blank');
        this.stack.appendChild(el);
        const rec = { el, words, i };
        this._stamp(rec, F);
        return rec;
    }

    /**
     * Word boxes in container px, as they will sit once the line is on stage.
     * Reads the line's current transform (ghost scale, glide, rest) and undoes
     * it, so it is valid at any moment: the spots can aim at a line before it
     * has finished gliding into place.
     */
    _measure(line) {
        const el = line.el;
        this._fit(line);
        if (line === this._next) this._placeGhost(line);
        const base = this.container.getBoundingClientRect();
        const st = this.stack.getBoundingClientRect();
        const lr = el.getBoundingClientRect();
        const sx = lr.width / (el.offsetWidth || 1) || 1;
        const sy = lr.height / (el.offsetHeight || 1) || 1;
        const lcx = lr.left + lr.width / 2, lcy = lr.top + lr.height / 2;
        // The current line is centred in the stack.
        const cx = st.left + st.width / 2 - base.left;
        const cy = st.top + st.height / 2 - base.top;
        for (const w of line.words) {
            const r = w.el.getBoundingClientRect();
            w.cx = cx + (r.left + r.width / 2 - lcx) / sx;
            w.cy = cy + (r.top + r.height / 2 - lcy) / sy;
            w.l = cx + (r.left - lcx) / sx;
            w.r = cx + (r.right - lcx) / sx;
            w.b = cy + (r.bottom - lcy) / sy;
        }
        line.measured = true;
    }

    /**
     * Shrink a line that would take too much of the band, so the current line
     * never grows into the space reserved for the one waiting under it.
     */
    _fit(line) {
        const el = line.el;
        const maxH = (this._band ? this._band.height : 300) * 0.58;
        let fit = 1;
        el.style.setProperty('--fit', '1');
        let h = el.offsetHeight;
        // Lines reflow as they shrink (fewer rows), so converge in a few steps.
        for (let i = 0; i < 4 && h > maxH; i++) {
            fit *= Math.max(0.6, Math.sqrt(maxH / h) * 0.97);
            el.style.setProperty('--fit', fit.toFixed(3));
            h = el.offsetHeight;
        }
        line.h = h;
    }

    /**
     * Park the waiting line right under the current one, whatever height the
     * current line has, scaled down to whatever room is left below it (hidden if
     * there is none), so the two can never overlap.
     */
    _placeGhost(next) {
        const band = this._band ? this._band.height : 300;
        const cur = this._cur;
        const nh = next.h || next.el.offsetHeight || 1;
        let gy = band * 0.36, gs = 0.42, room = true;
        if (cur) {
            const gap = 14;
            const avail = band / 2 - (cur.h || cur.el.offsetHeight) / 2 - gap;
            gs = Math.min(0.42, avail / nh);
            room = gs >= 0.24;
            gs = Math.max(gs, 0.24);
            gy = (cur.h || cur.el.offsetHeight) / 2 + gap + (nh * gs) / 2;
        }
        const st = next.el.style;
        st.setProperty('--gy', `${gy.toFixed(1)}px`);
        st.setProperty('--gs', gs.toFixed(3));
        next.el.classList.toggle('no-room', !room);
    }

    /** Free band between the artwork/title and the controls (container px). */
    _layout(now) {
        if (this._band && now - this._bandAt < 1) return;
        this._bandAt = now;
        const c = this.container.getBoundingClientRect();
        const q = (sel) => {
            const e = this.container.querySelector(sel);
            if (!e) return null;
            const r = e.getBoundingClientRect();
            return r.width || r.height ? r : null;
        };
        // Everything on the stage centres on the cover, wherever the layout puts it.
        const art = q('#fs-artwork');
        const axis = art ? Math.round(art.left + art.width / 2 - (c.left + c.width / 2)) : 0;
        if (axis !== this._axis) {
            this._axis = axis;
            this.el.style.transform = axis ? `translateX(${axis}px)` : '';
            if (this._cur) this._cur.measured = false;
            if (this._next) this._next.measured = false;
        }
        const artist = q('#fs-artist') || q('#fs-title') || q('#fs-artwork');
        const controls = q('.fs-player-controls');
        const info = q('.fs-current-info');
        let top = artist ? artist.bottom - c.top + 18 : c.height * 0.45;
        let bottom = (controls ? controls.top : (info ? info.bottom : c.bottom)) - c.top - 12;
        if (bottom - top < 140) { top = c.height * 0.52; bottom = c.height * 0.9; }
        const band = { top: Math.round(top), height: Math.round(bottom - top) };
        if (!this._band || band.top !== this._band.top || band.height !== this._band.height) {
            this._band = band;
            this.el.style.top = `${band.top}px`;
            this.el.style.height = `${band.height}px`;
            this.el.style.setProperty('--band', `${band.height}px`);
            this.invalidateLayout();
        }
    }

    /**
     * Per-frame update.
     * @param {object} F   musical frame (section, pulse, bands, period, …)
     * @param {number} t   media time
     * @param {object} P   palette
     * @param {number} now perf seconds
     */
    update(F, t, P, now) {
        this.onset = null;
        this.cue = null;
        this.sync();
        if (!this.ready) {
            this.focus = null;
            return;
        }
        this._layout(now);

        // ---- Line changes ----
        const idx = this.timeline.lineIndex(t);
        if (idx !== this.idx) {
            const forward = idx === this.idx + 1;
            const promoted = forward && this._next && this._next.i === idx;
            const tr = forward && idx >= 0 ? (this._lastTr = pickTransition(F, idx, this._lastTr)) : 'lift';
            const dir = idx & 1 ? -1 : 1;
            if (this._cur) {
                const old = this._cur.el;
                old.classList.remove('cur', 'enter');
                old.style.setProperty('--dir', dir);
                if (forward) old.classList.add('out', `tr-${tr}`);
                else old.classList.add('gone');
                setTimeout(() => old.remove(), forward ? OUT_MS : 0);
            }
            if (!forward && this._next) { this._next.el.remove(); this._next = null; }
            this._cur = idx >= 0 ? (promoted ? this._next : this._makeLine(idx, '', F)) : null;
            if (this._cur) {
                // The plain 'lift' lets the waiting ghost glide up by itself; every
                // other hand-over (and any line that appears fresh) animates its words.
                const el = this._cur.el;
                el.style.setProperty('--dir', dir);
                el.classList.remove('next');
                el.classList.add('cur');
                if (!promoted || tr !== 'lift') {
                    const inName = promoted ? tr : 'rise';
                    el.classList.add('enter', `in-${inName}`);
                    setTimeout(() => el.classList.remove('enter', `in-${inName}`), 1500);
                }
                this._cur.measured = false;
                this._stamp(this._cur, F);
                if (forward && idx >= 0) this.cue = { type: tr };
            }
            this._next = idx + 1 < this.lines.length ? this._makeLine(idx + 1, 'next', F) : null;
            this.idx = idx;
            this._lastWord = -1;
        }
        // Word boxes are measured as soon as a line exists, so the spots never
        // aim at an unmeasured (0, 0) or at a line that is still mid-glide.
        if (this._cur && !this._cur.measured) this._measure(this._cur);
        if (this._next && !this._next.measured) this._measure(this._next);

        // ---- Word fill ----
        const snap = F.jumped || Math.abs(t - this._t) > SNAP;
        this._t = t;
        const cur = this._cur;
        let active = -1;
        this.bar = null;
        if (cur) {
            const ws = cur.words;
            let started = -1;
            for (let k = 0; k < ws.length; k++) {
                const w = ws[k];
                const p = clamp((t - w.s) / Math.max(0.05, w.e - w.s), 0, 1);
                if (Math.abs(p - w.p) > 0.01 || (p === 1 && w.p !== 1)) {
                    w.p = p;
                    w.el.style.setProperty('--p', p.toFixed(3));
                }
                const state = t < w.s ? 0 : t < w.e ? 1 : 2;
                if (state !== w.state) {
                    const from = w.state;
                    w.state = state;
                    w.el.classList.toggle('on', state === 1);
                    w.el.classList.toggle('sung', state === 2);
                    if (state === 0) {
                        w.el.classList.remove('hit');
                        w.hit = false;
                    } else if (from === 0 && !snap) {
                        // A word starting on a kick or snare gets the flare.
                        w.hit = F.pulse.k > 0.4 || F.pulse.s > 0.4;
                        w.el.classList.toggle('hit', w.hit);
                        started = k;
                    }
                }
                this._lightLetters(w, snap);
                if (state >= 1) active = k;
            }
            // The next word to be sung is cued shortly before it starts: its outline
            // brightens so the eye knows where the light is going.
            let cueK = -1;
            for (let k = 0; k < ws.length; k++) {
                if (ws[k].state === 0) {
                    if (t > ws[k].s - 0.7) cueK = k;
                    break;
                }
            }
            if (cueK !== cur.cueK) {
                if (cur.cueK >= 0 && ws[cur.cueK]) ws[cur.cueK].el.classList.remove('cue');
                if (cueK >= 0) ws[cueK].el.classList.add('cue');
                cur.cueK = cueK;
            }
            if (active > this._lastWord && active >= 0) {
                const w = ws[active];
                this._words++;
                this.onset = {
                    x: w.cx, y: w.cy, l: w.l, r: w.r, held: w.held,
                    hit: started === active && w.hit, first: active === 0,
                    strong: F.bands.rms > 0.6,
                };
                this._lastWord = active;
            }
            if (active >= 0) {
                const w = ws[active];
                const fade = w.state === 1 ? 1 : 1 - clamp((t - w.e) / 0.4, 0, 1);
                if (fade > 0.02) {
                    this.bar = { x0: w.l, x1: w.r, y: w.b - 2, p: w.state === 1 ? w.p : 1, fade, held: w.held, hit: w.hit };
                }
            }
        }

        // ---- Resting / instrumental countdown ----
        const line = cur ? this.lines[cur.i] : null;
        const next = this.lines[idx + 1] || null;
        const resting = this.timeline.resting(t, idx);
        const gap = next ? next.t0 - t : Infinity;
        const beat = F.period || 0.5;
        const dotsOn = !!(resting && next && gap < beat * 4 + 0.05 && (!line || next.t0 - line.end > 3));
        if (dotsOn) {
            const lit = clamp(Math.floor((beat * 4 - gap) / beat), 0, 3);
            const ds = this.dots.children;
            for (let k = 0; k < 3; k++) ds[k].classList.toggle('lit', k < lit);
        }

        // ---- Show-driven styling (throttled to ~30 Hz, ~8 Hz in low power) ----
        // The variables are inherited by every letter, so each write restyles the
        // whole line; only write the ones that changed.
        if (now - this._varsAt > (this.lowPower ? 0.125 : 0.033)) {
            this._varsAt = now;
            const low = this.lowPower;
            const sec = (F.section && F.section.label) || 'verse';
            const genre = (F.profile && F.profile.genre) || 'pop';
            const want = `ls-lyrics sec-${sec} g-${genre}${this._visible ? ' visible' : ''}${resting ? ' resting' : ''}${dotsOn ? ' dots-on' : ''}${this._it > 0.03 ? ' interlude' : ''}`;
            if (this.el.className !== want) this.el.className = want;
            this._setVar('--c1', `rgb(${P.a[0] | 0},${P.a[1] | 0},${P.a[2] | 0})`);
            this._setVar('--c2', `rgb(${P.b[0] | 0},${P.b[1] | 0},${P.b[2] | 0})`);
            // Low power: the letters stop answering the beat (that restyled them every frame).
            this._setVar('--kick', low ? '0' : F.pulse.k.toFixed(3));
            this._setVar('--snare', low ? '0' : F.pulse.s.toFixed(3));
            this._setVar('--rms', low ? '0' : F.bands.rms.toFixed(3));
            this._setVar('--build', (F.buildProgress || 0).toFixed(low ? 2 : 3));
            this._setVar('--dim', (1 - 0.85 * (F.stopDepth || 0)).toFixed(low ? 2 : 3));
            this._setVar('--it', this._it.toFixed(low ? 2 : 3));
            this._setVar('--prog', (this._prog || 0).toFixed(low ? 2 : 3));
        }

        // ---- Follow-spot target ----
        // The spots never lose the text: while a word is sung they sit on it, in
        // the gap between words they lead to the next one, and between lines they
        // travel ahead to the first word of the upcoming line, fading in and out
        // rather than cutting.
        const dt = clamp(now - (this._lastNow || now), 0.001, 0.1);
        this._lastNow = now;
        let tw = null, goal = 0, tight = false;
        if (cur && !resting) {
            const ws = cur.words;
            if (active >= 0 && ws[active].state === 1) {
                tw = ws[active];
                goal = 1;
                tight = tw.held;
            } else {
                const nxt = ws.find((w) => w.state === 0);
                if (nxt) {
                    tw = nxt;
                    goal = 0.7;
                } else if (this._next && gap < 1.6) {
                    // Line finished: head for the next one before it starts.
                    tw = this._next.words[0];
                    goal = 0.5;
                } else {
                    tw = ws[Math.max(0, active)];
                    goal = 0.45;
                }
            }
        } else if (this._next && gap < 2.5) {
            tw = this._next.words[0];
            goal = 0.15 + 0.45 * (1 - gap / 2.5);
        }
        this._fs += (goal - this._fs) * (1 - Math.exp(-dt * (goal > this._fs ? 10 : 5)));
        if (tw) {
            if (!this._focusPx || this._fs < 0.03) this._focusPx = { x: tw.cx, y: tw.cy };
            else {
                const k = 1 - Math.exp(-dt * 13);
                this._focusPx.x = lerp(this._focusPx.x, tw.cx, k);
                this._focusPx.y = lerp(this._focusPx.y, tw.cy, k);
            }
        }
        this.focus = this._focusPx && this._fs > 0.03
            ? { x: this._focusPx.x, y: this._focusPx.y, strength: this._fs, tight, flip: (this._words & 1) === 1 }
            : null;

        if (cur && cur.measured && now - (this._hAt || 0) > 0.1) {
            this._hAt = now;
            if (Math.abs(cur.el.offsetHeight - cur.h) > 2) {
                cur.measured = false;
                if (this._next) this._next.measured = false;
            }
        }

        this._updateAdlibs(t);
        this._updateInterlude(F, t, dt);
    }

    _setVar(name, value) {
        if (this._vars[name] === value) return;
        this._vars[name] = value;
        this.el.style.setProperty(name, value);
    }

    // ------------------------------------------------------------- ad-libs

    _makeAdlib(a) {
        const el = document.createElement('div');
        el.className = 'ls-adlib';
        a.wordEls = a.words.map((w) => {
            const span = document.createElement('span');
            span.className = 'ls-ad-w';
            span.textContent = w.text;
            span.dataset.t = w.text;
            el.appendChild(span);
            el.appendChild(document.createTextNode(' '));
            return span;
        });
        // Alternate sides and heights so overlapping ad-libs stay apart.
        const left = a.k % 2 ? 24 : 76;
        const top = 3 + (a.k % 3) * 8;
        el.style.left = `${left}%`;
        el.style.top = `${top}%`;
        this.adlibLayer.appendChild(el);
        const layer = this.adlibLayer.getBoundingClientRect();
        const base = this.container.getBoundingClientRect();
        a.x = layer.left - base.left + (layer.width * left) / 100;
        a.y = layer.top - base.top + (layer.height * top) / 100 + el.offsetHeight / 2;
        a.el = el;
        return el;
    }

    /** Backing vocals: show each while it is sung, echo it, then let it drift away. */
    _updateAdlibs(t) {
        let best = null;
        for (const a of this.adlibs) {
            const live = t >= a.s - 0.2 && t <= a.e + AD_TAIL;
            if (live && !a.el) this._makeAdlib(a);
            else if (!live && a.el) {
                a.el.remove();
                a.el = null;
            }
            if (!a.el) continue;
            for (let k = 0; k < a.words.length; k++) {
                const on = t >= a.words[k].s;
                if (on !== a.wordEls[k].classList.contains('on')) a.wordEls[k].classList.toggle('on', on);
            }
            const gone = t > a.e + 0.5;
            if (gone !== a.el.classList.contains('gone')) a.el.classList.toggle('gone', gone);
            if (t >= a.s && t <= a.e + 0.4) best = a;
        }
        this.adlib = best ? { x: best.x, y: best.y, strength: t <= best.e ? 1 : 1 - (t - best.e) / 0.4 } : null;
    }

    // ---------------------------------------------------------- interlude

    /**
     * Instrumental breaks: a ♪ line, the run-in before the first line, or a long
     * gap between lines. The lyrics step aside for a big ♪ that fills with
     * light as the break runs out, and notes rise on the beat.
     */
    _updateInterlude(F, t, dt) {
        const beat = F.period || 0.5;
        const br = this.timeline.breakAt(t, this.idx);
        // The countdown dots take over for the last bars.
        const want = br && br.b - t > beat * 4 ? 1 : 0;
        this._it += (want - this._it) * (1 - Math.exp(-dt * 4));
        if (this._it < 0.002) this._it = 0;
        this.interlude = this._it;
        const on = want === 1;
        if (on && !this._interOn) this.cue = { type: 'break' };
        this._interOn = on;
        this._prog = br && Number.isFinite(br.b) ? clamp((t - br.a) / Math.max(0.1, br.b - br.a - beat * 5), 0, 1) : 0;

        // Notes rise on the beat while the break plays.
        if (this._it > 0.5 && F.newBeat && F.running !== false && this._noteCount < (this.lowPower ? 4 : 10) && Math.random() < 0.6) {
            const n = document.createElement('span');
            n.className = 'ls-note';
            n.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${Math.random() < 0.35 ? NOTE_B : NOTE_A}</svg>`;
            const st = n.style;
            st.setProperty('--x', `${(6 + Math.random() * 88).toFixed(1)}%`);
            st.setProperty('--s', (0.9 + Math.random() * 1.3).toFixed(2));
            st.setProperty('--d', `${(3.2 + Math.random() * 2.4).toFixed(2)}s`);
            st.setProperty('--sw', `${((Math.random() - 0.5) * 120).toFixed(0)}px`);
            st.setProperty('--nc', Math.random() < 0.5 ? 'var(--c1)' : 'var(--c2)');
            n.addEventListener('animationend', () => {
                n.remove();
                this._noteCount--;
            });
            this.notes.appendChild(n);
            this._noteCount++;
        }
    }

    /** Ignite (or extinguish) a word's letters to match how far it has been sung. */
    _lightLetters(w, snap) {
        const n = w.letters.length;
        // Letters ignite left to right, all lit a little before the word ends.
        const target = w.state === 0 ? 0 : w.state === 2 ? n : Math.min(n, 1 + Math.floor(w.p * n * 1.1));
        if (target === w.lit) return;
        if (target > w.lit) {
            for (let k = w.lit; k < target; k++) {
                w.letters[k].classList.add('lit');
                if (snap) w.letters[k].classList.add('settled');
            }
        } else {
            for (let k = target; k < w.lit; k++) w.letters[k].classList.remove('lit', 'settled');
        }
        w.lit = target;
    }

    show(on) {
        this._visible = !!on;
        this.el.classList.toggle('visible', on);
        if (!on) this.focus = null;
    }

    invalidateLayout() {
        this._bandAt = -1;
        if (this._cur) this._cur.measured = false;
        if (this._next) this._next.measured = false;
    }
}
