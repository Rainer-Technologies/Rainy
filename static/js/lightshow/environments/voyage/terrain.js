/**
 * Voyage terrain: the song's envelopes as a landscape on both sides of the
 * road.
 *
 * Every row of the mesh samples the textures at the media time it stands
 * for, so the land ahead is the music that is about to play: plains in a
 * breakdown, a mountain range at the drop. Across the road the axis is
 * frequency (bass by the roadside, highs out at the peaks). The mesh rides
 * with the camera and is snapped to a world-fixed lattice, so the land does
 * not swim as it scrolls.
 */
import { THREE, GLSL_NOISE, GLSL_COMMON } from './glsl.js';
import { FAR, BEHIND } from './world.js';

export const HALF_WIDTH = 170;
const SEGMENTS = [[168, 230], [116, 160], [76, 104]];   // [across, along] per quality tier

const VERT = /* glsl */`
#define FBM_OCTAVES 4
${GLSL_NOISE}
${GLSL_COMMON}
uniform float uSnap, uRoadW, uAmp, uRough, uLift;
varying vec3 vPos;
varying float vH, vTau, vTrackZ, vU, vEdge;

float bandAt(float u, vec4 ea, vec4 eb) {
    // sub → bass → mid → high → air, from the roadside outwards
    float x = clamp(u, 0.0, 1.0) * 4.0;
    float b = mix(ea.r, ea.g, clamp(x, 0.0, 1.0));
    b = mix(b, ea.b, clamp(x - 1.0, 0.0, 1.0));
    b = mix(b, ea.a, clamp(x - 2.0, 0.0, 1.0));
    return mix(b, eb.r, clamp(x - 3.0, 0.0, 1.0));
}

void main() {
    vec3 p = position;
    float z = p.z + uSnap;
    float tau = tauAt(z);
    float row = tau / uDuration;
    // Nothing before the first note or after the last one.
    float inside = smoothstep(-0.004, 0.004, row) * smoothstep(1.004, 0.996, row);
    vec4 ea = texture2D(uEnvA, vec2(0.5, clamp(row, 0.0, 1.0)));
    vec4 eb = texture2D(uEnvB, vec2(0.5, clamp(row, 0.0, 1.0)));
    float build = palC(tau).a;

    float ax = abs(p.x);
    float road = uRoadW * (1.0 - 0.4 * build);          // a build squeezes the road
    float edge = smoothstep(road, road + 12.0, ax);
    float u = clamp((ax - road) / (${HALF_WIDTH.toFixed(1)} - road), 0.0, 1.0);
    float trackZ = tau * uU;                             // distance along the road, fixed in the world
    vec2 np = vec2(p.x * 0.03 + sign(p.x) * 9.0, trackZ * 0.026);
    float n = fbm(np);
    float ridge = 1.0 - abs(2.0 * fbm(np * 1.9 + 4.0) - 1.0);

    float mass = eb.b;                                   // slow loudness: the bulk of the land
    float band = bandAt(u, ea, eb);
    float h = uAmp * (0.1 + 1.25 * mass) * (0.2 + 0.8 * n) * (0.3 + 1.5 * u * u + 0.6 * u)
            + uAmp * 0.55 * band * band * mix(n, ridge, uRough) * (0.4 + 0.8 * u);
    // A build raises canyon walls right by the road.
    h += build * 34.0 * smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.1, 0.5, u)) * (0.6 + 0.4 * ridge);
    // The land near the camera breathes with the bass.
    h *= 1.0 + 0.12 * uSub * exp(-abs(z) * 0.02);
    h = h * edge * inside * mix(1.0, 0.45, 1.0 - uScored) + uLift * edge;

    vec3 pos = vec3(p.x, h, z);
    vPos = pos;
    vH = h / uAmp;
    vTau = tau;
    vTrackZ = trackZ;
    vU = u;
    vEdge = edge;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`;

const FRAG = /* glsl */`
#define FBM_OCTAVES 3
${GLSL_NOISE}
${GLSL_COMMON}
uniform float uRoadW, uCell, uThread, uGridGain;
uniform vec4 uRing[4];       // x = media time of a kick, y = its strength
uniform vec4 uShock;         // x = media time of the last drop, y = strength
uniform vec4 uPool;          // xz = centre (camera space), z = radius, w = strength
uniform vec3 uPoolCol;
varying vec3 vPos;
varying float vH, vTau, vTrackZ, vU, vEdge;

void main() {
    float dist = length(vPos.xz);
    float ahead = -vPos.z;
    vec4 pa = palA(vTau);
    vec4 pb = palB(vTau);
    float heat = pb.a;
    float stopped = palW(vTau).a;

    // Grid fixed to the land. Lines thin out with distance instead of aliasing.
    vec2 g = vec2(vPos.x, vTrackZ) / uCell;
    vec2 fw = fwidth(g);
    vec2 l = abs(fract(g - 0.5) - 0.5) / max(fw, vec2(1e-4));
    float line = 1.0 - min(min(l.x, l.y), 1.0);
    line *= 1.0 - smoothstep(0.3, 0.95, max(fw.x, fw.y));

    float hN = clamp(vH, 0.0, 1.6);
    vec3 lineCol = mix(pa.rgb, pb.rgb, smoothstep(0.05, 0.75, hN));
    lineCol = mix(lineCol, uPalW, smoothstep(0.8, 1.4, hN) * 0.6);
    vec3 body = mix(uDeep * 0.03, pa.rgb * 0.05, smoothstep(0.0, 1.0, hN)) * (0.5 + heat);
    float glow = (0.3 + 1.5 * heat + 0.5 * hN) * uGridGain;

    // Kicks roll out over the land as rings of light.
    float rings = 0.0;
    for (int i = 0; i < 4; i++) {
        float age = uT - uRing[i].x;
        if (age < 0.0 || age > 3.0) continue;
        float front = age * 170.0;
        float w = 5.0 + front * 0.05;
        float d = (ahead - front) / w;
        rings += exp(-d * d) * uRing[i].y * exp(-age * 1.6);
    }
    // A drop sends one shockwave in every direction.
    float sAge = uT - uShock.x;
    float shock = 0.0;
    if (sAge >= 0.0 && sAge < 4.0) {
        float d = (dist - sAge * 230.0) / (9.0 + sAge * 26.0);
        shock = exp(-d * d) * uShock.y * exp(-sAge * 0.9);
    }

    vec3 col = body + lineCol * line * glow;
    col += lineCol * rings * (0.25 + 1.3 * line) * vEdge;
    col += mix(lineCol, uPalW, 0.6) * shock * (0.5 + 2.0 * line);
    // The silence before a drop: the land ahead of it is already dark.
    col *= 1.0 - 0.9 * stopped;

    // The road: dark glass with lit edges and a centre line.
    float ax = abs(vPos.x);
    float onRoad = 1.0 - vEdge;
    float kerb = exp(-pow((ax - uRoadW * 0.96) / 0.22, 2.0));
    float dash = step(0.5, fract(vTrackZ / 9.0)) * exp(-pow(ax / 0.16, 2.0));
    vec3 roadCol = mix(uPalA, uPalW, 0.3) * kerb * (0.9 + 1.2 * uKick) + uPalW * dash * 0.8;
    roadCol += lineCol * rings * 0.35;
    col = mix(col, uDeep * 0.02 + roadCol * (1.0 - 0.9 * stopped), onRoad);

    // Light pooling under the lyrics.
    vec2 pd = (vPos.xz - uPool.xy) / max(uPool.z, 0.001);
    col += uPoolCol * uPool.w * exp(-dot(pd, pd)) * (0.25 + 0.75 * line);

    col = applyFog(col * uDim, dist);
    // The thread: one line down the middle of the road that outlives every blackout.
    col += uPalW * uThread * exp(-pow(ax / (0.05 + ahead * 0.004), 2.0)) * 2.2 * exp(-ahead * 0.004);
    gl_FragColor = vec4(col, 1.0);
}`;

export class Terrain {
    constructor(globals) {
        this.uniforms = {
            ...globals,
            uSnap: { value: 0 },
            uRoadW: { value: 9 },
            uAmp: { value: 30 },
            uRough: { value: 0.4 },
            uLift: { value: 0 },
            uCell: { value: 4 },
            uGridGain: { value: 1 },
            uThread: { value: 0 },
            uRing: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
            uShock: { value: new THREE.Vector4(-1e3, 0, 0, 0) },
            uPool: { value: new THREE.Vector4(0, 0, 1, 0) },
            uPoolCol: { value: new THREE.Vector3() },
        };
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
        this.mesh.frustumCulled = false;
        this.tier = -1;
        this.rowLength = 1;
        this.setQuality(0);
    }

    setQuality(tier) {
        if (tier === this.tier) return;
        this.tier = tier;
        const [nx, nz] = SEGMENTS[tier] || SEGMENTS[2];
        const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
        const dz = (FAR + BEHIND) / nz;
        let o = 0;
        for (let j = 0; j <= nz; j++) {
            for (let i = 0; i <= nx; i++) {
                // Denser by the road, where the camera is.
                const s = (i / nx) * 2 - 1;
                pos[o++] = Math.sign(s) * Math.pow(Math.abs(s), 1.4) * HALF_WIDTH;
                pos[o++] = 0;
                pos[o++] = BEHIND - j * dz;
            }
        }
        const idx = new Uint32Array(nx * nz * 6);
        o = 0;
        for (let j = 0; j < nz; j++) {
            for (let i = 0; i < nx; i++) {
                const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
                idx[o++] = a; idx[o++] = c; idx[o++] = b;
                idx[o++] = b; idx[o++] = c; idx[o++] = d;
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        this.mesh.geometry.dispose();
        this.mesh.geometry = geo;
        this.rowLength = dz;
    }

    /** @param {number} travelled units of road behind the camera (t · U) */
    scroll(travelled) {
        const dz = this.rowLength;
        this.uniforms.uSnap.value = ((travelled % dz) + dz) % dz;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
