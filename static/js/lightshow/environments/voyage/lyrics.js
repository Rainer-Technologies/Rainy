/**
 * Voyage lyrics — the words, flying with you.
 *
 * This is the Voyage staging of the shared LyricsTimeline (what is sung
 * when). The line being sung hangs in the air ahead of the camera, over the
 * road, as real geometry in the world: it is drawn in HDR, so the bloom
 * turns it into neon. The next line waits further down the road as a ghost
 * and flies up when its time comes.
 *
 *  - A line is one texture (its words set in the app's own font, outline in
 *    one channel, fill in the other) and one quad per word.
 *  - The fill is computed in the shader from media time: a white-hot front
 *    runs across the word as it is sung and cools into the palette behind it.
 *  - Lines hand over with the same transitions the timeline picks for every
 *    environment, staged for this one: `slam` bursts toward the camera, `fall`
 *    is left behind on the road, `sweep` is carried off sideways, `collapse` is
 *    pulled into the sun, `flicker` dies like a neon tube, `lift` rises away.
 *  - Nothing shares a place on screen: the line being sung, the one waiting
 *    under it and the backing vocals over it are laid out as they look from
 *    the camera, and a line that leaves clears its spot before the next one
 *    lands on it.
 *  - Backing vocals float beside the line; an instrumental break clears the
 *    stage (the sun fills up instead) and three dots count the voice back in.
 *
 * The environment reads `focus` (the word being sung, for the follow beams
 * and the pool of light on the road), `onset` and `cue` to make the rig
 * answer the words, like the classic stage does.
 */
import { clamp, lerp, smooth } from '../../palette.js';
import { HELD, pickTransition } from '../../lyricsTimeline.js';
import { THREE, GLSL_COMMON } from './glsl.js';

const DIST = 26;             // how far ahead of the camera the line hangs (units)
const GHOST_BACK = 30;       // and how much further the waiting line is
const OUT = 0.3;             // seconds an outgoing line takes to leave
const ENTER_AFTER = 0.14;    // the next line waits this long for it to clear the spot
const ENTER = 0.28;          // then takes this long to fly up
const AD_TAIL = 0.9;         // ad-libs linger this long after their last word
const FONT_PX = 96;
const MODES = { lift: 0, slam: 1, fall: 2, sweep: 3, collapse: 4, flicker: 5 };

const VERT = /* glsl */`
${GLSL_COMMON}
attribute vec4 aRect;     // centre x, centre y, width, height (texture px, y up)
attribute vec4 aUv;       // u0, v0, u1, v1
attribute vec4 aWord;     // start, end, index, 1 if held
uniform float uOut, uMode, uDir, uCount, uPx, uH;
varying vec2 vUv, vLocal;
varying vec4 vWord;
varying float vFade;
void main() {
    vec2 q = position.xy;
    vec3 p = vec3(aRect.xy + q * aRect.zw, 0.0);
    // A held note swells while it is sung.
    float held = aWord.w * smoothstep(aWord.x, aWord.x + 0.25, uT) * (1.0 - smoothstep(aWord.y, aWord.y + 0.3, uT));
    p.xy = aRect.xy + (p.xy - aRect.xy) * (1.0 + 0.04 * held);

    // Leaving: word by word, a little apart, and out of the way at once (the
    // next line lands on this spot a moment later). The next line waits right
    // below, so a line never leaves downwards: up, sideways, or away.
    float k = aWord.z / max(1.0, uCount - 1.0);
    // Swept sideways, the words at the leading end go first, so none runs into the next.
    float order = (uMode > 2.5 && uMode < 3.5 && uDir > 0.0) ? 1.0 - k : k;
    float o = clamp(uOut * 1.3 - order * 0.3, 0.0, 1.0);
    float e = 1.0 - (1.0 - o) * (1.0 - o);
    vFade = (1.0 - o) * (1.0 - o);
    if (uMode < 0.5) {                 // lift: up and away
        p.y += e * 7.0 * uPx;
    } else if (uMode < 1.5) {          // slam: bursts toward you, growing up from its own baseline
        float base = -0.5 * uH;
        p.x *= 1.0 + e * 0.18;
        p.y = base + (p.y - base) * (1.0 + e * 0.9);
    } else if (uMode < 2.5) {          // fall: dropped behind, left on the road as the camera flies on
        p.z -= e * 55.0 * uPx;
        p.y += e * 1.5 * uPx;
        p.x += (k - 0.5) * e * 3.0 * uPx;
    } else if (uMode < 3.5) {          // sweep: carried off sideways
        p.x += uDir * e * 24.0 * uPx;
    } else if (uMode < 4.5) {          // collapse: pulled into the sun
        p.xy = mix(p.xy, vec2(0.0, 7.0 * uPx), e);
        p.z -= e * 70.0 * uPx;
    } else {                           // flicker: a dying neon tube
        float on = step(0.4, fract(sin(aWord.z * 91.7 + floor(uNow * 22.0) * 7.3) * 43758.5453));
        vFade = o <= 0.0 ? 1.0 : (1.0 - smoothstep(0.0, 0.55, o)) * on;
    }
    vUv = mix(aUv.xy, aUv.zw, q + 0.5);
    vLocal = q + 0.5;
    vWord = aWord;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */`
${GLSL_COMMON}
uniform sampler2D uAtlas;
uniform float uAlpha, uGhost, uPlain;
uniform vec3 uTint;
varying vec2 vUv, vLocal;
varying vec4 vWord;
varying float vFade;
void main() {
    vec4 tx = texture2D(uAtlas, vUv);
    float outline = tx.r, fill = tx.g;
    float s = vWord.x, dur = max(0.05, vWord.y - vWord.x);
    float x = vLocal.x;
    // The lit front crosses the word a little faster than it is sung, so the
    // whole word is alight just before it ends.
    float front = (uT - s) / dur * 1.12;
    float lit = mix(smoothstep(front + 0.03, front - 0.03, x), 1.0, uPlain);
    float age = max(uT - (s + x * dur / 1.12), 0.0);
    float hot = lit * exp(-age / 0.32) * (1.0 - uPlain);
    float edge = exp(-pow((x - front) / 0.05, 2.0)) * step(s, uT) * step(uT, vWord.y + 0.06) * (1.0 - uPlain);
    float cue = smoothstep(0.7, 0.0, s - uT) * step(uT, s);       // about to be sung
    float kick = 1.0 + 0.3 * uKick;

    vec3 rest = mix(vec3(1.0), uTint, 0.25);
    vec3 col = rest * fill * lit * (0.9 + 2.8 * hot) * kick      // struck white-hot, cooling into the palette
             + uPalW * fill * edge * 2.4
             + vec3(1.0) * outline * (1.0 - lit) * (0.55 + 0.6 * cue);    // not sung yet: a hollow outline
    float a = max(fill * lit, outline * (1.0 - lit) * (0.7 + 0.3 * cue));
    float k = uAlpha * vFade * mix(1.0, uDim, 0.85) * mix(1.0, 0.42, uGhost);
    gl_FragColor = vec4(col * k, a * k);
}`;

// A soft shadow behind the line, so the words read over a bright land.
const SCRIM_FRAG = /* glsl */`
uniform float uAlpha;
varying vec2 vP;
void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, uAlpha * exp(-dot(vP, vP) * 2.6));
}`;

const DOT_VERT = /* glsl */`
varying vec2 vP;
void main() {
    vP = position.xy * 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DOT_FRAG = /* glsl */`
${GLSL_COMMON}
uniform float uLit, uAlpha;
varying vec2 vP;
void main() {
    float d = length(vP);
    float disc = smoothstep(1.0, 0.8, d);
    float ring = smoothstep(0.2, 0.0, abs(d - 0.85));
    vec3 col = mix(vec3(1.0) * ring * 0.4, mix(uPalA, vec3(1.0), 0.6) * disc * 2.2, uLit);
    float a = mix(ring * 0.5, disc, uLit) * uAlpha;
    gl_FragColor = vec4(col * uAlpha, a);
}`;

/**
 * Set words in type on a canvas: outline in red, fill in green, wrapped into
 * balanced rows.
 * @returns {{ canvas, w, h, items: Array<{x,y,w,h,u0,v0,u1,v1}> }} word boxes in px, origin at the block's centre, y up
 */
function typeset(texts, { family, italic, maxEm, weight = 800 }) {
    let px = FONT_PX;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = () => `${italic ? 'italic ' : ''}${weight} ${px}px ${family}`;
    ctx.font = font();
    let widths = texts.map((t) => ctx.measureText(t).width);
    const space = () => px * 0.3;
    const total = widths.reduce((a, b) => a + b, 0) + space() * (texts.length - 1);
    const rows = Math.max(1, Math.min(3, Math.ceil(total / (maxEm * px))));
    // Greedy fill toward an even split, so rows are balanced instead of one long and one stub.
    const target = total / rows;
    const lines = [[]];
    let acc = 0;
    texts.forEach((t, i) => {
        const w = widths[i];
        const row = lines[lines.length - 1];
        if (row.length && lines.length < rows && acc + w / 2 > target) {
            lines.push([i]);
            acc = w + space();
        } else {
            row.push(i);
            acc += w + space();
        }
    });
    const rowWidth = (row) => row.reduce((a, i) => a + widths[i], 0) + space() * (row.length - 1);
    let blockW = Math.max(...lines.map(rowWidth));
    // Keep the texture a sane size: shrink the type for a very long line.
    const fit = Math.min(1, 1900 / (blockW + px));
    if (fit < 1) {
        px = Math.floor(px * fit);
        ctx.font = font();
        widths = texts.map((t) => ctx.measureText(t).width);
        blockW = Math.max(...lines.map(rowWidth));
    }
    const pad = Math.round(px * 0.3), lh = Math.round(px * 1.16);
    canvas.width = Math.ceil(blockW + pad * 2);
    canvas.height = lines.length * lh + pad * 2;
    ctx.font = font();
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, px * 0.045);
    ctx.globalCompositeOperation = 'lighter';
    const items = [];
    const edge = px * 0.12;     // a word's box reaches this far into the gaps around it
    lines.forEach((row, r) => {
        let x = pad + (blockW - rowWidth(row)) / 2;
        const top = pad + r * lh;
        const base = top + px * 0.86;
        for (const i of row) {
            ctx.strokeStyle = '#f00';
            ctx.strokeText(texts[i], x, base);
            ctx.fillStyle = '#0f0';
            ctx.fillText(texts[i], x, base);
            const x0 = x - edge, x1 = x + widths[i] + edge;
            items[i] = {
                x: (x0 + x1) / 2 - canvas.width / 2,
                y: canvas.height / 2 - (top + lh / 2),
                w: x1 - x0,
                h: lh,
                u0: x0 / canvas.width, u1: x1 / canvas.width,
                v0: 1 - (top + lh) / canvas.height, v1: 1 - top / canvas.height,
            };
            x += widths[i] + space();
        }
    });
    return { canvas, w: canvas.width, h: canvas.height, items };
}

/** A line of timed words as one mesh. */
export class TextLine {
    constructor(globals, words, style) {
        const set = typeset(words.map((w) => w.text), style);
        this.w = set.w;
        this.h = set.h;
        this.words = words.map((w, i) => ({ s: w.s, e: w.e, held: w.e - w.s >= HELD, x: set.items[i].x, y: set.items[i].y }));
        const tex = this.texture = new THREE.CanvasTexture(set.canvas);
        tex.colorSpace = THREE.NoColorSpace;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = 4;

        const n = words.length;
        const quad = new THREE.PlaneGeometry(1, 1);
        const geo = this.geometry = new THREE.InstancedBufferGeometry();
        geo.index = quad.index;
        geo.setAttribute('position', quad.getAttribute('position'));
        const rect = new Float32Array(n * 4), uv = new Float32Array(n * 4), word = new Float32Array(n * 4);
        set.items.forEach((it, i) => {
            rect.set([it.x, it.y, it.w, it.h], i * 4);
            uv.set([it.u0, it.v0, it.u1, it.v1], i * 4);
            word.set([words[i].s, words[i].e, i, this.words[i].held ? 1 : 0], i * 4);
        });
        geo.setAttribute('aRect', new THREE.InstancedBufferAttribute(rect, 4));
        geo.setAttribute('aUv', new THREE.InstancedBufferAttribute(uv, 4));
        geo.setAttribute('aWord', new THREE.InstancedBufferAttribute(word, 4));
        geo.instanceCount = n;

        this.uniforms = {
            ...globals,
            uAtlas: { value: tex },
            uAlpha: { value: 1 },
            uGhost: { value: 0 },
            uPlain: { value: style.plain ? 1 : 0 },
            uTint: { value: new THREE.Vector3(1, 1, 1) },
            uOut: { value: 0 },
            uMode: { value: 0 },
            uDir: { value: 1 },
            uCount: { value: n },
            uPx: { value: 1 },
            uH: { value: set.h },
        };
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
            transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
            blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        });
        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 80;
    }

    /** Size the line: `unit` world units per texture px. */
    place(x, y, z, unit) {
        this.mesh.position.set(x, y, z);
        this.mesh.scale.setScalar(unit);
        this.uniforms.uPx.value = 1 / unit;
    }

    dispose() {
        this.mesh.removeFromParent();
        this.geometry.dispose();
        this.material.dispose();
        this.texture.dispose();
    }
}

export class VoyageLyrics {
    /**
     * @param {object} globals  shared uniforms
     * @param {import('../../lyricsTimeline.js').LyricsTimeline} timeline
     * @param {string} family   CSS font-family to set the words in
     */
    constructor(globals, timeline, family) {
        this.globals = globals;
        this.timeline = timeline;
        this.family = family || 'system-ui, sans-serif';
        this._version = timeline.version;
        // The reading frame: a plane ahead of the camera that everything here hangs on.
        this.frame = new THREE.Group();
        this.frame.visible = false;
        this.visible = false;
        this.alpha = 0;              // smoothed presence (fades in and out instead of cutting)
        this.interlude = 0;          // 0..1, how far the stage has gone over to an instrumental break
        this.progress = 0;           // 0..1, how much of the break has run
        this.focus = null;           // { x, y, z, strength, flip, held } world position of the word being sung
        this.onset = null;           // a word started this frame { x, y, z, hit, held }
        this.cue = null;             // { type } a line handed over, or a break started
        this._it = 0;
        this._interOn = false;
        this._words = 0;
        this._lastTr = '';
        this._top = 0;
        this._v = new THREE.Vector3();
        this._q = new THREE.Quaternion();
        this._roll = new THREE.Quaternion();
        this._axis = new THREE.Vector3(0, 0, 1);

        // Three dots that count the voice back in.
        this.dotGeo = new THREE.PlaneGeometry(1, 1);
        this.dots = [0, 1, 2].map(() => {
            const uniforms = { ...globals, uLit: { value: 0 }, uAlpha: { value: 0 } };
            const mesh = new THREE.Mesh(this.dotGeo, new THREE.ShaderMaterial({
                vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, uniforms, transparent: true, depthWrite: false, depthTest: false,
                blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
            }));
            mesh.renderOrder = 81;
            mesh.frustumCulled = false;
            this.frame.add(mesh);
            return { mesh, uniforms };
        });
        this.scrimU = { uAlpha: { value: 0 } };
        this.scrim = new THREE.Mesh(this.dotGeo, new THREE.ShaderMaterial({
            vertexShader: DOT_VERT, fragmentShader: SCRIM_FRAG, uniforms: this.scrimU, transparent: true, depthWrite: false, depthTest: false,
        }));
        this.scrim.renderOrder = 78;
        this.scrim.frustumCulled = false;
        this.frame.add(this.scrim);
        this._reset();
    }

    get ready() {
        return this.timeline.ready;
    }

    _reset() {
        for (const key of ['_cur', '_next', '_old']) {
            if (this[key]) this[key].line.dispose();
            this[key] = null;
        }
        if (this._adlibs) for (const a of this._adlibs.values()) a.dispose();
        this._adlibs = new Map();     // ad-lib index -> TextLine
        this.idx = -2;
        this._lastWord = -1;
        this._lastTr = '';
        this.focus = null;
        this._it = 0;
        this._interOn = false;
    }

    /** The timeline swapped its lines (new song, word timings arrived): start over. */
    sync() {
        if (this._version === this.timeline.version) return;
        this._version = this.timeline.version;
        this._reset();
    }

    show(on) {
        this.visible = !!on;
    }

    _make(i, maxEm) {
        const line = new TextLine(this.globals, this.timeline.lines[i].words, { family: this.family, maxEm });
        this.frame.add(line.mesh);
        return { i, line };
    }

    /**
     * Per-frame update.
     * @param {object} S                 show state
     * @param {THREE.PerspectiveCamera} camera
     * @param {{ bottom: number }} view  fraction of the screen's height covered at the bottom (player bar)
     */
    update(S, camera, view) {
        const { F, t, dt } = S;
        const P = S.palette;
        this.onset = null;
        this.cue = null;
        this.sync();
        this.alpha = lerp(this.alpha, this.visible && this.ready ? 1 : 0, 1 - Math.exp(-dt / 0.25));
        if (this.alpha < 0.01 || !this.ready) {
            this.frame.visible = false;
            this.focus = null;
            if (!this.visible && (this._cur || this._next || this._old)) this._reset();
            return;
        }
        this.frame.visible = true;
        const tl = this.timeline;

        // ---- The reading frame: ahead of the camera, level with the horizon ----
        const cam = camera;
        cam.updateMatrixWorld();
        const fwd = this._v.set(0, 0, -1).applyQuaternion(cam.quaternion);
        this.frame.position.copy(cam.position).addScaledVector(fwd, DIST);
        // The words lean a little into a turn with the horizon, but mostly stay square to the screen.
        const roll = Math.atan2(cam.matrixWorld.elements[1], cam.matrixWorld.elements[5]);
        this.frame.quaternion.copy(cam.quaternion).multiply(this._roll.setFromAxisAngle(this._axis, -roll * 0.3));
        this.frame.updateMatrixWorld(true);
        const hh = DIST * Math.tan((cam.fov * Math.PI) / 360);      // half the frame's height at this distance
        const hw = hh * cam.aspect;
        const maxEm = clamp(cam.aspect * 10.5, 6.5, 17);

        // ---- Line changes ----
        const idx = tl.lineIndex(t);
        if (idx !== this.idx) {
            const forward = idx === this.idx + 1;
            if (this._old) this._old.line.dispose();
            this._old = null;
            // (A ♪ line was never on screen, so it has nothing to take off it.)
            if (this._cur && forward && !tl.lines[this._cur.i].blank) {
                const tr = idx >= 0 ? (this._lastTr = pickTransition(F, idx, this._lastTr)) : 'lift';
                this._old = { ...this._cur, tr, at: tl.lines[idx].on, dir: idx & 1 ? -1 : 1, top: this._top };
                this.cue = { type: tr };
            } else if (this._cur) this._cur.line.dispose();
            const promoted = forward && this._next && this._next.i === idx;
            if (this._next && !promoted) this._next.line.dispose();
            this._cur = idx >= 0 ? (promoted ? this._next : this._make(idx, maxEm)) : null;
            // It lets the line that is leaving clear the spot first.
            if (this._cur) this._cur.wait = this._old ? ENTER_AFTER : 0;
            this._next = idx + 1 < tl.lines.length ? this._make(idx + 1, maxEm) : null;
            this.idx = idx;
            this._lastWord = -1;
        }

        // ---- Instrumental break ----
        const beat = F.period || 0.5;
        const line = idx >= 0 ? tl.lines[idx] : null;
        const next = tl.lines[idx + 1] || null;
        const resting = tl.resting(t, idx);
        const gap = next ? next.t0 - t : Infinity;
        const br = tl.breakAt(t, idx);
        const want = br && br.b - t > beat * 4 ? 1 : 0;
        this._it = F.jumped ? want : this._it + (want - this._it) * (1 - Math.exp(-dt * 4));
        this.interlude = this._it;
        if (want === 1 && !this._interOn) this.cue = { type: 'break' };
        this._interOn = want === 1;
        this.progress = br && Number.isFinite(br.b) ? clamp((t - br.a) / Math.max(0.1, br.b - br.a - beat * 5), 0, 1) : 0;

        // ---- Place the lines ----
        // Laid out as they look from the camera: the waiting line is further
        // away, so it looks smaller and nearer the centre than where it hangs.
        const present = this.alpha * (1 - 0.92 * this._it);
        const far = DIST / (DIST + GHOST_BACK);                // how much smaller the waiting line looks
        const floor = (-1 + 2 * view.bottom) * hh + 0.03 * hh; // the lowest the words may reach: just above the chrome
        const pad = 0.045 * hh;                              // air between lines
        const fit = (rec) => Math.min(0.026 * (hh / 14), (hw * 2 * 0.84) / rec.line.w, (hh * 2 * 0.34) / rec.line.h);
        const cur = this._cur, waiting = this._next;
        const shown = !!cur && !line.blank;
        const curUnit = cur ? fit(cur) : 0;
        const curH = shown ? cur.line.h * curUnit : 0;
        const waitUnit = waiting ? fit(waiting) : 0;
        const waitH = waiting && !tl.lines[waiting.i].blank ? waiting.line.h * waitUnit * far : 0;   // as it looks from here
        // The line sits low, over the road, but always leaves room under it for the one waiting.
        let cy = lerp(-1 + 2 * view.bottom, 0, 0.3) * hh;
        cy = Math.min(Math.max(cy, floor + waitH + pad + curH / 2), 0.6 * hh - curH / 2);
        const waitY = cy - curH / 2 - pad - waitH / 2;         // where the waiting line looks to be
        const room = waitY - waitH / 2 >= floor - 0.01 * hh;
        this._top = cy + curH / 2;
        // Backing vocals sit over whatever is tallest on stage, the line still leaving included.
        const adTop = Math.max(this._top, this._old ? this._old.top : -1e3);
        this._adTop = F.jumped || this._adTop === undefined ? adTop : lerp(this._adTop, adTop, 1 - Math.exp(-dt * (adTop > this._adTop ? 30 : 6)));

        let enter = 1;
        if (cur) {
            // It flies up from where it was waiting.
            enter = smooth(clamp((t - tl.lines[cur.i].on - cur.wait) / ENTER, 0, 1));
            if (cur.fromY === undefined) {
                cur.fromY = (cy - curH / 2 - pad - (cur.line.h * curUnit * far) / 2) / far;
                cur.fromUnit = curUnit;
            }
            cur.line.place(0, lerp(cur.fromY, cy, enter), lerp(-GHOST_BACK, 0, enter), lerp(cur.fromUnit, curUnit, enter));
            const u = cur.line.uniforms;
            u.uGhost.value = 1 - enter;
            u.uAlpha.value = present * (resting ? 0.55 : 1) * (shown ? 1 : 0);
            u.uOut.value = 0;
            u.uTint.value.copy(this.globals.uPalA.value);
            this.scrim.position.set(0, cy, -0.5);
            this.scrim.scale.set(cur.line.w * curUnit * 1.5, Math.max(curH, 0.01) * 2.2, 1);
            this.scrimU.uAlpha.value = 0.55 * u.uAlpha.value * enter;
        } else this.scrimU.uAlpha.value = 0;
        if (waiting) {
            // Hung further down the road so that, from here, it sits right under the line.
            waiting.fromY = waitY / far;
            waiting.fromUnit = waitUnit;
            waiting.line.place(0, waiting.fromY, -GHOST_BACK, waitUnit);
            const u = waiting.line.uniforms;
            u.uGhost.value = 1;
            // It only shows once the line above it has landed (that line took off
            // from this very spot), and never squeezed in.
            u.uAlpha.value = waitH > 0 && room ? present * clamp((enter - 0.8) / 0.2, 0, 1) : 0;
            u.uOut.value = 0;
            u.uTint.value.copy(this.globals.uPalA.value);
        }
        if (this._old) {
            // The line that just ended leaves from where it was.
            const rec = this._old;
            const o = (t - rec.at) / OUT;
            if (o >= 1 || o < 0) {
                rec.line.dispose();
                this._old = null;
            } else {
                const u = rec.line.uniforms;
                u.uOut.value = o;
                u.uMode.value = MODES[rec.tr] ?? 0;
                u.uDir.value = rec.dir;
                u.uGhost.value = 0;
                u.uAlpha.value = present;
            }
        }

        // ---- The word being sung ----
        let active = -1, started = -1;
        if (shown) {
            const ws = cur.line.words;
            for (let k = 0; k < ws.length; k++) if (t >= ws[k].s) active = k;
            if (active > this._lastWord && active >= 0) {
                if (!F.jumped && active === this._lastWord + 1) started = active;
                this._words++;
                this._lastWord = active;
            }
            // The beams never lose the text: on the word being sung, else leading to the next one.
            let k = active, strength = 0.45;
            if (active >= 0 && t < ws[active].e) strength = 1;
            else if (active + 1 < ws.length) { k = active + 1; strength = 0.7; }
            if (k < 0) k = 0;
            const w = ws[k];
            const unit = cur.line.mesh.scale.x;
            const pos = this._v.set(w.x * unit, cur.line.mesh.position.y + w.y * unit, cur.line.mesh.position.z).applyMatrix4(this.frame.matrixWorld);
            const s = strength * present * enter * (resting ? 0.4 : 1);
            if (!this._focus) this._focus = { x: pos.x, y: pos.y, z: pos.z };
            const f = this._focus, glide = F.jumped ? 1 : 1 - Math.exp(-dt * 13);
            f.x = lerp(f.x, pos.x, glide);
            f.y = lerp(f.y, pos.y, glide);
            f.z = lerp(f.z, pos.z, glide);
            this.focus = s > 0.03 ? { x: f.x, y: f.y, z: f.z, strength: s, flip: (this._words & 1) === 1, held: w.held && strength === 1 } : null;
            if (started >= 0) {
                this.onset = { x: pos.x, y: pos.y, z: pos.z, held: w.held, hit: F.pulse.k > 0.4 || F.pulse.s > 0.4, strong: F.bands.rms > 0.6 };
            }
        } else this.focus = null;

        // ---- Countdown dots ----
        const dotsOn = !!(resting && next && gap < beat * 4 + 0.05 && (!line || next.t0 - line.end > 3));
        const lit = dotsOn ? clamp(Math.floor((beat * 4 - gap) / beat), 0, 3) : 0;
        this.dots.forEach((d, k) => {
            d.mesh.visible = dotsOn && this.alpha > 0.05;
            const r = 0.035 * hh;
            d.mesh.position.set((k - 1) * r * 4, cy, 0);   // where the line is about to land
            d.mesh.scale.setScalar(r * 2);
            d.uniforms.uLit.value = k < lit ? 1 : 0;
            d.uniforms.uAlpha.value = this.alpha;
        });

        this._updateAdlibs(t, hw, hh, present);
    }

    /** Backing vocals: over the line while they are sung (left and right, a row each), then drifting away. */
    _updateAdlibs(t, hw, hh, present) {
        const list = this.timeline.adlibs;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            const live = t >= a.s - 0.2 && t <= a.e + AD_TAIL;
            let rec = this._adlibs.get(i);
            if (live && !rec) {
                rec = new TextLine(this.globals, a.words, { family: this.family, maxEm: 9, italic: true, weight: 700 });
                rec.uniforms.uTint.value = this.globals.uPalB.value;
                this.frame.add(rec.mesh);
                this._adlibs.set(i, rec);
            } else if (!live && rec) {
                rec.dispose();
                this._adlibs.delete(i);
                continue;
            }
            if (!rec) continue;
            // Each stays on its own half of the screen and its own row above the line.
            const unit = Math.min(0.013 * (hh / 14), (hw * 0.72) / rec.w);
            const h = rec.h * unit;
            const side = a.k % 2 ? -1 : 1;
            const row = (a.k >> 1) % 2;
            const gone = clamp((t - a.e) / AD_TAIL, 0, 1);
            const y = Math.min(this._adTop + 0.06 * hh + h / 2 + row * h * 1.1, 0.8 * hh) + gone * 0.05 * hh;
            rec.place(side * hw * 0.5, y, -2 * gone, unit);
            rec.uniforms.uAlpha.value = present * clamp((t - a.s + 0.2) / 0.2, 0, 1) * (1 - gone);
            rec.uniforms.uGhost.value = 0.15;
        }
    }

    dispose() {
        this._reset();
        this.frame.removeFromParent();
        this.dotGeo.dispose();
        this.scrim.material.dispose();
        for (const d of this.dots) d.mesh.material.dispose();
    }
}
