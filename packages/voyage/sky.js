/**
 * Voyage sky: a dome around the camera.
 *
 * The horizon glows in the colour of the section that is coming, stars
 * twinkle with the hi-hats, a nebula in the palette swells with the song's
 * energy, an aurora hangs over the quiet sections and the snare can light
 * the clouds from behind.
 */
import { THREE, GLSL_NOISE, GLSL_COMMON } from './glsl.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;   // on the far plane
}`;

const FRAG = /* glsl */`
#define FBM_OCTAVES SKY_OCTAVES
${GLSL_NOISE}
${GLSL_COMMON}
varying vec3 vDir;
uniform float uStars, uNebula, uAurora, uLightning, uEnergy;

void main() {
    vec3 d = normalize(vDir);
    float el = d.y;
    float az = atan(d.x, -d.z);      // 0 = straight down the road

    // Night above, the coming section's colour along the horizon.
    vec3 col = mix(uHorizon * 0.22, uDeep * 0.05, smoothstep(-0.08, 0.6, el));
    float band = exp(-abs(el) * 7.0);
    col += uHorizon * band * (0.3 + 0.55 * uRms + 0.35 * uBuild);
    // The glow gathers where the road meets the sky.
    col += mix(uHorizon, uPalW, 0.35) * exp(-abs(el) * 14.0) * exp(-az * az * 2.2) * (0.5 + 0.7 * uRms);

    float up = smoothstep(-0.02, 0.35, el);
    vec2 q = vec2(az * 1.25, el * 2.4);

    // Nebula in the palette.
    float n1 = fbm(q * 1.4 + vec2(uNow * 0.004, 0.0));
    float n2 = fbm(q * 2.9 + vec2(n1 * 1.7, -uNow * 0.003));
    float neb = smoothstep(0.38, 0.8, n2) * up;
    col += mix(uPalA, uPalB, smoothstep(0.3, 0.7, n1)) * neb * neb * uNebula * (0.16 + 0.5 * uEnergy);

    // Stars.
    vec2 sp = vec2(az, asin(clamp(el, -1.0, 1.0))) * 70.0;
    vec2 id = floor(sp);
    float h = hash21(id);
    vec2 f = fract(sp) - 0.5 - (vec2(hash21(id + 3.1), hash21(id + 7.7)) - 0.5) * 0.7;
    float star = step(0.93, h) * smoothstep(0.16, 0.0, length(f));
    star *= 0.35 + 0.65 * (0.5 + 0.5 * sin(uNow * (0.8 + 3.0 * h) + h * 60.0)) + 1.5 * uHat * step(0.975, h);
    col += mix(vec3(1.0), uPalW, 0.5) * star * uStars * up * (1.0 - 0.7 * neb);

    // Aurora over the quiet sections.
    if (uAurora > 0.01) {
        float curtain = fbm(vec2(az * 2.2 + uNow * 0.015, uNow * 0.02));
        float rays = vnoise(vec2(az * 34.0 + curtain * 7.0, uNow * 0.12));
        float veil = smoothstep(0.06, 0.3, el) * smoothstep(0.85, 0.3, el);
        float fold = smoothstep(0.3, 0.75, curtain + 0.12 * sin(el * 9.0 + uNow * 0.2));
        col += mix(uPalC, uPalA, curtain) * veil * fold * (0.35 + 0.65 * rays * rays) * uAurora * 1.3;
    }

    // Sheet lightning behind the nebula.
    if (uLightning > 0.01) {
        float cell = fbm(q * 2.0 + floor(uNow * 9.0) * 3.7);
        col += uPalW * uLightning * smoothstep(0.45, 0.8, cell) * up * 1.6;
    }

    gl_FragColor = vec4(col * uDim, 1.0);
}`;

export class Sky {
    constructor(globals) {
        this.uniforms = {
            ...globals,
            uStars: { value: 1 },
            uNebula: { value: 1 },
            uAurora: { value: 0 },
            uLightning: { value: 0 },
            uEnergy: { value: 0.5 },
        };
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
            defines: { SKY_OCTAVES: 5 }, side: THREE.BackSide, depthTest: false, depthWrite: false,
        });
        this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = -100;
    }

    setQuality(tier) {
        const octaves = tier === 0 ? 5 : tier === 1 ? 4 : 3;
        if (this.material.defines.SKY_OCTAVES === octaves) return;
        this.material.defines.SKY_OCTAVES = octaves;
        this.material.needsUpdate = true;
    }

    /** Keep the dome centred on the camera. */
    follow(camera) {
        this.mesh.position.copy(camera.position);
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
