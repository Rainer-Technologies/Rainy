/**
 * Voyage gates and portals: the beat grid and the song's structure, standing
 * on the road.
 *
 *  - Gates   — one per beat (world.buildGates). The camera reaches each one at
 *              its beat, so flying through it *is* the beat. Bars are double,
 *              phrase arches triple, and a build squeezes in half and quarter
 *              beats. A gate already wears the colours of its own moment, so
 *              the next section's gates are visibly different from afar.
 *  - Portals — one per section change, a great ring across the valley in the
 *              colours of the section it opens. A drop's portal is a wall of
 *              light.
 */
import { THREE, GLSL_NOISE, GLSL_COMMON } from './glsl.js';

export const MAX_GATES = 96;
const MAX_PORTALS = 3;

const GATE_VERT = /* glsl */`
${GLSL_COMMON}
attribute vec4 aGate;        // x = z in camera space, y = kind, z = power, w = media time
uniform float uGateR;
varying vec2 vP;
varying float vKind, vPower, vAhead, vTau, vY;
void main() {
    float kind = aGate.y;
    float s = uGateR * (kind < 0.5 ? 0.72 : kind < 1.5 ? 1.0 : kind < 2.5 ? 1.16 : 1.42);
    vP = position.xy * 1.5;
    // Standing on the road, the lowest point just under it.
    vec3 p = vec3(vP.x * s, vP.y * s + s * 0.8, aGate.x);
    vKind = kind;
    vPower = aGate.z;
    vAhead = -aGate.x;
    vTau = aGate.w;
    vY = p.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const GATE_FRAG = /* glsl */`
${GLSL_COMMON}
uniform float uSides, uRot;
varying vec2 vP;
varying float vKind, vPower, vAhead, vTau, vY;

/** Signed distance to an outline of radius 1: a ring, or a polygon with uSides sides. */
float outline(vec2 p, float rot) {
    float r = length(p);
    if (uSides < 2.5) return r - 1.0;
    float a = atan(p.x, p.y) + rot;
    float seg = 6.28318530718 / uSides;
    return cos(floor(0.5 + a / seg) * seg - a) * r - cos(3.14159265 / uSides);
}

void main() {
    float d = outline(vP, vKind > 2.5 ? uRot : 0.0);
    float aw = fwidth(d);
    float thick = (vKind < 0.5 ? 0.007 : 0.012) + 0.012 * vPower;
    thick *= mix(0.3, 1.0, smoothstep(0.0, 45.0, vAhead));       // a hairline by the time it reaches the camera
    float line = smoothstep(thick + aw, thick, abs(d));
    // Bars get a second outline, phrase arches a third.
    if (vKind > 1.5) line += 0.7 * smoothstep(thick * 0.7 + aw, thick * 0.7, abs(d + 0.13));
    if (vKind > 2.5) line += 0.5 * smoothstep(thick * 0.6 + aw, thick * 0.6, abs(d + 0.27));
    // Only a tight halo of its own: the bloom does the rest.
    float glow = exp(-abs(d) * 30.0) * 0.22;

    vec3 ca = mix(uPalA, palA(vTau).rgb, uScored);
    vec3 cb = mix(uPalB, palB(vTau).rgb, uScored);
    vec3 base = vKind > 1.5 ? mix(cb, uPalW, 0.25) : ca;

    // Faint far away, white-hot as the camera comes up to it, and gone before
    // it fills the screen: flying through it is a flare round the frame.
    float near = exp(-pow((vAhead - uU * 0.3) / (uU * 0.24), 2.0));
    float far = exp(-vAhead * 0.006);
    float b = (0.3 + 0.7 * vPower) * far * (0.45 + 0.9 * uHeat + 0.35 * uKick) + near * (0.8 + 1.5 * vPower);
    b *= smoothstep(1.0, 7.0, vAhead);
    // It rises out of the road instead of being cut by it.
    b *= smoothstep(-0.1, 1.6, vY);
    vec3 col = mix(base, uPalW, near * 0.75) * (line + glow) * b * (vKind < 0.5 ? 0.6 : 1.0);
    gl_FragColor = vec4(col * uDim, 1.0);
}`;

const PORTAL_VERT = /* glsl */`
varying vec2 vP;
void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PORTAL_FRAG = /* glsl */`
#define FBM_OCTAVES 3
${GLSL_NOISE}
${GLSL_COMMON}
uniform vec3 uColA, uColB;
uniform float uDrop, uAhead, uRadius;
varying vec2 vP;
void main() {
    vec2 p = vP / uRadius;
    float r = length(p);
    float a = atan(p.x, p.y);
    // The frame: a sharp ring with a soft one around it, ticking round like a dial.
    float ring = exp(-pow((r - 1.0) / 0.012, 2.0)) + 0.35 * exp(-pow((r - 1.0) / 0.07, 2.0));
    float ticks = step(0.5, fract(a * 9.549 + uNow * 0.08)) * exp(-pow((r - 1.09) / 0.02, 2.0)) * 0.6;
    // The membrane: a shimmer you can see through. Before a drop it thickens
    // into a wall of light, but only in the last moments before you hit it.
    float inside = smoothstep(1.0, 0.94, r);
    float flow = fbm(p * 2.6 + vec2(0.0, -uNow * 0.35));
    float streaks = vnoise(vec2(a * 22.0, r * 3.0 - uNow * 0.9));
    float close = exp(-uAhead * 0.03);
    float wall = uDrop * (0.05 + 0.75 * close * close * close) * (0.25 + 1.1 * flow * (0.4 + 0.6 * streaks));
    float mem = inside * (0.02 + wall + 0.05 * streaks * (1.0 - r));
    float fade = exp(-uAhead * 0.0035) * smoothstep(0.5, 9.0, uAhead);
    vec3 col = mix(uColA, uColB, smoothstep(0.3, 0.7, flow)) * (ring * (1.6 + 1.4 * uKick) + ticks)
             + mix(uColA, uPalW, 0.25 + 0.35 * uDrop) * mem * 2.0;
    gl_FragColor = vec4(col * fade * uDim, 1.0);
}`;

export class Gates {
    constructor(globals) {
        this.uniforms = { ...globals, uGateR: { value: 8.5 }, uSides: { value: 0 }, uRot: { value: 0 } };
        const quad = new THREE.PlaneGeometry(2, 2);
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = quad.index;
        geo.setAttribute('position', quad.getAttribute('position'));
        this.data = new Float32Array(MAX_GATES * 4);
        this.attr = new THREE.InstancedBufferAttribute(this.data, 4);
        this.attr.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aGate', this.attr);
        geo.instanceCount = 0;
        this.material = new THREE.ShaderMaterial({
            vertexShader: GATE_VERT, fragmentShader: GATE_FRAG, uniforms: this.uniforms,
            blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 20;
        this.count = 0;
    }

    begin() {
        this.count = 0;
    }

    /** Stand a gate `z` units along the camera's axis (negative = ahead). */
    add(z, kind, power, tau) {
        if (this.count >= MAX_GATES) return;
        const o = this.count++ * 4;
        this.data[o] = z;
        this.data[o + 1] = kind;
        this.data[o + 2] = power;
        this.data[o + 3] = tau;
    }

    end() {
        this.mesh.geometry.instanceCount = this.count;
        this.attr.needsUpdate = true;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}

export class Portals {
    constructor(globals) {
        this.geometry = new THREE.PlaneGeometry(2, 2);
        this.group = new THREE.Group();
        this.items = [];
        for (let i = 0; i < MAX_PORTALS; i++) {
            const uniforms = {
                ...globals,
                uColA: { value: new THREE.Vector3() },
                uColB: { value: new THREE.Vector3() },
                uDrop: { value: 0 },
                uAhead: { value: 0 },
                uRadius: { value: 0.8 },
            };
            const material = new THREE.ShaderMaterial({
                vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG, uniforms,
                blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(this.geometry, material);
            mesh.frustumCulled = false;
            mesh.renderOrder = 15;
            mesh.visible = false;
            this.group.add(mesh);
            this.items.push({ mesh, uniforms });
        }
        this.count = 0;
    }

    begin() {
        this.count = 0;
    }

    /**
     * @param {number} z       camera-space z of the section change
     * @param {THREE.Vector3} colA  the new section's colours (linear)
     * @param {THREE.Vector3} colB
     * @param {boolean} drop
     */
    add(z, colA, colB, drop) {
        if (this.count >= MAX_PORTALS) return;
        const { mesh, uniforms } = this.items[this.count++];
        const size = 62;                 // half the quad; the ring is 0.8 of it
        mesh.visible = true;
        mesh.scale.set(size, size, 1);
        mesh.position.set(0, size * 0.62, z);
        uniforms.uColA.value.copy(colA);
        uniforms.uColB.value.copy(colB);
        uniforms.uDrop.value = drop ? 1 : 0;
        uniforms.uAhead.value = -z;
    }

    end() {
        for (let i = this.count; i < MAX_PORTALS; i++) this.items[i].mesh.visible = false;
    }

    dispose() {
        this.geometry.dispose();
        for (const { mesh } of this.items) mesh.material.dispose();
    }
}
