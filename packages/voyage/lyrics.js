/**
 * Voyage lyrics — the words, built in the air ahead of you.
 *
 * This is the Voyage staging of the shared LyricsTimeline (what is sung
 * when). A line is set like a poster: capitals, broken into rows that are
 * each scaled to the same width, so a short row is a big one. The block
 * hangs ahead of the camera as solid letters with depth, turning slowly as
 * the line goes by, and it is drawn in HDR, so the bloom makes neon of
 * whatever is lit.
 *
 *  - A word that has not been sung is an unlit sign: a dark body with a bright
 *    rim. Sung, it is struck: it punches out, a ring leaves it, a white-hot
 *    front runs across it and cools into the palette, and its depth lights up
 *    behind it.
 *  - Every line arrives word by word, and no two the same way running: standing
 *    up off the road, out of the distance, from the side, down from the sky or
 *    turning on its own axis.
 *  - Lines hand over with the transitions the timeline picks for every
 *    environment, staged for this one: `lift` is thrown up, `slam` flies through
 *    the camera, `fall` tumbles to the road, `sweep` is carried off sideways,
 *    `collapse` is pulled into the sun and `flicker` dies like a neon tube. The
 *    next line comes in from the other side, after the spot is clear.
 *  - Nothing shares a place on screen: one line at a time, the backing vocals
 *    in their own rows over it, and a line never leaves through them.
 *  - An instrumental break clears the stage (the sun fills up instead) and
 *    three dots count the voice back in.
 *
 * The environment reads `focus` (the word being sung, for the follow beams
 * and the pool of light on the road), `onset` and `cue` to make the rig
 * answer the words, like the classic stage does.
 */
import { clamp, lerp, smooth, HELD, pickTransition } from '@rainy/lightshow';
import { THREE, GLSL_COMMON } from './glsl.js';

const DIST = 26;             // how far ahead of the camera the line hangs (units)
const OUT = 0.26;            // seconds an outgoing line takes to leave
const ENTER_AFTER = 0.16;    // the next line waits this long for it to clear the spot
const ENTER = 0.36;          // then takes this long to arrive, first word first
const AD_TAIL = 0.9;         // ad-libs linger this long after their last word
const FONT_PX = 112;         // one em in the atlas, and the unit the shader animates in
const LAYERS = 8;            // slices of depth behind each letter
const OUT_MODES = { lift: 0, slam: 1, fall: 2, sweep: 3, collapse: 4, flicker: 5 };
const IN = { rise: 0, depth: 1, sides: 2, drop: 3, flip: 4, right: 5 };
// Each exit is answered from the other side, so the two never cross.
const FOLLOW = { lift: IN.rise, slam: IN.depth, fall: IN.drop, sweep: IN.right, collapse: IN.flip, flicker: IN.sides };
const OPENERS = [IN.rise, IN.sides, IN.depth, IN.flip, IN.drop];
// These leave through the rows the backing vocals use.
const THROUGH_ADLIBS = { lift: true, slam: true, collapse: true };

const VERT = /* glsl */`
${GLSL_COMMON}
attribute vec4 aRect;     // centre x, centre y, width, height (block px, y up)
attribute vec4 aUv;       // u0, v0, u1, v1
attribute vec4 aWord;     // start, end, place in the line 0..1, 1 if held
attribute vec3 aSlab;     // layer (0 the face, 1.. the depth behind it, -1 the ring), row direction, seed
uniform float uIn, uInMode, uOut, uOutMode, uDir, uEm, uW, uH, uPlain;
varying vec2 vUv, vLocal;
varying vec4 vWord;
varying float vFade, vLayer;

vec3 turn(vec3 p, float ax, float ay, float az) {
    float c = cos(ax), s = sin(ax);
    p.yz = vec2(c * p.y - s * p.z, s * p.y + c * p.z);
    c = cos(ay); s = sin(ay);
    p.xz = vec2(c * p.x + s * p.z, -s * p.x + c * p.z);
    c = cos(az); s = sin(az);
    p.xy = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    return p;
}

void main() {
    vec2 q = position.xy;
    float layer = aSlab.x, k = aWord.z;
    vec3 c = vec3(aRect.xy, 0.0);        // where the word stands
    float span = max(aRect.z, aRect.w);
    float scale = 1.0, fade = 1.0, ax = 0.0, ay = 0.0, az = 0.0;

    // Sung: it punches out and settles; a held note keeps swelling. What a
    // word grows by is a set fraction of an em, less than the gap to its neighbours.
    float age = uT - aWord.x;
    float live = step(0.0, age) * (1.0 - uPlain);
    float punch = live * exp(-age / 0.12);
    float held = aWord.w * live * (1.0 - smoothstep(aWord.y, aWord.y + 0.3, uT));
    float grow = 0.09 * punch + 0.03 * held * (0.6 + 0.4 * sin(uNow * 9.0));
    if (layer < -0.5) {
        // The ring it throws off as it is struck.
        float r = clamp(age / 0.4, 0.0, 1.0);
        grow += 0.15 * (1.0 - (1.0 - r) * (1.0 - r));
        fade *= live * (1.0 - r) * (1.0 - r);
    }
    scale += 2.0 * grow * uEm / span;

    // Arriving, word by word.
    float order = k;
    float side = uInMode > 4.5 ? 1.0 : aSlab.y;
    if (uInMode > 1.5 && uInMode < 2.5 && side < 0.0) order = 1.0 - k;   // the leading end first
    float x = uInMode > 0.5 && uInMode < 1.5 ? uIn : clamp((uIn - order * 0.5) / 0.5, 0.0, 1.0);
    float r = pow(1.0 - x, 3.0);
    fade *= smoothstep(0.0, 0.45, x);
    if (uInMode < 0.5) {                 // rise: stands up off the road
        c.y -= r * 1.3 * uEm;
        ax = r * 1.2;
    } else if (uInMode < 1.5) {          // depth: out of the distance
        c.z -= r * 16.0 * uEm;
    } else if (uInMode < 2.5 || uInMode > 4.5) {   // sides / right: swung in from the side
        c.x += side * r * 3.5 * uEm;
        ay = -side * r * 1.1;
    } else if (uInMode < 3.5) {          // drop: down from the sky, as one block (a row never falls through the one above)
        c.y += pow(1.0 - uIn, 3.0) * 1.5 * uEm;
        ax = -r * 1.1;
    } else {                             // flip: turning on its own axis
        ay = r * 1.5708;
    }

    // Leaving: word by word, and out of the way at once (the next line lands
    // on this spot a moment later).
    float first = (uOutMode > 2.5 && uOutMode < 3.5 && uDir > 0.0) ? 1.0 - k : k;
    float o = clamp(uOut * 1.35 - first * 0.35, 0.0, 1.0);
    float e = 1.0 - (1.0 - o) * (1.0 - o);
    float gone = (1.0 - o) * (1.0 - o);
    float clearY = uH + uEm, wob = aSlab.z - 0.5;
    if (uOutMode < 0.5) {                // lift: thrown up and back
        c.y += e * clearY;
        c.z -= e * 5.0 * uEm;
        ax = e * 0.9;
    } else if (uOutMode < 1.5) {         // slam: through the camera
        c.xy *= 1.0 + e * 1.1;
        scale *= 1.0 + e * 1.1;
        gone *= 1.0 - o;
    } else if (uOutMode < 2.5) {         // fall: tumbling to the road
        c.y -= e * clearY;
        ax = -e * 1.2;
        az = e * wob * 0.9;
    } else if (uOutMode < 3.5) {         // sweep: carried off sideways
        c.x += uDir * e * (uW * 0.6 + 5.0 * uEm);
        ay = uDir * e * 1.0;
    } else if (uOutMode < 4.5) {         // collapse: pulled into the sun
        c.xy = mix(c.xy, vec2(0.0, 0.5 * uH + 2.0 * uEm), e);
        c.z -= e * 22.0 * uEm;
        scale *= 1.0 - 0.8 * e;
        gone *= 1.0 - o;
    } else {                             // flicker: a dying neon tube
        float on = step(0.4, fract(sin(aSlab.z * 91.7 + floor(uNow * 22.0) * 7.3) * 43758.5453));
        gone = o <= 0.0 ? 1.0 : (1.0 - smoothstep(0.0, 0.55, o)) * on;
    }

    // The depth is drawn back, down and a little to one side, so it shows even head-on.
    float back = max(layer, 0.0);
    vec3 p = vec3(q * aRect.zw * scale, layer < -0.5 ? 0.02 * uEm : 0.0);
    p += vec3(-0.012, -0.02, -0.04) * uEm * back * scale;
    p = turn(p, ax, ay, az) + c;

    vFade = fade * gone;
    vLayer = layer;
    vUv = mix(aUv.xy, aUv.zw, q + 0.5);
    vLocal = q + 0.5;
    vWord = aWord;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */`
${GLSL_COMMON}
uniform sampler2D uAtlas;
uniform float uAlpha, uPlain, uLayers;
uniform vec3 uTint, uTintB;
varying vec2 vUv, vLocal;
varying vec4 vWord;
varying float vFade, vLayer;
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
    float hot = lit * exp(-age / 0.3) * (1.0 - uPlain);
    float edge = exp(-pow((x - front) / 0.05, 2.0)) * step(s, uT) * step(uT, vWord.y + 0.06) * (1.0 - uPlain);
    float cue = smoothstep(0.6, 0.0, s - uT) * step(uT, s);       // about to be sung
    float k = uAlpha * vFade * mix(1.0, uDim, 0.85);

    vec3 col;
    float a;
    if (vLayer > 0.5) {
        // The depth behind the face: dark until the word is sung, then glowing, deeper in colour the further back.
        float d = vLayer / uLayers;
        vec3 glow = mix(uTint, uTintB, d) * mix(1.25, 0.2, d) * (1.0 + 1.6 * hot);
        col = mix(uTint * 0.03, glow, lit) * fill;
        a = fill * mix(0.9, 1.0, lit);
    } else if (vLayer < -0.5) {
        col = mix(vec3(1.0), uTint, 0.35) * outline * 1.5;
        a = 0.0;
    } else {
        vec3 face = mix(uTint, vec3(1.0), 0.66 + 0.26 * vLocal.y);
        vec3 on = face * (1.0 + 2.6 * hot) * (1.0 + 0.25 * uKick) * fill + uPalW * fill * edge * 2.2;
        vec3 off = uTint * 0.05 * fill + vec3(1.0) * outline * (0.5 + 0.8 * cue);    // an unlit sign: dark body, bright rim
        col = mix(off, on, lit);
        a = mix(max(fill * 0.9, outline), fill, lit);
    }
    gl_FragColor = vec4(col * k, a * k);
}`;

// A soft shadow behind the line, so the words read over a bright land.
const SCRIM_FRAG = /* glsl */`
uniform float uAlpha;
varying vec2 vP;
void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, uAlpha * smoothstep(1.0, 0.25, length(vP)));
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
 * Set words in type. Each word is drawn once into an atlas (outline in red,
 * fill in green); the block they make is laid out apart from it: rows broken
 * evenly and, for a poster, each scaled up to the width of the widest.
 * @returns {{ canvas, w, h, items: Array<{x,y,w,h,u0,v0,u1,v1,row}> }} word boxes in block px, origin at the block's centre, y up
 */
function typeset(texts, { family, italic, maxEm, weight = 800, caps = false, poster = false }) {
    const px = FONT_PX;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const setFont = () => {
        ctx.font = `${italic ? 'italic ' : ''}${weight} ${px}px ${family}`;
        if (caps && 'letterSpacing' in ctx) ctx.letterSpacing = `${(px * 0.02).toFixed(1)}px`;
    };
    setFont();
    if (caps) texts = texts.map((t) => t.toLocaleUpperCase());
    const widths = texts.map((t) => ctx.measureText(t).width);
    const space = px * 0.3;
    const total = widths.reduce((a, b) => a + b, 0) + space * (texts.length - 1);
    const count = Math.max(1, Math.min(4, Math.ceil(total / (maxEm * px))));
    // Greedy fill toward an even split, so rows are balanced instead of one long and one stub.
    const target = total / count;
    const rows = [[]];
    let acc = 0;
    texts.forEach((t, i) => {
        const w = widths[i];
        const row = rows[rows.length - 1];
        if (row.length && rows.length < count && acc + w / 2 > target) {
            rows.push([i]);
            acc = w + space;
        } else {
            row.push(i);
            acc += w + space;
        }
    });
    const rowWidth = (row) => row.reduce((a, i) => a + widths[i], 0) + space * (row.length - 1);
    const widest = Math.max(...rows.map(rowWidth));
    const scales = rows.map((row) => (poster ? Math.min(1.7, widest / rowWidth(row)) : 1));
    const lh = px * (caps ? 1.04 : 1.16);

    // The atlas: one cell per word, on shelves.
    const edge = px * 0.12;         // a word's cell reaches this far into the gaps around it
    const cellH = Math.ceil(px * 1.32);
    let ax = 0, ay = 0, aw = 2;
    const cells = widths.map((w) => {
        const cw = Math.ceil(w + edge * 2);
        if (ax > 0 && ax + cw > 2048) {
            ax = 0;
            ay += cellH + 2;
        }
        const cell = { x: ax, y: ay, w: cw };
        ax += cw + 2;
        aw = Math.max(aw, ax);
        return cell;
    });
    canvas.width = aw;
    canvas.height = ay + cellH;
    setFont();
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, px * 0.045);
    ctx.globalCompositeOperation = 'lighter';
    cells.forEach((cell, i) => {
        const base = cell.y + px * 1.02;
        ctx.strokeStyle = '#f00';
        ctx.strokeText(texts[i], cell.x + edge, base);
        ctx.fillStyle = '#0f0';
        ctx.fillText(texts[i], cell.x + edge, base);
    });

    const items = [];
    const h = rows.reduce((a, row, r) => a + lh * scales[r], 0);
    let top = h / 2;
    rows.forEach((row, r) => {
        const s = scales[r];
        let x = -(rowWidth(row) * s) / 2;
        for (const i of row) {
            const cell = cells[i];
            items[i] = {
                x: x + (widths[i] * s) / 2,
                y: top - (lh * s) / 2,
                w: cell.w * s,
                h: cellH * s,
                u0: cell.x / canvas.width, u1: (cell.x + cell.w) / canvas.width,
                v0: 1 - (cell.y + cellH) / canvas.height, v1: 1 - cell.y / canvas.height,
                row: r,
            };
            x += (widths[i] + space) * s;
        }
        top -= lh * s;
    });
    return { canvas, w: widest + edge * 2, h, items };
}

/** A line of timed words as one mesh: every word a stack of quads, back to front. */
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
        const layers = style.layers ?? LAYERS;
        // Back of the depth first, the face over it, and the ring a struck word throws off last.
        const stack = [];
        for (let l = layers; l >= 0; l--) stack.push(l);
        if (!style.plain) stack.push(-1);
        const total = n * stack.length;
        const quad = new THREE.PlaneGeometry(1, 1);
        const geo = this.geometry = new THREE.InstancedBufferGeometry();
        geo.index = quad.index;
        geo.setAttribute('position', quad.getAttribute('position'));
        const rect = new Float32Array(total * 4), uv = new Float32Array(total * 4), word = new Float32Array(total * 4), slab = new Float32Array(total * 3);
        let at = 0;
        for (const layer of stack) {
            set.items.forEach((it, i) => {
                rect.set([it.x, it.y, it.w, it.h], at * 4);
                uv.set([it.u0, it.v0, it.u1, it.v1], at * 4);
                word.set([words[i].s, words[i].e, n > 1 ? i / (n - 1) : 0, this.words[i].held ? 1 : 0], at * 4);
                slab.set([layer, it.row % 2 ? -1 : 1, (i * 0.618034) % 1], at * 3);
                at++;
            });
        }
        geo.setAttribute('aRect', new THREE.InstancedBufferAttribute(rect, 4));
        geo.setAttribute('aUv', new THREE.InstancedBufferAttribute(uv, 4));
        geo.setAttribute('aWord', new THREE.InstancedBufferAttribute(word, 4));
        geo.setAttribute('aSlab', new THREE.InstancedBufferAttribute(slab, 3));
        geo.instanceCount = total;

        this.uniforms = {
            ...globals,
            uAtlas: { value: tex },
            uAlpha: { value: 1 },
            uPlain: { value: style.plain ? 1 : 0 },
            uTint: { value: new THREE.Vector3(1, 1, 1) },
            uTintB: { value: new THREE.Vector3(1, 1, 1) },
            uLayers: { value: Math.max(1, layers) },
            uIn: { value: 1 },
            uInMode: { value: 0 },
            uOut: { value: 0 },
            uOutMode: { value: 0 },
            uDir: { value: 1 },
            uEm: { value: FONT_PX },
            uW: { value: set.w },
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

    /** Size and stand the line: `unit` world units per block px, turned by `yaw` and `pitch`. */
    place(x, y, z, unit, yaw = 0, pitch = 0) {
        this.mesh.position.set(x, y, z);
        this.mesh.rotation.set(pitch, yaw, 0);
        this.mesh.scale.setScalar(unit);
    }

    /** Both colours of the line: the face's, and the one its depth runs to. */
    tint(a, b) {
        this.uniforms.uTint.value.copy(a);
        this.uniforms.uTintB.value.copy(b || a);
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
     * @param {object} timeline  the shared LyricsTimeline (ctx.lyrics)
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
        this.busy = 0;               // 0..1, how much of the stage the words hold right now
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
        const line = new TextLine(this.globals, this.timeline.lines[i].words, { family: this.family, maxEm, caps: true, poster: true });
        line.mesh.visible = false;
        this.frame.add(line.mesh);
        return { i, line };
    }

    /** A backing vocal is on stage at t. */
    _adlibLive(t) {
        for (const a of this.timeline.adlibs) if (t >= a.s - 0.3 && t <= a.e + AD_TAIL) return true;
        return false;
    }

    /**
     * Per-frame update.
     * @param {object} S                 show state
     * @param {THREE.PerspectiveCamera} camera
     * @param {{ bottom: number, still: boolean }} view  fraction of the screen's height covered at the bottom
     *                                   (the song's card); `still` for reduced motion
     */
    update(S, camera, view) {
        const { F, t, dt } = S;
        const G = this.globals;
        this.onset = null;
        this.cue = null;
        this.sync();
        this.alpha = lerp(this.alpha, this.visible && this.ready ? 1 : 0, 1 - Math.exp(-dt / 0.25));
        if (this.alpha < 0.01 || !this.ready) {
            this.frame.visible = false;
            this.focus = null;
            this.busy = 0;
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
        const maxEm = clamp(cam.aspect * 5.6, 4.5, 11);

        // ---- Line changes ----
        const idx = tl.lineIndex(t);
        if (idx !== this.idx) {
            const forward = idx === this.idx + 1;
            const busy = this._adlibLive(t);
            if (this._old) this._old.line.dispose();
            this._old = null;
            let tr = '';
            // (A ♪ line was never on screen, so it has nothing to take off it.)
            if (this._cur && forward && !tl.lines[this._cur.i].blank) {
                tr = idx >= 0 ? (this._lastTr = pickTransition(F, idx, this._lastTr)) : 'lift';
                if (busy && THROUGH_ADLIBS[tr]) tr = 'sweep';
                // Swept, a line goes off to the left: the next one comes in from the right.
                this._old = { ...this._cur, tr, at: tl.lines[idx].on, top: this._top };
                this.cue = { type: tr };
            } else if (this._cur) this._cur.line.dispose();
            const promoted = forward && this._next && this._next.i === idx;
            if (this._next && !promoted) this._next.line.dispose();
            this._cur = idx >= 0 ? (promoted ? this._next : this._make(idx, maxEm)) : null;
            if (this._cur) {
                // It lets the line that is leaving clear the spot first, and comes in from the other side.
                this._cur.wait = this._old ? ENTER_AFTER : 0;
                let mode = tr ? FOLLOW[tr] : OPENERS[idx % OPENERS.length];
                if (busy && mode === IN.drop) mode = IN.rise;
                this._cur.mode = mode;
            }
            // The line after is set in type ahead of time, off stage.
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

        // ---- Place the line ----
        // One block, between the song's card and the rows kept for the backing vocals.
        const present = this.alpha * (1 - 0.92 * this._it);
        const floor = (-1 + 2 * view.bottom) * hh + 0.06 * hh;   // the lowest the words may reach
        const ceil = 0.6 * hh;                                   // and the highest
        const cy = lerp(floor, ceil, 0.46);
        const fit = (rec) => Math.min((0.2 * hh) / FONT_PX, (hw * 2 * 0.74) / rec.line.w, ((ceil - floor) * 0.9) / rec.line.h);
        const cur = this._cur;
        const shown = !!cur && !line.blank;
        const unit = cur ? fit(cur) : 0;
        const curH = shown ? cur.line.h * unit : 0;
        this._top = cy + curH / 2;
        // Backing vocals sit over whatever is tallest on stage, the line still leaving included.
        const adTop = Math.max(this._top, this._old ? this._old.top : -1e3);
        this._adTop = F.jumped || this._adTop === undefined ? adTop : lerp(this._adTop, adTop, 1 - Math.exp(-dt * (adTop > this._adTop ? 30 : 6)));

        let enter = 1;
        if (cur) {
            const L = tl.lines[cur.i];
            enter = clamp((t - L.on - cur.wait) / ENTER, 0, 1);
            // The block turns slowly past square as the line is sung, each line the other way.
            const through = clamp((t - L.on) / Math.max(1, L.end - L.on + 0.6), 0, 1);
            const dir = cur.i & 1 ? -1 : 1;
            const yaw = view.still ? 0 : dir * lerp(0.15, -0.07, smooth(through));
            cur.line.mesh.visible = shown;
            cur.line.place(0, cy, 0, unit, yaw, view.still ? 0 : -0.04);
            cur.line.mesh.updateMatrixWorld(true);
            const u = cur.line.uniforms;
            u.uIn.value = enter;
            u.uInMode.value = cur.mode;
            u.uOut.value = 0;
            u.uAlpha.value = present * (resting ? 0.55 : 1) * (shown ? 1 : 0);
            cur.line.tint(G.uPalA.value, G.uPalB.value);
            this.scrim.position.set(0, cy, -0.6);
            this.scrim.scale.set(cur.line.w * unit * 1.7, Math.max(curH, 0.01) * 2.3, 1);
            this.scrimU.uAlpha.value = 0.72 * u.uAlpha.value * enter;
        } else this.scrimU.uAlpha.value = 0;
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
                u.uOutMode.value = OUT_MODES[rec.tr] ?? 0;
                u.uDir.value = -1;
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
            const pos = this._v.set(w.x, w.y, 0).applyMatrix4(cur.line.mesh.matrixWorld);
            const s = strength * present * smooth(enter) * (resting ? 0.4 : 1);
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

        this.busy = Math.max(shown ? cur.line.uniforms.uAlpha.value : 0, this._updateAdlibs(t, hw, hh, present));
    }

    /** Backing vocals: over the line while they are sung (left and right, a row each), then drifting away. Returns how visible they are. */
    _updateAdlibs(t, hw, hh, present) {
        const list = this.timeline.adlibs;
        const G = this.globals;
        let shown = 0;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            const live = t >= a.s - 0.2 && t <= a.e + AD_TAIL;
            let rec = this._adlibs.get(i);
            if (live && !rec) {
                rec = new TextLine(this.globals, a.words, { family: this.family, maxEm: 9, italic: true, weight: 700, layers: 3 });
                this.frame.add(rec.mesh);
                this._adlibs.set(i, rec);
            } else if (!live && rec) {
                rec.dispose();
                this._adlibs.delete(i);
                continue;
            }
            if (!rec) continue;
            // Each stays on its own half of the screen and its own row above the line.
            const unit = Math.min((0.085 * hh) / FONT_PX, (hw * 0.72) / rec.w);
            const h = rec.h * unit;
            const side = a.k % 2 ? -1 : 1;
            const row = (a.k >> 1) % 2;
            const gone = clamp((t - a.e) / AD_TAIL, 0, 1);
            const y = Math.min(this._adTop + 0.05 * hh + h / 2 + row * h * 1.1, 0.84 * hh) + gone * 0.05 * hh;
            rec.place(side * hw * 0.5, y, -2 * gone, unit, -side * 0.12);
            rec.tint(G.uPalB.value, G.uPalC.value);
            rec.uniforms.uIn.value = clamp((t - a.s + 0.2) / 0.3, 0, 1);
            rec.uniforms.uInMode.value = IN.rise;
            rec.uniforms.uAlpha.value = present * 0.85 * (1 - gone);
            shown = Math.max(shown, rec.uniforms.uAlpha.value);
        }
        return shown;
    }

    dispose() {
        this._reset();
        this.frame.removeFromParent();
        this.dotGeo.dispose();
        this.scrim.material.dispose();
        for (const d of this.dots) d.mesh.material.dispose();
    }
}
