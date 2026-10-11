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
uniform float uSnap, uRoadW, uAmp, uRough, uSea;
varying vec3 vPos;
varying float vH, vTau, vTrackZ, vU, vEdge, vSea;

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
    float build = mix(uBuild, palC(tau).a, uScored);

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
    // No score yet: the land is plain noise that swells with what is playing now.
    mass = mix(0.3 + 0.5 * uRms, mass, uScored);
    band = mix(mix(uSub, uRms, u), band, uScored);
    float h = uAmp * (0.1 + 1.25 * mass) * (0.2 + 0.8 * n) * (0.3 + 1.5 * u * u + 0.6 * u)
            + uAmp * 0.55 * band * band * mix(n, ridge, uRough) * (0.4 + 0.8 * u);
    // A build raises canyon walls right by the road.
    h += build * 34.0 * smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.1, 0.5, u)) * (0.6 + 0.4 * ridge);
    // The land near the camera breathes with the bass.
    h *= 1.0 + 0.12 * uSub * exp(-abs(z) * 0.02);
    h = h * edge * mix(1.0, inside, uScored);
    // A sea floods the low land: what is left stands out of it as islands.
    float land = h - uSea * edge;
    vSea = uSea > 0.0 ? smoothstep(0.0, -0.6, land) * edge : 0.0;
    h = max(land, 0.0);

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
uniform vec4 uGateZ[8];      // the gates ahead: x = z (camera space), y = kind, z = power
uniform vec4 uShock;         // x = media time of the last drop, y = strength
uniform vec4 uPool;          // xz = centre (camera space), z = radius, w = strength
uniform vec3 uPoolCol;
varying vec3 vPos;
varying float vH, vTau, vTrackZ, vU, vEdge, vSea;

void main() {
    float dist = length(vPos.xz);
    float ahead = -vPos.z;
    // The colours of this stretch of the song (of right now, without a score).
    vec4 pa = mix(vec4(uPalA, 0.5), palA(vTau), uScored);
    vec4 pb = mix(vec4(uPalB, uHeat), palB(vTau), uScored);
    float heat = pb.a;
    float stopped = palW(vTau).a * uScored;

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
    // Facets catch the sky: each face of the land has its own shade.
    vec3 nrm = normalize(cross(dFdx(vPos), dFdy(vPos)));
    nrm *= sign(nrm.y);
    body += mix(pa.rgb, pb.rgb, 0.5) * (0.012 + 0.05 * heat) * pow(clamp(nrm.y, 0.0, 1.0), 2.0)
          + uHorizon * 0.05 * pow(clamp(-nrm.z, 0.0, 1.0), 3.0);
    float glow = (0.3 + 1.5 * heat + 0.5 * hN) * uGridGain;
    // Contour lines, like a map: they fill the big faces of the mountains.
    float ch = vPos.y / 3.2;
    float contour = (1.0 - min(abs(fract(ch - 0.5) - 0.5) / max(fwidth(ch), 1e-4), 1.0)) * smoothstep(0.9, 0.2, fwidth(ch));
    contour *= smoothstep(0.4, 2.0, vPos.y) * 0.3;

    // Kicks roll out over the land as rings of light.
    float rings = 0.0;
    for (int i = 0; i < 4; i++) {
        float age = uT - uRing[i].x;
        if (age < 0.0 || age > 3.0) continue;
        float front = age * 170.0;
        float w = 2.5 + front * 0.04;
        float d = (ahead - front) / w;
        rings += exp(-d * d) * uRing[i].y * exp(-age * 1.6) * smoothstep(8.0, 70.0, ahead);
    }
    // A drop sends one shockwave in every direction.
    float sAge = uT - uShock.x;
    float shock = 0.0;
    if (sAge >= 0.0 && sAge < 4.0) {
        float d = (dist - sAge * 230.0) / (9.0 + sAge * 26.0);
        shock = exp(-d * d) * uShock.y * exp(-sAge * 0.9);
    }

    vec3 col = body + lineCol * line * glow + mix(pb.rgb, pa.rgb, 0.3) * contour * glow;
    col += lineCol * rings * (0.025 + 1.6 * line + 2.0 * contour) * vEdge;
    col += mix(lineCol, uPalW, 0.6) * shock * (0.5 + 2.0 * line);

    // Water: dark glass that mirrors the horizon, with the sun's path on it.
    if (vSea > 0.001) {
        float ripple = vnoise(vec2(vPos.x * 0.22, vTrackZ * 0.5 + uNow * 0.7));
        float glint = smoothstep(0.72, 0.98, vnoise(vec2(vPos.x * 0.9, vTrackZ * 0.16 - uNow * 0.4)));
        float path = exp(-pow(vPos.x / (5.0 + ahead * 0.07), 2.0));
        vec3 water = uDeep * 0.03
                   + uHorizon * (0.05 + 0.32 * exp(-max(0.0, 260.0 - ahead) * 0.012)) * (0.7 + 0.5 * ripple)
                   + mix(uHorizon, uPalW, 0.5) * path * glint * (0.5 + 1.2 * uSub)
                   + lineCol * rings * (0.4 + 0.8 * ripple)
                   + mix(lineCol, uPalW, 0.6) * shock * 1.2;
        col = mix(col, water, vSea);
    }
    // The silence before a drop: the land ahead of it is already dark.
    col *= 1.0 - 0.9 * stopped;

    // The road: dark glass with lit edges and a centre line.
    float ax = abs(vPos.x);
    float onRoad = 1.0 - vEdge;
    float kerb = exp(-pow((ax - uRoadW * 0.96) / 0.1, 2.0));
    float dash = step(0.5, fract(vTrackZ / 9.0)) * exp(-pow(ax / 0.1, 2.0));
    vec3 roadCol = mix(uPalA, uPalW, 0.3) * kerb * (0.55 + 0.6 * uKick) + uPalW * dash * 0.45;
    roadCol += lineCol * rings * 0.22;
    // Every gate spills its light on the road, and the far road mirrors the horizon.
    float pools = 0.0;
    for (int i = 0; i < 8; i++) {
        float dz = (vPos.z - uGateZ[i].x) / (0.7 + 0.25 * uGateZ[i].y);
        pools += exp(-dz * dz) * uGateZ[i].z;
    }
    roadCol += mix(pa.rgb, uPalW, 0.25) * pools * (0.16 + 0.3 * uHeat) * (0.5 + 0.5 * smoothstep(0.0, uRoadW, ax));
    roadCol += uHorizon * 0.16 * smoothstep(30.0, 320.0, ahead);
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
            uSea: { value: 0 },
            uCell: { value: 4 },
            uGridGain: { value: 1 },
            uThread: { value: 0 },
            uRing: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
            uGateZ: { value: Array.from({ length: 8 }, () => new THREE.Vector4(1e4, 0, 0, 0)) },
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
