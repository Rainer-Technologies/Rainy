/**
 * Voyage post-processing: the world is rendered in HDR, the bright parts
 * bloom, and one composite pass turns it into the picture.
 *
 *   scene (HDR) ─▶ prefilter ─▶ down … down ─▶ up … up ─▶ bloom
 *        └───────────────────────────────────────────────┴─▶ composite ─▶ screen
 *
 * The composite adds the bloom, chromatic aberration and speed blur (hits,
 * drops, builds), exposure × master dimmer, tone mapping, vignette, grain,
 * the blinders and the (photosensitivity-limited) flash from the conductor.
 */
import { THREE } from './glsl.js';

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Bright pass + first halving. A soft knee keeps the threshold from popping.
const PREFILTER = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
vec3 bright(vec3 c) {
    float l = max(c.r, max(c.g, c.b));
    float k = clamp((l - uThreshold) / max(0.0001, uThreshold * 0.6), 0.0, 1.0);
    return c * k * k * min(1.0, 6.0 / max(l, 0.0001));
}
void main() {
    vec2 o = uTexel * 0.5;
    vec3 c = bright(texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb)
           + bright(texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb)
           + bright(texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb)
           + bright(texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb);
    gl_FragColor = vec4(c * 0.25, 1.0);
}`;

// Dual-filter blur (Kawase): cheap, wide and smooth.
const DOWN = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
    vec2 o = uTexel;
    vec3 c = texture2D(tSrc, vUv).rgb * 4.0
           + texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb
           + texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb
           + texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb
           + texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb;
    gl_FragColor = vec4(c / 8.0, 1.0);
}`;

const UP = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uGain;
void main() {
    vec2 o = uTexel;
    vec3 c = texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb
           + texture2D(tSrc, vUv + vec2( o.x * 2.0, 0.0)).rgb
           + texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb
           + texture2D(tSrc, vUv + vec2(0.0,  o.y * 2.0)).rgb
           + (texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb
           +  texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb
           +  texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb
           +  texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb) * 2.0;
    gl_FragColor = vec4(c / 12.0 * uGain, 1.0);
}`;

const COMPOSITE = /* glsl */`
varying vec2 vUv;
uniform sampler2D tScene, tBloom;
uniform vec2 uRes;
uniform float uBloom, uExposure, uCA, uSpeed, uVignette, uGrain, uNow, uFlash, uBlind, uSoft;
uniform vec3 uFlashCol, uBlindCol;

vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float grain(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
}
void main() {
    vec2 c = vUv - 0.5;
    float r2 = dot(c, c);
    vec3 col;
    if (uCA > 0.0004) {
        // Colour fringes that grow toward the edges.
        vec2 o = c * uCA * (0.4 + 2.4 * r2);
        col = vec3(texture2D(tScene, vUv + o).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - o).b);
    } else {
        col = texture2D(tScene, vUv).rgb;
    }
#ifdef SPEED_BLUR
    if (uSpeed > 0.01) {
        // Streak toward the vanishing point; the centre stays sharp.
        vec3 acc = col;
        float reach = uSpeed * 0.03 * smoothstep(0.01, 0.3, r2);
        for (int i = 1; i <= 5; i++) acc += texture2D(tScene, 0.5 + c * (1.0 - reach * float(i))).rgb;
        col = acc / 6.0;
    }
#endif
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    col = mix(col, bloom * 1.4, uSoft) + bloom * uBloom;
    // Blinders: light pouring in from above.
    col += uBlindCol * uBlind * exp(-(1.0 - vUv.y) * 3.2) * 1.8;
    col = aces(col * uExposure);
    col = mix(col, uFlashCol, clamp(uFlash * 0.6, 0.0, 0.65));
    col *= 1.0 - uVignette * smoothstep(0.12, 0.62, r2);
    col = pow(col, vec3(1.0 / 2.2));
    col += (grain(vUv * uRes + fract(uNow) * 61.0) - 0.5) * uGrain;
    gl_FragColor = vec4(col, 1.0);
}`;

export class Post {
    /** @param {THREE.WebGLRenderer} renderer */
    constructor(renderer) {
        this.renderer = renderer;
        // Float targets keep the highlights that make the bloom; without them the show still runs in 8 bits.
        const gl = renderer.getContext();
        this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
        this.type = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this.quad.frustumCulled = false;
        this.scene.add(this.quad);

        const mat = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({
            vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...extra,
        });
        this.prefilter = mat(PREFILTER, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0.75 } });
        this.down = mat(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
        this.up = mat(UP, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGain: { value: 1 } },
            { blending: THREE.AdditiveBlending, transparent: true });
        this.uniforms = {
            tScene: { value: null },
            tBloom: { value: null },
            uRes: { value: new THREE.Vector2(1, 1) },
            uBloom: { value: 0.9 },
            uExposure: { value: 1 },
            uCA: { value: 0 },
            uSpeed: { value: 0 },
            uVignette: { value: 0.55 },
            uGrain: { value: 0.035 },
            uNow: { value: 0 },
            uFlash: { value: 0 },
            uFlashCol: { value: new THREE.Vector3(1, 1, 1) },
            uBlind: { value: 0 },
            uBlindCol: { value: new THREE.Vector3(1, 1, 1) },
            uSoft: { value: 0 },
        };
        this.composite = mat(COMPOSITE, this.uniforms);
        this.sceneTarget = null;
        this.mips = [];
        this.levels = 5;
        this.speedBlur = true;
        this._w = 0;
        this._h = 0;
    }

    /**
     * @param {number} w  drawing buffer width (px)
     * @param {number} h
     * @param {{ levels: number, speedBlur: boolean }} q  bloom depth and extras for the quality tier
     */
    setSize(w, h, q) {
        if (w === this._w && h === this._h && q.levels === this.levels && q.speedBlur === this.speedBlur) return;
        this._w = w;
        this._h = h;
        this.levels = q.levels;
        if (q.speedBlur !== this.speedBlur || !this._defined) {
            this._defined = true;
            this.speedBlur = q.speedBlur;
            this.composite.defines = q.speedBlur ? { SPEED_BLUR: 1 } : {};
            this.composite.needsUpdate = true;
        }
        this._disposeTargets();
        const opts = {
            type: this.type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            generateMipmaps: false, stencilBuffer: false,
        };
        this.sceneTarget = new THREE.WebGLRenderTarget(w, h, { ...opts, depthBuffer: true });
        let mw = w, mh = h;
        for (let i = 0; i < this.levels; i++) {
            mw = Math.max(2, Math.round(mw / 2));
            mh = Math.max(2, Math.round(mh / 2));
            this.mips.push(new THREE.WebGLRenderTarget(mw, mh, { ...opts, depthBuffer: false }));
        }
        this.uniforms.uRes.value.set(w, h);
    }

    _pass(material, target) {
        this.quad.material = material;
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, this.camera);
    }

    /** Draw `scene` through `camera` and put the finished picture on screen. */
    render(scene, camera) {
        const r = this.renderer;
        r.setRenderTarget(this.sceneTarget);
        r.clear();
        r.render(scene, camera);

        const mips = this.mips;
        const keep = r.autoClear;
        this.prefilter.uniforms.tSrc.value = this.sceneTarget.texture;
        this.prefilter.uniforms.uTexel.value.set(1 / this._w, 1 / this._h);
        this._pass(this.prefilter, mips[0]);
        for (let i = 1; i < mips.length; i++) {
            this.down.uniforms.tSrc.value = mips[i - 1].texture;
            this.down.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
            this._pass(this.down, mips[i]);
        }
        // Add each level onto the sharper one above it.
        r.autoClear = false;
        for (let i = mips.length - 1; i > 0; i--) {
            this.up.uniforms.tSrc.value = mips[i].texture;
            this.up.uniforms.uTexel.value.set(0.5 / mips[i].width, 0.5 / mips[i].height);
            this._pass(this.up, mips[i - 1]);
        }
        r.autoClear = keep;

        this.uniforms.tScene.value = this.sceneTarget.texture;
        this.uniforms.tBloom.value = mips[0].texture;
        this._pass(this.composite, null);
    }

    _disposeTargets() {
        if (this.sceneTarget) this.sceneTarget.dispose();
        for (const m of this.mips) m.dispose();
        this.sceneTarget = null;
        this.mips = [];
    }

    dispose() {
        this._disposeTargets();
        this.quad.geometry.dispose();
        for (const m of [this.prefilter, this.down, this.up, this.composite]) m.dispose();
    }
}
