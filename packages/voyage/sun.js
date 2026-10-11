/**
 * Voyage sun: the song's own star, at the end of the road.
 *
 * Its face is the album cover (washed toward the palette so it belongs to the
 * sky), its corona beats with the sub bass and the kick, and its ring is the
 * world's clock: it goes dark in the silence before a drop (a total eclipse,
 * only the ring left) and fills up while an instrumental break runs out.
 */
import { THREE, GLSL_NOISE, GLSL_COMMON, blankTexture } from './glsl.js';
import { FAR } from './world.js';

const VERT = /* glsl */`
varying vec2 vP;
void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
#define FBM_OCTAVES 3
${GLSL_NOISE}
${GLSL_COMMON}
uniform sampler2D uCover;
uniform float uHasCover, uFill, uStripes, uPulse;
varying vec2 vP;

const float R = 0.36;      // radius of the disc inside the quad

void main() {
    vec2 p = vP;
    float r = length(p);
    float disc = smoothstep(R, R - 0.006, r);

    // The face: the cover, or a plain gradient star.
    vec2 cuv = p / R * 0.5 + 0.5;
    vec3 cover = toLinear(texture2D(uCover, clamp(cuv, 0.0, 1.0)).rgb);
    float lum = dot(cover, vec3(0.2126, 0.7152, 0.0722));
    vec3 washed = mix(cover, mix(uPalA, uPalW, smoothstep(0.1, 0.9, lum)) * (0.2 + 0.8 * lum), 0.35);
    vec3 plain = mix(uPalB, mix(uPalA, uPalW, 0.5), smoothstep(-R, R, p.y)) * 0.9;
    vec3 face = mix(plain, washed * 0.62, uHasCover);
    face *= 1.0 - 0.5 * smoothstep(R * 0.5, R, r);               // limb darkening
    face *= 0.85 + 0.2 * uPulse;
    // Synthwave bands across the lower half.
    float bands = step(0.0, -p.y) * step(0.55, fract(-p.y / R * 5.0 + 0.1)) * uStripes;
    float lit = disc * (1.0 - bands);
    // Total eclipse in the silence before a drop.
    face *= 1.0 - uStop;

    // Corona: rays that swell with the sub bass.
    float a = atan(p.y, p.x);
    float rays = fbm(vec2(a * 2.6 + uNow * 0.03, r * 3.0 - uNow * 0.07));
    float out_ = max(r - R, 0.0);
    float rim = smoothstep(1.0, 0.62, r);                         // nothing reaches the edge of the quad
    float corona = exp(-out_ * (13.0 - 5.0 * uPulse)) * (0.3 + 1.0 * rays) * step(R, r) * (0.35 + 1.0 * uPulse + 0.5 * uBuild) * rim;
    float halo = exp(-out_ * 4.5) * 0.14 * (0.5 + uRms) * rim;

    // The ring, and its arc that fills as an instrumental break runs out.
    float ring = exp(-pow((r - R * 1.16) / 0.0045, 2.0));
    float turn = fract(atan(p.x, p.y) / 6.28318530718 + 1.0);     // 0 at the top, clockwise
    float arc = step(turn, uFill) * exp(-pow((r - R * 1.27) / 0.011, 2.0)) * step(0.001, uFill);

    vec3 glowCol = mix(uPalA, uPalW, 0.45);
    vec3 col = face * lit * uDim
             + glowCol * (corona + halo) * uDim * (1.0 - 0.8 * uStop)
             + uPalW * ring * (0.5 + 0.6 * uKick + 1.6 * uStop)       // the ring outlives the blackout
             + mix(uPalB, uPalW, 0.5) * arc * 2.2;
    // The disc hides the sky behind it; everything else is light added on top.
    gl_FragColor = vec4(col, disc);
}`;

export class Sun {
    constructor(globals) {
        this._blank = blankTexture();
        this.uniforms = {
            ...globals,
            uCover: { value: this._blank },
            uHasCover: { value: 0 },
            uFill: { value: 0 },
            uStripes: { value: 0 },
            uPulse: { value: 0 },
        };
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
            transparent: true, depthWrite: false,
            blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        });
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 5;
        this.size = 150;
        this.mesh.position.set(0, 62, -FAR * 0.93);
        this.mesh.scale.set(this.size, this.size, 1);
        this._cover = null;
        this._url = null;
        this._loader = new THREE.TextureLoader();
        this._loader.setCrossOrigin('anonymous');
    }

    /** Show a cover on the sun's face (null = a plain star). A cover that fails to load is just that. */
    setCover(url) {
        if (url === this._url) return;
        this._url = url;
        const drop = () => {
            if (this._cover) this._cover.dispose();
            this._cover = null;
            this.uniforms.uCover.value = this._blank;
            this.uniforms.uHasCover.value = 0;
        };
        if (!url) {
            drop();
            return;
        }
        this._loader.load(url, (tex) => {
            if (url !== this._url) {
                tex.dispose();
                return;
            }
            drop();
            tex.colorSpace = THREE.NoColorSpace;      // decoded by hand in the shader
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.generateMipmaps = true;
            this._cover = tex;
            this.uniforms.uCover.value = tex;
            this.uniforms.uHasCover.value = 1;
        }, undefined, () => {
            if (url === this._url) drop();
        });
    }

    dispose() {
        this._url = null;
        if (this._cover) this._cover.dispose();
        this._blank.dispose();
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
