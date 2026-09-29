/**
 * Canvas renderer for the virtual rig: lasers, moving-head beams, washes,
 * LED pixel bars, halo, haze, sparks, shockwave rings, blinders and flashes.
 *
 * The canvas is transparent: trails fade with destination-out and lights
 * are added with 'lighter', so the (dimmed) album-art backdrop glows through
 * the darkness between beams.
 */
import { TAU, clamp, lerp, rgba, toWhite, mixRgb } from './palette.js';
import { N_PIX } from './scenes.js';

const HAZE_MAX = 90;

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.W = 0;
        this.H = 0;
        this.s = 1;           // device px per CSS px (DPR × quality)
        this.floorPx = 0;     // CSS px reserved at the bottom (player controls)
        this.quality = 0;     // 0 best … 2 lowest
        this.haze = [];
        for (let i = 0; i < HAZE_MAX; i++) {
            this.haze.push({
                x: Math.random(), y: Math.random(),
                vx: (Math.random() - 0.5) * 0.006, vy: -0.004 - Math.random() * 0.01,
                size: 0.8 + Math.random() * 1.8, tw: Math.random() * TAU,
            });
        }
        this.sparks = [];
        this.rings = [];
        this._vignette = null;
        this._vigKey = '';
    }

    resize(cssW, cssH, scale) {
        const W = Math.max(1, Math.round(cssW * scale));
        const H = Math.max(1, Math.round(cssH * scale));
        this.s = scale;
        if (this.canvas.width !== W || this.canvas.height !== H) {
            this.canvas.width = W;
            this.canvas.height = H;
            this._vignette = null;
        }
        this.W = W;
        this.H = H;
        this.floorY = H - this.floorPx * scale;
        this.L = Math.hypot(W, H) * 1.15;
        this.minDim = Math.min(W, this.floorY);
    }

    clear() {
        this.ctx.clearRect(0, 0, this.W, this.H);
        this.sparks.length = 0;
        this.rings.length = 0;
    }

    X(x) { return x * this.W; }
    Y(y) { return y * this.floorY; }

    /** Fade the previous frame (trail persistence 0..1). */
    begin(trail) {
        const ctx = this.ctx;
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = `rgba(0,0,0,${lerp(0.62, 0.12, clamp(trail, 0, 1)).toFixed(3)})`;
        ctx.fillRect(0, 0, this.W, this.H);
        ctx.globalCompositeOperation = 'lighter';
    }

    _glow(x, y, r, color, a) {
        if (a < 0.01 || r < 1) return;
        const ctx = this.ctx;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(toWhite(color, 0.5), a));
        g.addColorStop(0.35, rgba(color, a * 0.45));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // ---------------------------------------------------------------- beams

    beam(b, k) {
        const a = b.alpha * k;
        if (a < 0.01) return;
        const ctx = this.ctx;
        const X = this.X(b.x), Y = this.Y(b.y), L = this.L;
        const dx = Math.sin(b.angle), dy = -Math.cos(b.angle);
        const cone = (w, alpha, reach) => {
            const g = ctx.createLinearGradient(X, Y, X + dx * L * reach, Y + dy * L * reach);
            g.addColorStop(0, rgba(b.color, alpha));
            g.addColorStop(0.3, rgba(b.color, alpha * 0.5));
            g.addColorStop(1, rgba(b.color, 0));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.moveTo(X, Y);
            ctx.lineTo(X + Math.sin(b.angle - w) * L, Y - Math.cos(b.angle - w) * L);
            ctx.lineTo(X + Math.sin(b.angle + w) * L, Y - Math.cos(b.angle + w) * L);
            ctx.closePath();
            ctx.fill();
        };
        cone(b.width, a * 0.55, 0.8);
        cone(b.width * 0.3, a * 0.7, 0.6);
        this._glow(X, Y, 26 * this.s, b.color, Math.min(1, a * 1.6));
    }

    /**
     * Follow spot: a cone from a truss position (normalised) that lands on a
     * target given in CSS px (the word being sung), with a pool of light.
     */
    followSpot(fx, fy, tx, ty, width, alpha, color) {
        if (alpha < 0.01) return;
        const ctx = this.ctx;
        const X = this.X(fx), Y = this.Y(fy);
        const TX = tx * this.s, TY = ty * this.s;
        const dx = TX - X, dy = TY - Y;
        const reach = Math.hypot(dx, dy) * 1.06;
        const ang = Math.atan2(dx, -dy);
        const g = ctx.createLinearGradient(X, Y, TX, TY);
        g.addColorStop(0, rgba(color, alpha * 0.55));
        g.addColorStop(0.6, rgba(color, alpha * 0.22));
        g.addColorStop(1, rgba(color, alpha * 0.4));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(X, Y);
        ctx.lineTo(X + Math.sin(ang - width) * reach, Y - Math.cos(ang - width) * reach);
        ctx.lineTo(X + Math.sin(ang + width) * reach, Y - Math.cos(ang + width) * reach);
        ctx.closePath();
        ctx.fill();
        this._glow(X, Y, 22 * this.s, color, Math.min(1, alpha * 1.8));
    }

    /** Soft pool of light behind the lyric focus. */
    pool(tx, ty, r, alpha, color) {
        if (alpha < 0.01) return;
        const ctx = this.ctx;
        const X = tx * this.s, Y = ty * this.s, R = r * this.s;
        ctx.save();
        ctx.translate(X, Y);
        ctx.scale(1.8, 1);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
        g.addColorStop(0, rgba(color, alpha * 0.5));
        g.addColorStop(0.5, rgba(color, alpha * 0.18));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-R, -R, R * 2, R * 2);
        ctx.restore();
    }

    /** Darken an elliptical area (CSS px) so text on top stays readable. */
    scrim(cx, cy, rx, ry, alpha) {
        if (alpha < 0.01) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.translate(cx * this.s, cy * this.s);
        ctx.scale(rx / ry, 1);
        const R = ry * this.s;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
        g.addColorStop(0, `rgba(0,0,0,${alpha.toFixed(3)})`);
        g.addColorStop(0.6, `rgba(0,0,0,${(alpha * 0.6).toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-R, -R, R * 2, R * 2);
        ctx.restore();
        ctx.globalCompositeOperation = 'lighter';
    }

    /**
     * Light bar under the word being sung (CSS px): a hot line that grows
     * with the word (p = 0..1) with a bloom and a bright leading edge.
     */
    lyricBar(x0, x1, y, p, fade, color, boost = 0) {
        const a = fade * (0.6 + 0.4 * boost);
        if (a < 0.02 || p <= 0) return;
        const ctx = this.ctx, s = this.s;
        const X0 = x0 * s, X1 = (x0 + (x1 - x0) * p) * s, Y = y * s;
        // Bloom: a flattened ellipse so it fades out at the ends as well as above and below.
        const glowH = (20 + 10 * boost) * s;
        const rx = (X1 - X0) / 2 + 18 * s;
        ctx.save();
        ctx.translate((X0 + X1) / 2, Y);
        ctx.scale(rx / glowH, 1);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, glowH);
        g.addColorStop(0, rgba(color, a * 0.55));
        g.addColorStop(0.5, rgba(color, a * 0.2));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-glowH, -glowH, glowH * 2, glowH * 2);
        ctx.restore();
        const h = (1.6 + 1.6 * boost) * s;
        const core = ctx.createLinearGradient(X0, 0, Math.max(X1, X0 + 1), 0);
        core.addColorStop(0, rgba(toWhite(color, 0.75), 0));
        core.addColorStop(0.25, rgba(toWhite(color, 0.75), a));
        core.addColorStop(1, rgba(toWhite(color, 0.85), a));
        ctx.fillStyle = core;
        ctx.fillRect(X0, Y - h / 2, X1 - X0, h);
        this._glow(X1, Y, (26 + 14 * boost) * s, color, Math.min(1, a * 1.3));
    }

    /**
     * Small spark spray from a point in CSS px (a word landing on a hit);
     * `spread` scatters the origin horizontally along the word's width.
     */
    sprayAt(tx, ty, count, colors, spread = 0) {
        const s = this.s;
        const cap = [260, 160, 90][this.quality];
        count = Math.min(count, cap - this.sparks.length);
        for (let i = 0; i < count; i++) {
            const ang = Math.random() * TAU;
            const sp = (180 + Math.random() * 420) * s;
            this.sparks.push({
                x: (tx + (Math.random() - 0.5) * spread) * s, y: ty * s,
                vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 250 * s,
                life: 0.8, decay: 1.2 + Math.random() * 0.8,
                color: colors[i % colors.length],
            });
        }
    }

    // --------------------------------------------------------------- lasers

    fan(f, k) {
        const a = f.alpha * k;
        if (a < 0.01 || f.count < 1) return;
        const ctx = this.ctx;
        const X = this.X(f.x), Y = this.Y(f.y), L = this.L;
        const r0 = (f.r0 || 0) * this.minDim;
        const full = f.spread >= TAU - 1e-3;
        ctx.beginPath();
        for (let i = 0; i < f.count; i++) {
            const ang = full ? f.angle + (TAU * i) / f.count
                : f.count === 1 ? f.angle : f.angle - f.spread / 2 + (f.spread * i) / (f.count - 1);
            const sx = Math.sin(ang), sy = -Math.cos(ang);
            ctx.moveTo(X + sx * r0, Y + sy * r0);
            ctx.lineTo(X + sx * L, Y + sy * L);
        }
        const s = this.s, thick = f.thick || 1;
        ctx.lineCap = 'round';
        // Glow + hot core. (A third, wider glow pass looked marginally softer
        // but doubled fill cost on dense laser scenes.)
        if (this.quality < 2) {
            ctx.lineWidth = 7 * thick * s;
            ctx.strokeStyle = rgba(f.color, a * 0.18);
            ctx.stroke();
        }
        ctx.lineWidth = 1.4 * thick * s;
        ctx.strokeStyle = rgba(toWhite(f.color, 0.45), a);
        ctx.stroke();
        if (!r0) this._glow(X, Y, 14 * s, f.color, Math.min(1, a * 1.8));
    }

    // --------------------------------------------------------------- washes

    wash(w, dim) {
        const ctx = this.ctx, W = this.W, H = this.floorY;
        const side = (x0, x1, col, a) => {
            if (a * dim < 0.01) return;
            const g = ctx.createLinearGradient(x0, 0, x1, 0);
            g.addColorStop(0, rgba(col, a * dim * 0.55));
            g.addColorStop(1, rgba(col, 0));
            ctx.fillStyle = g;
            ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), this.H);
        };
        side(0, W * 0.35, w.colL, w.l);
        side(W, W * 0.65, w.colR, w.r);
        if (w.top * dim > 0.01) {
            const g = ctx.createLinearGradient(0, 0, 0, H * 0.4);
            g.addColorStop(0, rgba(w.colTop, w.top * dim * 0.6));
            g.addColorStop(1, rgba(w.colTop, 0));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H * 0.4);
        }
        if (w.floor * dim > 0.01) {
            const g = ctx.createRadialGradient(W / 2, H, 0, W / 2, H, Math.max(W, H) * 0.6);
            g.addColorStop(0, rgba(w.colFloor, w.floor * dim * 0.6));
            g.addColorStop(1, rgba(w.colFloor, 0));
            ctx.fillStyle = g;
            // Fill the whole gradient footprint — clipping it drew a hard edge.
            const top = Math.max(0, H - Math.max(W, H) * 0.6);
            ctx.fillRect(0, top, W, this.H - top);
        }
    }

    halo(h, dim, cx = 0.5, cy = 0.45) {
        const a = h.alpha * dim;
        if (a < 0.01) return;
        const ctx = this.ctx;
        const X = this.X(cx), Y = this.Y(cy), r = h.r * this.minDim * 1.4;
        const g = ctx.createRadialGradient(X, Y, r * 0.15, X, Y, r);
        g.addColorStop(0, rgba(h.color, a * 0.5));
        g.addColorStop(0.5, rgba(h.color, a * 0.18));
        g.addColorStop(1, rgba(h.color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(X - r, Y - r, r * 2, r * 2);
    }

    /** LED battens along the floor and the top truss. */
    pixels(px, dim) {
        const a = px.alpha * dim;
        if (a < 0.02) return;
        const ctx = this.ctx, s = this.s;
        const x0 = this.W * 0.04, span = this.W * 0.92, cw = span / N_PIX;
        const h = 4 * s;
        for (const [y, flip] of [[this.floorY - 10 * s, false], [5 * s, true]]) {
            for (let i = 0; i < N_PIX; i++) {
                const v = px.cells[flip ? N_PIX - 1 - i : i] * a;
                if (v < 0.02) continue;
                const col = mixRgb(px.colA, px.colB, i / (N_PIX - 1));
                const x = x0 + i * cw + cw * 0.12;
                ctx.fillStyle = rgba(col, v * 0.25);
                ctx.fillRect(x - 4 * s, y - 6 * s, cw * 0.76 + 8 * s, h + 12 * s);
                ctx.fillStyle = rgba(toWhite(col, 0.35), v);
                ctx.fillRect(x, y, cw * 0.76, h);
            }
            if (this.quality === 2) break; // floor only on low quality
        }
    }

    // ----------------------------------------------------------------- haze

    /**
     * Haze particles light up where beams pass through them.
     * @param {Array<{x:number,y:number,dx:number,dy:number,w:number,a:number,color:number[]}>} lights
     */
    hazeLayer(amount, lights, hat, dt) {
        const ctx = this.ctx, W = this.W, H = this.floorY, s = this.s;
        const n = Math.round(HAZE_MAX * [1, 0.6, 0.35][this.quality] * amount);
        for (let i = 0; i < n; i++) {
            const p = this.haze[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.y < -0.05) { p.y = 1.02; p.x = Math.random(); }
            if (p.x < -0.05) p.x = 1.04;
            if (p.x > 1.05) p.x = -0.04;
            const px = p.x * W, py = p.y * H;
            let lit = 0, col = null;
            for (const l of lights) {
                const ox = px - l.x, oy = py - l.y;
                const u = ox * l.dx + oy * l.dy;
                if (u <= 0) continue;
                const perp = Math.abs(ox * l.dy - oy * l.dx);
                const width = u * l.w + 8 * s;
                const v = (1 - perp / width) * l.a;
                if (v > lit) { lit = v; col = l.color; }
            }
            const tw = 0.5 + 0.5 * Math.sin(p.tw + i);
            const base = 0.04 + hat * 0.25 * tw;
            const alpha = clamp(base + lit * 1.3, 0, 1);
            if (alpha < 0.03) continue;
            const c = col ? toWhite(col, 0.3) : [220, 225, 255];
            const r = p.size * s * (1 + lit);
            ctx.fillStyle = rgba(c, alpha * 0.35);
            ctx.fillRect(px - r * 2, py - r * 2, r * 4, r * 4);
            ctx.fillStyle = rgba(c, alpha);
            ctx.fillRect(px - r / 2, py - r / 2, r, r);
        }
    }

    // ------------------------------------------------------- sparks & rings

    burst(count, colors, strength = 1) {
        const s = this.s;
        const cap = [260, 160, 90][this.quality];
        count = Math.min(count, cap - this.sparks.length);
        for (let i = 0; i < count; i++) {
            const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
            const sp = (500 + Math.random() * 900) * s * strength;
            this.sparks.push({
                x: this.W * (0.3 + Math.random() * 0.4), y: this.floorY,
                vx: Math.sin(ang) * sp * 0.6, vy: -Math.abs(Math.cos(ang)) * sp,
                life: 1, decay: 0.5 + Math.random() * 0.7,
                color: colors[i % colors.length],
            });
        }
    }

    ring(kind, color, alpha, speed = 1) {
        if (this.rings.length > 12) this.rings.shift();
        this.rings.push({ kind, color, alpha, r: 0, speed });
    }

    effects(dt, dim) {
        const ctx = this.ctx, s = this.s;
        // Sparks
        ctx.lineCap = 'round';
        for (let i = this.sparks.length - 1; i >= 0; i--) {
            const p = this.sparks[i];
            p.vy += 1400 * s * dt;
            p.vx *= Math.exp(-dt * 0.8);
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.life -= p.decay * dt;
            if (p.life <= 0 || p.y > this.H + 20) { this.sparks.splice(i, 1); continue; }
            ctx.strokeStyle = rgba(toWhite(p.color, 0.4), p.life * dim);
            ctx.lineWidth = 2 * s;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
            ctx.stroke();
        }
        // Rings
        for (let i = this.rings.length - 1; i >= 0; i--) {
            const r = this.rings[i];
            r.r += dt * r.speed * this.minDim * 1.1;
            r.alpha *= Math.exp(-dt / 0.35);
            if (r.alpha < 0.02) { this.rings.splice(i, 1); continue; }
            ctx.strokeStyle = rgba(toWhite(r.color, 0.3), r.alpha * dim);
            ctx.lineWidth = (3 + 6 * r.alpha) * s;
            ctx.beginPath();
            if (r.kind === 'floor') {
                ctx.ellipse(this.W / 2, this.floorY - 14 * s, r.r * 1.4, r.r * 0.2, 0, 0, TAU);
            } else {
                ctx.arc(this.X(0.5), this.Y(0.45), this.minDim * 0.2 + r.r * 0.8, 0, TAU);
            }
            ctx.stroke();
        }
    }

    // --------------------------------------------------- overlays (on top)

    blinders(amount, color) {
        if (amount < 0.02) return;
        const s = this.s;
        for (let i = 0; i < 5; i++) {
            const x = this.W * (0.18 + 0.16 * i);
            this._glow(x, 14 * s, 70 * s, toWhite(color, 0.6), amount);
        }
    }

    flash(amount, color) {
        if (amount < 0.01) return;
        const ctx = this.ctx;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = rgba(color, clamp(amount * 0.6, 0, 0.65));
        ctx.fillRect(0, 0, this.W, this.H);
        ctx.globalCompositeOperation = 'lighter';
    }

    vignette() {
        const ctx = this.ctx, W = this.W, H = this.H;
        const key = `${W}x${H}`;
        if (!this._vignette || this._vigKey !== key) {
            this._vigKey = key;
            const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
            g.addColorStop(0, 'rgba(0,0,0,0)');
            g.addColorStop(1, 'rgba(0,0,0,0.45)');
            this._vignette = g;
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = this._vignette;
        ctx.fillRect(0, 0, W, H);
    }

    /** Light segments for the haze layer (beams + fan centre lines). */
    lightsOf(look, k) {
        const out = [];
        for (const b of look.beams) {
            if (b.alpha * k < 0.05) continue;
            out.push({ x: this.X(b.x), y: this.Y(b.y), dx: Math.sin(b.angle), dy: -Math.cos(b.angle), w: Math.tan(b.width), a: b.alpha * k, color: b.color });
        }
        for (const f of look.lasers) {
            if (f.alpha * k < 0.05 || f.spread >= TAU - 1e-3) continue;
            out.push({ x: this.X(f.x), y: this.Y(f.y), dx: Math.sin(f.angle), dy: -Math.cos(f.angle), w: Math.tan(Math.min(1.2, f.spread / 2)) , a: f.alpha * k * 0.5, color: f.color });
        }
        return out;
    }
}
