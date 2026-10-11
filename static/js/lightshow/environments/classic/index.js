/**
 * Classic environment — the concert rig, drawn on a 2D canvas over the
 * album-art backdrop.
 *
 *  - Director    — scene per section × genre profile, 8-bar phrase
 *                  variations, crossfades.
 *  - Renderer    — lasers, beams, washes, LED bars, haze, sparks, rings,
 *                  blinders and (photosensitivity-limited) strobes.
 *  - StageLyrics — optional kinetic, word-synced lyrics with follow spots,
 *                  in the band under the (shrunk) artwork.
 */
import { lerp, mixRgb } from '../../palette.js';
import { Director } from './scenes.js';
import { Renderer } from './fixtures.js';
import { StageLyrics } from './lyrics.js';

const HUD_SETTLE = 0.7;      // seconds to wait for the stage layout before the HUD moves to the cover

export class ClassicEnvironment {
    static id = 'classic';

    layout = 'stage';

    constructor() {
        this.container = null;
        this.canvas = null;
        this.backdrop = null;
        this.renderer = null;
        this.director = new Director();
        this.stage = null;
        this._stageOn = false;
        this._stageAt = 0;
        this._lastSprayAt = 0;
        this._lastSub = -1;
        this._lowPower = false;
        this._backdropKey = '';
        this._look = null;
    }

    /**
     * @param {object} o
     * @param {HTMLElement} o.container        fullscreen container (layout classes, lyrics layer)
     * @param {HTMLCanvasElement} o.canvas     the shared 2D canvas
     * @param {HTMLElement} o.backdrop         album-art backdrop (pumped with the sub bass)
     * @param {import('../../lyricsTimeline.js').LyricsTimeline} o.lyrics
     */
    mount({ container, canvas, backdrop, lyrics }) {
        this.container = container;
        this.canvas = canvas;
        this.backdrop = backdrop;
        this.renderer = new Renderer(canvas);
        this.stage = new StageLyrics(container, lyrics);
        canvas.classList.remove('hidden');
    }

    /** Start fading out: the next environment is taking over. */
    leave() {
        this._setStage(false);
        this.canvas.classList.add('hidden');
    }

    unmount() {
        this._setStage(false);
        this.renderer.clear();
        this.canvas.style.filter = 'none';
        this.canvas.classList.add('hidden');
        this.stage.destroy();
        this.stage = null;
    }

    setScore(score) {
        if (score) this.director.reset();
    }

    setTrack() { /* the artwork and backdrop are the page's own */ }

    onTrackChange() {
        this.director.reset();
        this.renderer.sparks.length = 0;
        this.renderer.rings.length = 0;
    }

    resize(cssW, cssH, { tier, lowPower, scale }) {
        const r = this.renderer;
        r.floorPx = this.container.classList.contains('mode-standard') ? 90 : 0;
        r.quality = lowPower ? 2 : tier;
        r.lowPower = lowPower;
        if (lowPower !== this._lowPower) {
            this._lowPower = lowPower;
            this._backdropKey = '';
        }
        r.resize(cssW, cssH, scale);
    }

    /** Stage lyrics are up (queue hidden, art shrunk). */
    get lyricsOn() {
        return this._stageOn;
    }

    dropLyrics() {
        this._setStage(false);
    }

    /**
     * Where the HUD goes: null = pinned to the top centre, a number = the
     * cover's centre line (container px), undefined = layout still settling.
     * With lyrics on stage it waits for the cover's own layout transition and
     * then glides there once, rather than chasing the cover while it resizes.
     */
    hudAxis(now) {
        if (!this._stageOn) return null;
        if (now - this._stageAt < HUD_SETTLE) return undefined;
        const art = this.container.querySelector('#fs-artwork');
        if (!art) return undefined;
        const r = art.getBoundingClientRect();
        if (!r.width) return undefined;
        return Math.round(r.left - this.container.getBoundingClientRect().left + r.width / 2);
    }

    /** Read the music: pick the looks, fire the rig's cues, move the lyrics. */
    update(S) {
        const { F, I, prefs, now } = S;
        const P = S.palette;
        const r = this.renderer;
        const running = S.running;

        // ---- Direction ----
        const look = this._look = this.director.update(F, P, { I, lasers: !prefs.disableLasers, phrase: S.phrase });
        const { a, b, mix } = look;

        // ---- Triggers ----
        const St = blendNum(a.strobe, b && b.strobe, mix);
        const flashScale = 0.4 + 0.6 * I;
        let fl = 0;
        if (F.hits.s >= 0.45) fl = Math.max(fl, St.snare * F.hits.s);
        if (F.hits.k >= 0.5) fl = Math.max(fl, St.kick * F.hits.k);
        if (F.newBar) fl = Math.max(fl, St.bar);
        if (St.sub > 0.01) {
            const n = Math.floor(F.beat * (a.strobe.subN || 1));
            if (n !== this._lastSub && this._lastSub !== -1) fl = Math.max(fl, St.sub);
            this._lastSub = n;
        } else this._lastSub = -1;
        if (running && fl > 0.02) S.flash(fl * flashScale, P.w);

        const Bl = blendNum(a.blinders, b && b.blinders, mix);
        let bl = 0;
        if (F.hits.s >= 0.5) bl = Math.max(bl, Bl.snare * F.hits.s);
        if (F.newBar && F.hits.k > 0.2) bl = Math.max(bl, Bl.bar);
        if (bl > 0.05 && running) S.blind(bl * (prefs.reduceFlashing ? 0.4 : 1) * flashScale);

        const R = blendNum(a.rings, b && b.rings, mix);
        if (running) {
            if (F.newBar && R.bar > 0.1) r.ring('floor', P.a, 0.5 * R.bar);
            if (F.hits.k > 0.6 && R.kick > 0.1) r.ring('halo', P.b, 0.4 * R.kick * F.hits.k, 1.3);
            const sp = lerp(b ? b.sparks : a.sparks, a.sparks, mix);
            if (sp > 0.05 && F.hits.k > 0.75 && F.newBeat) r.burst(Math.round(10 * sp * I), [P.a, P.b, P.w], 0.6);
        }
        for (const ev of F.events) this._onEvent(ev, S);

        // ---- Stage lyrics ----
        const stage = this.stage;
        stage.sync();
        this._setStage(S.lyricsOn);
        if (this._stageOn) {
            stage.lowPower = prefs.lowPower;
            stage.update(F, S.t, P, now);
            const lbl = F.section && F.section.label;
            const hot = lbl === 'drop' || lbl === 'chorus';
            const on = stage.onset;
            if (running && on) {
                // Embers fly off words that land on a hit (or are held) in the hot
                // sections, spread along the word instead of from a point.
                if (hot && I > 0.5 && now - this._lastSprayAt > 0.2 && ((on.hit && on.strong) || on.held || F.hits.k > 0.5)) {
                    this._lastSprayAt = now;
                    r.sprayAt(on.x, on.y, Math.round(6 + 8 * I), [P.a, P.b, P.w], Math.max(0, on.r - on.l));
                }
            }
            // Line hand-overs are cues for the rig too.
            const cue = stage.cue;
            if (running && cue && I > 0.4) {
                if (cue.type === 'slam') {
                    S.flashAmt = Math.max(S.flashAmt, 0.3 * I);
                    r.ring('floor', P.a, 0.5 * I, 1);
                } else if (cue.type === 'fall') {
                    r.ring('floor', P.b, 0.4 * I, 0.7);
                } else if (cue.type === 'flicker') {
                    S.blind(0.5 * I);
                } else if (cue.type === 'break') {
                    // The vocals drop out and the rig takes the stage.
                    S.blind(0.6 * I);
                    r.ring('floor', P.b, 0.5 * I, 0.9);
                }
            }
        }
    }

    _onEvent(ev, S) {
        const r = this.renderer;
        const P = S.palette, I = S.I;
        if (ev.type === 'drop') {
            S.flash(1, P.w);
            S.burst(1);
            r.ring('floor', P.w, 1, 1.4);
            r.ring('floor', P.a, 0.8, 0.9);
            r.ring('halo', P.b, 0.9, 1.2);
            r.burst(Math.round(90 + 90 * I), [P.a, P.b, P.c, P.w], 1);
        } else if (ev.type === 'impact') {
            S.flash(0.5, P.w);
            S.burst(0.5);
            r.ring('halo', P.a, 0.7, 1.1);
            r.burst(Math.round(40 * I), [P.a, P.w], 0.8);
        }
    }

    /** Enter/leave the stage-lyrics layout (queue hidden, art shrunk). */
    _setStage(on) {
        on = !!on;
        if (on === this._stageOn) return;
        this._stageOn = on;
        this._stageAt = performance.now() / 1000;
        this.container.classList.toggle('ls-stage', on);
        const stage = this.stage;
        stage.show(on);
        stage.invalidateLayout();
        // Re-measure once the layout transition has settled.
        setTimeout(() => this.stage === stage && stage.invalidateLayout(), 600);
    }

    render(S) {
        const { F, prefs } = S;
        // A CSS blur on a canvas that changes every frame is re-filtered every frame.
        const want = prefs.showBgBlur && !prefs.lowPower ? 'blur(24px)' : 'none';
        if (this.canvas.style.filter !== want) this.canvas.style.filter = want;

        this._draw(S);

        if (this.backdrop) {
            // Low power: no sub-bass pump, so the heavily blurred backdrop is
            // only recomposited when the dimmer moves (blackouts, pause).
            const scale = prefs.lowPower ? 1.02 : 1.02 + 0.05 * S.pulse.k * S.dim;
            const opacity = prefs.lowPower ? 0.5 * Math.round(S.dim * 10) / 10 : (0.4 + 0.35 * F.bands.rms) * S.dim;
            const key = `${scale.toFixed(3)}|${opacity.toFixed(3)}`;
            if (key !== this._backdropKey) {
                this._backdropKey = key;
                this.backdrop.style.transform = `scale(${scale.toFixed(3)})`;
                this.backdrop.style.opacity = opacity.toFixed(3);
            }
        }
    }

    _draw(S) {
        const { F, dt } = S;
        const P = S.palette;
        const { a, b, mix } = this._look;
        const r = this.renderer;
        const dim = S.dim;
        const boost = 1 + 0.6 * S.burstAmt;
        r.begin(lerp(b ? b.trail : a.trail, a.trail, mix) * (F.stopDepth > 0 ? 0.3 : 1));

        const wash = blendWash(a.wash, b && b.wash, mix);
        r.wash(wash, dim);
        const halo = { alpha: lerp(b ? b.halo.alpha : a.halo.alpha, a.halo.alpha, mix), r: lerp(b ? b.halo.r : a.halo.r, a.halo.r, mix), color: a.halo.color };
        r.halo(halo, dim);

        const ka = mix * dim * boost, kb = (1 - mix) * dim * boost;
        if (b && kb > 0.01) {
            for (const beam of b.beams) r.beam(beam, kb);
            for (const f of b.lasers) r.fan(f, kb);
        }
        for (const beam of a.beams) r.beam(beam, ka);
        for (const f of a.lasers) r.fan(f, ka);

        // The lone laser through the blackout before a drop.
        if (F.stopDepth > 0) {
            const sweep = 0.06 * Math.sin(F.t * 3);
            r.fan({ x: -0.02, y: 0.5, angle: Math.PI / 2 + sweep, spread: 0, count: 1, alpha: 0.85, thick: 1.2, color: P.w }, F.stopDepth);
        }

        const hazeAmt = lerp(b ? b.haze : a.haze, a.haze, mix);
        const lights = r.lightsOf(a, ka);
        if (b && kb > 0.05) lights.push(...r.lightsOf(b, kb));
        r.hazeLayer(hazeAmt, lights.slice(0, this._lowPower ? 6 : 16), S.pulse.h * dim, dt);

        // Follow spots on the word being sung.
        const stage = this.stage;
        const band = this._stageOn && stage.band;
        if (band) {
            // Pull the lasers back behind the lyric band so the words read.
            const w = this.canvas.width / r.s;
            // (Not during an instrumental break: no words to protect, the rig gets the stage.)
            r.scrim(w / 2, band.top + band.height / 2, Math.min(w * 0.46, 620), band.height * 0.5, 0.55 * (1 - stage.interlude));
        }
        // Backing vocals get their own small spot and pool in the second colour.
        const ad = this._stageOn && stage.adlib;
        if (ad) {
            const k = ad.strength * Math.max(dim, 0.5);
            r.pool(ad.x, ad.y, 90, (0.2 + 0.15 * S.pulse.k) * k, P.b);
            r.followSpot(ad.x < this.canvas.width / r.s / 2 ? 0.95 : 0.05, 0, ad.x, ad.y, 0.03, 0.14 * k, mixRgb(P.w, P.b, 0.35));
        }
        const focus = this._stageOn && stage.focus;
        if (focus) {
            const lbl = F.section && F.section.label;
            const quiet = lbl === 'intro' || lbl === 'outro' || lbl === 'breakdown';
            const spotA = (quiet ? 0.44 : 0.36 + 0.2 * F.bands.rms) * Math.max(dim, 0.55) * focus.strength;
            // Each word is picked out in the other palette colour; held notes
            // get a tighter, brighter cone. The two spots are different colours
            // and land together in one pool of light on the word.
            const tone = focus.flip ? P.b : P.a;
            const other = focus.flip ? P.a : P.b;
            const kick = S.prefs.reduceFlashing ? 0.25 * S.pulse.k : S.pulse.k;
            const width = focus.tight ? 0.028 : 0.04;
            const boost = (focus.tight ? 1.2 : 1) * (0.7 + 0.5 * kick);
            r.pool(focus.x, focus.y, 150, (0.2 + 0.3 * kick) * (focus.tight ? 1.2 : 1) * Math.max(dim, 0.5) * Math.min(1, focus.strength * 1.4), mixRgb(tone, other, 0.5));
            r.followSpot(0.05, 0, focus.x - 6, focus.y, width, spotA * boost, mixRgb(tone, P.w, 0.2), { id: 'L', dt, kick });
            r.followSpot(0.95, 0, focus.x + 6, focus.y, width, spotA * boost, mixRgb(other, P.w, 0.2), { id: 'R', dt, kick });
        }
        const bar = this._stageOn && stage.bar;
        if (bar) {
            r.lyricBar(bar.x0, bar.x1, bar.y, bar.p, bar.fade * Math.max(dim, 0.5), mixRgb(P.w, P.a, 0.4),
                (bar.hit ? 0.6 : 0) + 0.4 * S.pulse.k);
        }

        const px = b ? blendPixels(a.pixels, b.pixels, mix) : a.pixels;
        r.pixels(px, dim);
        r.effects(dt, Math.max(dim, 0.3));
        r.blinders(S.blinderAmt * dim, P.w);
        r.flash(S.flashAmt, S.flashColor);
        r.vignette();
    }
}

// ---------------------------------------------------------------- blending

function blendNum(a, b, t) {
    if (!b) return a;
    const out = {};
    for (const k of Object.keys(a)) out[k] = lerp(b[k] || 0, a[k] || 0, t);
    return out;
}

function blendWash(a, b, t) {
    if (!b) return a;
    return {
        l: lerp(b.l, a.l, t), r: lerp(b.r, a.r, t), top: lerp(b.top, a.top, t), floor: lerp(b.floor, a.floor, t),
        colL: a.colL, colR: a.colR, colTop: a.colTop, colFloor: a.colFloor,
    };
}

function blendPixels(a, b, t) {
    const cells = new Float32Array(a.cells.length);
    for (let i = 0; i < cells.length; i++) cells[i] = lerp(b.cells[i], a.cells[i], t);
    return { cells, colA: a.colA, colB: a.colB, alpha: lerp(b.alpha, a.alpha, t) };
}
