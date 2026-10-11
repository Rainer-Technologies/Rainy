/**
 * Pulse — the smallest useful Rainy light show environment, as a starting point.
 *
 * It shows the whole contract in one file: draw into your own layer
 * (`ctx.root`), read the show state `S` every frame, ask the conductor for
 * flashes, stage the lyrics your own way and add a button to the HUD.
 * See docs/ENVIRONMENTS.md.
 */
import { TAU, clamp, lerp, mixRgb, rgba } from '@rainy/lightshow';

const BANDS = ['sub', 'bass', 'mid', 'high', 'air'];
const RING_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>';

export default class Pulse {
    /** Rainy hands over `ctx`: your layer, the lyrics, a little UI. Build what you need. */
    mount(ctx) {
        this.ctx = ctx;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'pulse-canvas';
        ctx.root.appendChild(this.canvas);
        this.g = this.canvas.getContext('2d');
        this.line = document.createElement('div');
        this.line.className = 'pulse-line';
        ctx.root.appendChild(this.line);
        this.rings = [];          // { born, power } in media time: a seek never leaves a stale ring
        this.many = false;
        this.shown = '';
        this.button = ctx.ui.addButton({
            icon: RING_ICON,
            title: 'More rings',
            pressed: false,
            onClick: () => {
                this.many = !this.many;
                this.button.setPressed(this.many);
            },
        });
    }

    /** Release what the page cannot: Rainy removes the layer, the stylesheet and the button itself. */
    unmount() {
        this.rings.length = 0;
    }

    onTrackChange() {
        this.rings.length = 0;
    }

    /** `scale` already carries the device pixel ratio and the quality tier Rainy picked. */
    resize(cssW, cssH, { scale }) {
        const w = Math.round(cssW * scale), h = Math.round(cssH * scale);
        if (w === this.canvas.width && h === this.canvas.height) return;
        this.canvas.width = w;
        this.canvas.height = h;
    }

    /** Read the music and decide what happens. No drawing here. */
    update(S) {
        const { F, t } = S;
        if (F.jumped) this.rings.length = 0;
        // A ring on every bar (or every beat), stronger with the kick.
        if (S.running && (this.many ? F.newBeat : F.newBar)) this.rings.push({ born: t, power: 0.5 + 0.5 * S.pulse.k });
        this.rings = this.rings.filter((r) => t - r.born < 2.5 && t >= r.born);
        for (const ev of F.events) {
            // Flashes go through the conductor: it enforces the photosensitivity limit
            // and the user's "reduce flashing" setting. Draw S.flashAmt, never your own strobe.
            if (ev.type === 'drop') S.flash(1, S.palette.w);
            else if (ev.type === 'impact') S.flash(0.4, S.palette.w);
        }
        this._lyrics(S);
    }

    /** The line being sung, with the words already sung lit. */
    _lyrics(S) {
        let html = '';
        if (S.lyricsOn) {
            const i = S.lyrics.lineIndex(S.t);
            const line = i >= 0 ? S.lyrics.lines[i] : null;
            if (line && !line.blank && !S.lyrics.resting(S.t, i)) {
                html = line.words.map((w) => (S.t >= w.s ? `<b>${escape(w.text)}</b>` : escape(w.text))).join(' ');
            }
        }
        if (html !== this.shown) {
            this.shown = html;
            this.line.innerHTML = html;
        }
        this.line.style.opacity = html ? '1' : '0';
        // Stay clear of what the player keeps on screen.
        this.line.style.bottom = `${Math.round(this.ctx.ui.safeArea().bottom * 100) + 4}%`;
    }

    /** Draw the frame. `S.dim` is the master dimmer: pause, blackouts, the breath before a drop. */
    render(S) {
        const { F, t } = S;
        const g = this.g, w = this.canvas.width, h = this.canvas.height;
        const P = S.palette;
        const cx = w / 2, cy = h * 0.46, unit = Math.min(w, h);
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = rgba(P.deep, 0.35);
        g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = 'lighter';

        for (const ring of this.rings) {
            const age = (t - ring.born) / 2.5;
            g.strokeStyle = rgba(mixRgb(P.a, P.b, age), (1 - age) * ring.power * S.dim);
            g.lineWidth = lerp(unit * 0.012, 1, age);
            g.beginPath();
            g.arc(cx, cy, unit * (0.08 + 0.6 * age), 0, TAU);
            g.stroke();
        }

        // The five bands, around the centre. With "disable lasers" on, a calmer, shorter spectrum.
        const reach = S.prefs.disableLasers ? 0.12 : 0.22;
        BANDS.forEach((band, i) => {
            const level = clamp(F.bands[band], 0, 1) * S.dim * (0.5 + 0.5 * S.I);
            for (const side of [-1, 1]) {
                const x = cx + side * unit * (0.1 + i * 0.045);
                g.fillStyle = rgba(mixRgb(P.b, P.w, i / BANDS.length), 0.25 + 0.6 * level);
                g.fillRect(x - unit * 0.012, cy - unit * reach * level, unit * 0.024, unit * reach * level * 2);
            }
        });

        // The heart: the kick.
        g.fillStyle = rgba(P.w, (0.25 + 0.6 * S.pulse.k) * S.dim);
        g.beginPath();
        g.arc(cx, cy, unit * (0.03 + 0.03 * S.pulse.k), 0, TAU);
        g.fill();

        // Whatever the conductor let through of this frame's flashes.
        if (S.flashAmt > 0.01) {
            g.fillStyle = rgba(S.flashColor, 0.6 * S.flashAmt);
            g.fillRect(0, 0, w, h);
        }
    }
}

const escape = (text) => text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
