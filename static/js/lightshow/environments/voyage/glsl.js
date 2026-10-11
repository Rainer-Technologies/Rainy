/**
 * Shared GLSL and the uniforms every Voyage material reads.
 *
 * Colours travel in linear light: palettes arrive as 0..255 sRGB triplets
 * (see palette.js) and are converted once here; the composite pass (post.js)
 * tone-maps and encodes for the screen.
 */
import * as THREE from '../../../vendor/three/three.module.min.js';

export { THREE };

/** 0..255 sRGB triplet → linear Vector3 (in place). */
export function setLinear(v, rgb, gain = 1) {
    v.set(
        Math.pow(Math.max(0, rgb[0]) / 255, 2.2) * gain,
        Math.pow(Math.max(0, rgb[1]) / 255, 2.2) * gain,
        Math.pow(Math.max(0, rgb[2]) / 255, 2.2) * gain,
    );
    return v;
}

/** A 1×1 texture, for samplers that have nothing to show yet. */
export function blankTexture(r = 0, g = 0, b = 0, a = 255) {
    const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    return tex;
}

/** Rows of RGBA bytes as a texture that interpolates along time (v) only. */
export function rowsTexture(data, width, rows) {
    const tex = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

/**
 * The state of the show as uniforms, shared by reference between materials:
 * write a value once per frame and every shader sees it.
 */
export function createGlobals() {
    const v3 = () => new THREE.Vector3();
    return {
        uT: { value: 0 },            // media time (s)
        uNow: { value: 0 },          // wall clock (s), for motion that keeps going while paused
        uU: { value: 26 },           // units of road per second of music
        uDuration: { value: 1 },     // song length (s)
        uScored: { value: 0 },       // 1 when the world comes from a score, 0 in live mode
        uDim: { value: 1 },          // master dimmer
        uKick: { value: 0 },
        uSnare: { value: 0 },
        uHat: { value: 0 },
        uRms: { value: 0 },
        uSub: { value: 0 },
        uBuild: { value: 0 },        // build-up tension 0..1
        uStop: { value: 0 },         // depth of the silence before a drop 0..1
        uHeat: { value: 0.4 },       // how hot the section is
        uPalA: { value: v3() },
        uPalB: { value: v3() },
        uPalC: { value: v3() },
        uPalW: { value: v3() },
        uDeep: { value: v3() },
        uHorizon: { value: v3() },   // colour of the horizon: the section that is coming
        uFogK: { value: 0.0045 },
        uEnvA: { value: null },      // sub, bass, mid, high per moment
        uEnvB: { value: null },      // air, rms, mass, harm per moment
        uPal: { value: null },       // colours of every moment (see world.bakePalettes)
    };
}

export const GLSL_NOISE = /* glsl */`
float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < FBM_OCTAVES; i++) {
        s += a * vnoise(p);
        p = p * 2.03 + 17.1;
        a *= 0.5;
    }
    return s;
}
`;

export const GLSL_COMMON = /* glsl */`
uniform float uT, uNow, uU, uDuration, uScored, uDim, uKick, uSnare, uHat, uRms, uSub, uBuild, uStop, uHeat, uFogK;
uniform vec3 uPalA, uPalB, uPalC, uPalW, uDeep, uHorizon;
uniform sampler2D uEnvA, uEnvB, uPal;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }

/** Media time of a point z units along the camera's axis (negative = ahead). */
float tauAt(float z) { return uT - z / uU; }

/** Row of the song's textures for a media time. */
float rowOf(float tau) { return clamp(tau / uDuration, 0.0, 1.0); }

/** Colours of the moment tau (linear); alpha = energy / heat / build tension / stop. */
vec4 palA(float tau) { vec4 c = texture2D(uPal, vec2(0.125, rowOf(tau))); return vec4(toLinear(c.rgb), c.a); }
vec4 palB(float tau) { vec4 c = texture2D(uPal, vec2(0.375, rowOf(tau))); return vec4(toLinear(c.rgb), c.a); }
vec4 palC(float tau) { vec4 c = texture2D(uPal, vec2(0.625, rowOf(tau))); return vec4(toLinear(c.rgb), c.a); }
vec4 palW(float tau) { vec4 c = texture2D(uPal, vec2(0.875, rowOf(tau))); return vec4(toLinear(c.rgb), c.a); }

/** Distance haze toward the horizon colour. */
vec3 applyFog(vec3 col, float dist) {
    float f = 1.0 - exp(-dist * uFogK);
    return mix(col, uHorizon * 0.5 * uDim, f * f);
}
`;
