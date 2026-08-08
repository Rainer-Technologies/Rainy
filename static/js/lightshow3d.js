/**
 * Rainy Light Show — "Nebula" 3D renderer (galactic edition).
 *
 * A fully three-dimensional cosmic concert rendered with Three.js (WebGL).
 * This module is ONLY a renderer: the LightShowEngine brain (lightshow.js)
 * still owns audio analysis, onset detection, the beat grid, section
 * choreography, head movements and color scenes. Every frame it hands its
 * state to NebulaRenderer.render(engine, now, dt).
 *
 * The universe:
 *  - A rotating 9,000-star SPIRAL GALAXY hanging over the stage, flaring
 *    with the kick, spinning faster as the song heats up
 *  - A HYPERSPACE WARP FIELD around the camera: calm drift in verses, full
 *    star-rush during builds and drops
 *  - Flowing aurora curtains in the scene colors behind everything
 *  - 6 floor + 4 truss moving-head fixtures with volumetric shader beams,
 *    lens flares and floor pools, aimed by the brain's choreography
 *  - A kick-morphed energy orb with an accretion ring and an orbiting
 *    particle swarm, driving a real point light
 *  - Tumbling asteroids on slow orbits, comets streaking across the sky
 *    every few bars, fresnel shockwave shells on drop kicks
 *  - TRON floor grid pulsing with the beat, GPU haze, a crowd of light
 *    sticks, a laser fan for build/drop, strobe flash passes
 *  - A cinematic camera director: crane shots for calm sections, low orbits
 *    with kick-punch FOV + shake + roll for drops, and a dive-bomb swoop
 *    every time the drop hits
 *
 * Loaded lazily via dynamic import only when the user picks the style, so
 * three.js never hits the wire for "Original" users.
 */
import * as THREE from './vendor/three.module.js';
import { Logger } from './helper/logger.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

export function createRenderer(canvas) {
    return new NebulaRenderer(canvas);
}

// ---------------------------------------------------------------- textures

function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** Elongated horizontal streak (comet head / tail). */
function makeStreakTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 32, 256, 32);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.35)');
    g.addColorStop(0.95, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(128, 32, 128, 10, 0, 0, TAU);
    ctx.fill();
    const head = ctx.createRadialGradient(230, 32, 0, 230, 32, 26);
    head.addColorStop(0, 'rgba(255,255,255,1)');
    head.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = head;
    ctx.fillRect(0, 0, 256, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// ------------------------------------------------------------------- beams

const BEAM_VERT = /* glsl */`
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
    }
`;

const BEAM_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uIntensity;
    uniform float uHot;
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
        float axial = pow(1.0 - vUv.y, 1.7);
        float rim = pow(abs(dot(normalize(vNormal), normalize(vView))), 1.3);
        float flicker = 0.93 + 0.07 * sin(uTime * 41.0 + vUv.y * 26.0);
        float a = axial * rim * uIntensity * flicker;
        vec3 col = mix(uColor, vec3(1.0), uHot * axial * 0.7);
        gl_FragColor = vec4(col * a, a);
    }
`;

function makeBeamMaterial() {
    return new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: {
            uColor: { value: new THREE.Color(1, 1, 1) },
            uIntensity: { value: 0 },
            uHot: { value: 0 },
            uTime: { value: 0 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
}

// ------------------------------------------------------------------- floor

const FLOOR_VERT = /* glsl */`
    varying vec2 vPos;
    void main() {
        vPos = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FLOOR_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uBeat;
    uniform float uEnergy;
    varying vec2 vPos;
    void main() {
        float d = length(vPos) / 70.0;
        float ang = atan(vPos.y, vPos.x);
        float pulse = exp(-uBeat * 3.5);
        float rings = pow(0.5 + 0.5 * sin(d * 90.0 - uTime * 1.5), 10.0);
        float spokes = pow(abs(sin(ang * 14.0)), 40.0) * smoothstep(0.05, 0.25, d);
        float center = exp(-d * 9.0) * (0.5 + uEnergy);
        float fade = smoothstep(1.0, 0.25, d);
        float glow = (rings * 0.35 + spokes * 0.12) * (0.25 + pulse * 0.75) + center * 0.8;
        vec3 col = uColor * glow * fade;
        gl_FragColor = vec4(col, 1.0);
    }
`;

// --------------------------------------------------------------------- sky

const SKY_VERT = /* glsl */`
    varying vec3 vDir;
    void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
    }
`;

const SKY_FRAG = /* glsl */`
    uniform vec3 uAccent;
    uniform float uTime;
    varying vec3 vDir;
    void main() {
        float up = clamp(vDir.y, 0.0, 1.0);
        vec3 base = mix(vec3(0.012, 0.012, 0.035), vec3(0.030, 0.045, 0.11), pow(up, 0.6));
        float band = sin(vDir.x * 2.4 + uTime * 0.05) * sin(vDir.y * 4.0 - uTime * 0.03) * sin(vDir.z * 3.1 + uTime * 0.04);
        band = pow(max(band, 0.0), 2.0);
        vec3 col = base + uAccent * band * 0.10 * (1.0 - up * 0.5);
        gl_FragColor = vec4(col, 1.0);
    }
`;

// ------------------------------------------------------------------ galaxy

const GALAXY_VERT = /* glsl */`
    uniform float uTime;
    uniform float uSpin;
    uniform float uFlare;
    uniform float uPixelRatio;
    attribute float seed;
    varying float vSeed;
    varying float vRad;
    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    void main() {
        float r1 = hash(seed);
        float r2 = hash(seed + 10.0);
        float r3 = hash(seed + 20.0);
        float R = 95.0;
        float rad = pow(r1, 0.65) * R;
        float arm = floor(r2 * 3.0);
        // differential rotation: core spins faster than the rim
        float a = arm * 2.0944 + rad * 0.052 + uTime * uSpin * (26.0 / (rad + 14.0)) + (r3 - 0.5) * 0.55;
        float spread = 1.0 - rad / R;
        vec3 p = vec3(
            cos(a) * rad,
            (hash(seed + 30.0) - 0.5) * (2.5 + spread * 16.0),
            sin(a) * rad
        );
        vRad = rad / R;
        vSeed = seed;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.2 + spread * 3.5 + uFlare * spread * 5.0) * uPixelRatio * (320.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
    }
`;

const GALAXY_FRAG = /* glsl */`
    uniform vec3 uCore;
    uniform vec3 uEdge;
    uniform float uTime;
    uniform float uBright;
    varying float vSeed;
    varying float vRad;
    void main() {
        float d = length(gl_PointCoord - 0.5);
        float soft = smoothstep(0.5, 0.0, d);
        vec3 col = mix(uCore, uEdge, pow(vRad, 0.7));
        float tw = 0.75 + 0.25 * sin(uTime * (0.5 + fract(vSeed * 7.0)) + vSeed * 90.0);
        float a = soft * tw * uBright * (1.0 - vRad * 0.5);
        gl_FragColor = vec4(col * a, a);
    }
`;

// -------------------------------------------------------------------- warp

const WARP_VERT = /* glsl */`
    uniform float uTime;
    uniform float uSpeed;
    uniform float uPixelRatio;
    attribute float seed;
    varying float vNear;
    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    void main() {
        float r1 = hash(seed);
        float r2 = hash(seed + 7.0);
        float r3 = hash(seed + 13.0);
        float depth = 240.0;
        float z = -(mod(r1 * depth + uTime * uSpeed, depth)) - 2.0;
        float angle = r2 * 6.28318;
        float rad = 5.0 + r3 * 75.0;
        vec3 p = vec3(cos(angle) * rad, sin(angle) * rad * 0.62, z);
        float near = 1.0 + z / depth; // 0 far, 1 close
        vNear = near;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (0.8 + near * near * (2.0 + uSpeed * 0.35)) * uPixelRatio * (170.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
    }
`;

const WARP_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uAlpha;
    varying float vNear;
    void main() {
        float d = length(gl_PointCoord - 0.5);
        float soft = smoothstep(0.5, 0.0, d);
        float a = soft * vNear * uAlpha;
        gl_FragColor = vec4(uColor * a, a);
    }
`;

// ------------------------------------------------------------------ aurora

const AURORA_VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const AURORA_FRAG = /* glsl */`
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform float uTime;
    uniform float uGlow;
    varying vec2 vUv;
    void main() {
        vec2 q = vUv * vec2(5.0, 2.0);
        float n = sin(q.x + uTime * 0.11);
        n += 0.5 * sin(q.x * 2.3 - uTime * 0.07 + n * 1.7);
        n += 0.25 * sin(q.x * 4.1 + uTime * 0.13 + q.y * 3.0);
        float curtain = pow(sin(vUv.y * 3.14159), 2.0);
        float bands = 0.5 + 0.5 * sin(vUv.y * 9.0 + n * 2.5 + uTime * 0.05);
        vec3 col = mix(uColorA, uColorB, clamp(vUv.x + n * 0.25, 0.0, 1.0));
        float a = curtain * (0.35 + 0.65 * bands) * (0.05 + uGlow * 0.13);
        gl_FragColor = vec4(col * a, a);
    }
`;

// --------------------------------------------------------------------- orb

const ORB_VERT = /* glsl */`
    uniform float uTime;
    uniform float uAmp;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
        vec3 p = position;
        float n = sin(p.x * 2.1 + uTime * 1.7) * sin(p.y * 2.7 + uTime * 1.3) * sin(p.z * 3.3 + uTime * 0.9);
        p += normal * n * uAmp;
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
    }
`;

const ORB_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uHot;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
        float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 1.6);
        vec3 col = mix(uColor, vec3(1.0), uHot * 0.6);
        col = col * 0.45 + col * fresnel * 1.6 + vec3(1.0) * fresnel * 0.25;
        gl_FragColor = vec4(col, 1.0);
    }
`;

const ORBRING_VERT = /* glsl */`
    varying vec2 vPos;
    void main() {
        vPos = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const ORBRING_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uEnergy;
    uniform float uKick;
    varying vec2 vPos;
    void main() {
        float r = length(vPos);
        float ang = atan(vPos.y, vPos.x);
        // radial band mask between inner 3.2 and outer 5.4
        float band = smoothstep(3.2, 3.8, r) * smoothstep(5.4, 4.6, r);
        float streaks = 0.55 + 0.45 * sin(ang * 7.0 + r * 3.0 - uTime * (1.5 + uEnergy * 3.0));
        float a = band * streaks * (0.35 + uEnergy * 0.3 + uKick * 0.5);
        vec3 col = mix(uColor, vec3(1.0), uKick * 0.4 + streaks * 0.15);
        gl_FragColor = vec4(col * a, a);
    }
`;

const SWARM_VERT = /* glsl */`
    uniform float uTime;
    uniform float uEnergy;
    uniform float uKick;
    uniform float uPixelRatio;
    attribute float seed;
    varying float vSeed;
    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    void main() {
        float r1 = hash(seed);
        float r2 = hash(seed + 5.0);
        float r3 = hash(seed + 11.0);
        float rad = 3.2 + r1 * 4.5 + uKick * 1.6;
        // Kepler-ish: inner particles orbit faster
        float a = r2 * 6.28318 + uTime * (0.4 + uEnergy * 0.9) * (5.5 / rad);
        vec3 p = vec3(cos(a) * rad, (r3 - 0.5) * 1.6, sin(a) * rad);
        vSeed = seed;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.0 + r3 * 2.0) * uPixelRatio * (130.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
    }
`;

const SWARM_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uTime;
    varying float vSeed;
    void main() {
        float d = length(gl_PointCoord - 0.5);
        float soft = smoothstep(0.5, 0.0, d);
        float tw = 0.6 + 0.4 * sin(uTime * 2.0 + vSeed * 80.0);
        float a = soft * tw * 0.7;
        gl_FragColor = vec4(uColor * a, a);
    }
`;

// ------------------------------------------------------- shockwave shells

const SHELL_VERT = /* glsl */`
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
    }
`;

const SHELL_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uAlpha;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
        float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.5);
        float a = fresnel * uAlpha;
        gl_FragColor = vec4(uColor * a, a);
    }
`;

// -------------------------------------------------------------------- haze

const HAZE_VERT = /* glsl */`
    uniform float uTime;
    uniform float uPixelRatio;
    attribute float seed;
    varying float vSeed;
    void main() {
        vSeed = seed;
        vec3 p = position;
        p.y = mod(p.y + uTime * (0.25 + seed * 0.6), 20.0);
        p.x += sin(uTime * 0.3 + seed * 40.0) * 1.5;
        p.z += cos(uTime * 0.23 + seed * 31.0) * 1.5;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.5 + seed * 3.5) * uPixelRatio * (120.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
    }
`;

const HAZE_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uGlow;
    varying float vSeed;
    void main() {
        float d = length(gl_PointCoord - 0.5);
        float soft = smoothstep(0.5, 0.0, d);
        float tw = 0.5 + 0.5 * sin(uTime * (0.6 + vSeed) + vSeed * 50.0);
        float a = soft * (0.04 + 0.10 * tw + uGlow * 0.15);
        gl_FragColor = vec4(uColor * a, a);
    }
`;

// ------------------------------------------------------------------- crowd

const CROWD_VERT = /* glsl */`
    uniform float uTime;
    uniform float uBeat;
    uniform float uEnergy;
    uniform float uPixelRatio;
    attribute float seed;
    varying float vSeed;
    void main() {
        vSeed = seed;
        vec3 p = position;
        p.y += max(0.0, sin(uBeat * 3.14159 + seed * 6.28318)) * (0.4 + uEnergy * 0.8);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.8 + seed * 2.0) * uPixelRatio * (140.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
    }
`;

const CROWD_FRAG = /* glsl */`
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform float uBeatPhase;
    varying float vSeed;
    void main() {
        float d = length(gl_PointCoord - 0.5);
        float soft = smoothstep(0.5, 0.0, d);
        vec3 col = mix(uColorA, uColorB, vSeed);
        float pulse = exp(-uBeatPhase * 3.0);
        float a = soft * (0.25 + pulse * 0.55);
        gl_FragColor = vec4(col * a, a);
    }
`;

// ============================================================== renderer ==

class NebulaRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this._t = 0;
        this._ringCount = 0;
        this._laserLevel = 0;
        this._dropLevel = 0;
        this._dive = 0;
        this._roll = 0;
        this._prevSection = 'intro';
        this._lastCometBeat = -999;

        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        this.renderer.setClearColor(0x020209, 1);

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x03030f, 0.009);
        this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 900);

        this._cam = {
            angle: 0.7, radius: 34, height: 17, speed: 0.035,
            shake: 0, fov: 58,
        };

        this._glowTex = makeGlowTexture();
        this._streakTex = makeStreakTexture();
        this._tmpColor = new THREE.Color();
        this._up = new THREE.Vector3(0, 1, 0);
        this._dir = new THREE.Vector3();
        this._v3 = new THREE.Vector3();
        this._v3b = new THREE.Vector3();

        this._buildLights();
        this._buildSky();
        this._buildAurora();
        this._buildGalaxy();
        this._buildWarp();
        this._buildFloor();
        this._buildTruss();
        this._buildFixtures();
        this._buildOrb();
        this._buildAsteroids();
        this._buildHaze();
        this._buildCrowd();
        this._buildLasers();
        this._buildRings();
        this._buildShells();
        this._buildComets();
        this._buildFlash();

        this._w = 0;
        this._h = 0;
        this.resize();
    }

    // ------------------------------------------------------------ builders

    _buildLights() {
        this._ambient = new THREE.AmbientLight(0x334466, 0.5);
        this.scene.add(this._ambient);
        this._hemi = new THREE.HemisphereLight(0x445588, 0x080810, 0.4);
        this.scene.add(this._hemi);
    }

    _buildSky() {
        this._skyMat = new THREE.ShaderMaterial({
            vertexShader: SKY_VERT,
            fragmentShader: SKY_FRAG,
            uniforms: {
                uAccent: { value: new THREE.Color(0.2, 0.3, 0.6) },
                uTime: { value: 0 },
            },
            side: THREE.BackSide,
            depthWrite: false,
        });
        this._sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 20), this._skyMat);
        this._sky.renderOrder = -10;
        this.scene.add(this._sky);

        this._starLayers = [];
        for (const [count, radius, size, opacity] of [[900, 300, 2.2, 0.85], [500, 240, 3.0, 0.6]]) {
            const geo = new THREE.BufferGeometry();
            const pos = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                const v = new THREE.Vector3().randomDirection().multiplyScalar(radius + Math.random() * 40);
                if (v.y < -20) v.y = -v.y;
                pos.set([v.x, v.y, v.z], i * 3);
            }
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            const mat = new THREE.PointsMaterial({
                color: 0xcdd8ff, size, sizeAttenuation: false,
                transparent: true, opacity,
                blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
            });
            const pts = new THREE.Points(geo, mat);
            this.scene.add(pts);
            this._starLayers.push(pts);
        }
    }

    _buildAurora() {
        this._auroraMats = [];
        const geo = new THREE.PlaneGeometry(420, 130);
        for (const [z, y, ry] of [[-180, 70, 0], [-120, 90, 0.6]]) {
            const mat = new THREE.ShaderMaterial({
                vertexShader: AURORA_VERT,
                fragmentShader: AURORA_FRAG,
                uniforms: {
                    uColorA: { value: new THREE.Color(0.3, 0.5, 1.0) },
                    uColorB: { value: new THREE.Color(0.7, 0.3, 0.9) },
                    uTime: { value: 0 },
                    uGlow: { value: 0.5 },
                },
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(0, y, z);
            mesh.rotation.y = ry;
            mesh.renderOrder = -9;
            this.scene.add(mesh);
            this._auroraMats.push(mat);
        }
    }

    _buildGalaxy() {
        const count = 9000;
        const geo = new THREE.BufferGeometry();
        // positions are fully shader-computed; only a seed attribute is needed
        const pos = new Float32Array(count * 3);
        const seed = new Float32Array(count);
        for (let i = 0; i < count; i++) seed[i] = (i + 1) * 1.6180339887;
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
        this._galaxyMat = new THREE.ShaderMaterial({
            vertexShader: GALAXY_VERT,
            fragmentShader: GALAXY_FRAG,
            uniforms: {
                uTime: { value: 0 },
                uSpin: { value: 0.15 },
                uFlare: { value: 0 },
                uBright: { value: 0.6 },
                uCore: { value: new THREE.Color(1.0, 0.9, 0.75) },
                uEdge: { value: new THREE.Color(0.4, 0.55, 1.0) },
                uPixelRatio: { value: this.renderer.getPixelRatio() },
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        this._galaxy = new THREE.Points(geo, this._galaxyMat);
        this._galaxy.frustumCulled = false;
        this._galaxy.position.set(-18, 82, -150);
        this._galaxy.rotation.x = -0.55;
        this._galaxy.rotation.z = 0.35;
        this._galaxy.renderOrder = -8;
        this.scene.add(this._galaxy);
    }

    _buildWarp() {
        const count = 1400;
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(count * 3);
        const seed = new Float32Array(count);
        for (let i = 0; i < count; i++) seed[i] = (i + 1) * 2.399963;
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
        this._warpMat = new THREE.ShaderMaterial({
            vertexShader: WARP_VERT,
            fragmentShader: WARP_FRAG,
            uniforms: {
                uTime: { value: 0 },
                uSpeed: { value: 3 },
                uAlpha: { value: 0.4 },
                uColor: { value: new THREE.Color(0.75, 0.85, 1.0) },
                uPixelRatio: { value: this.renderer.getPixelRatio() },
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        this._warp = new THREE.Points(geo, this._warpMat);
        this._warp.frustumCulled = false;
        this._warp.renderOrder = 50;
        // Camera-space: the rush always streams toward the viewer
        this.camera.add(this._warp);
    }

    _buildFloor() {
        const base = new THREE.Mesh(
            new THREE.CircleGeometry(70, 48),
            new THREE.MeshBasicMaterial({ color: 0x04040c })
        );
        base.rotation.x = -Math.PI / 2;
        base.position.y = -0.02;
        this.scene.add(base);

        this._floorMat = new THREE.ShaderMaterial({
            vertexShader: FLOOR_VERT,
            fragmentShader: FLOOR_FRAG,
            uniforms: {
                uColor: { value: new THREE.Color(0.3, 0.5, 1.0) },
                uTime: { value: 0 },
                uBeat: { value: 0 },
                uEnergy: { value: 0 },
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const grid = new THREE.Mesh(new THREE.CircleGeometry(70, 64), this._floorMat);
        grid.rotation.x = -Math.PI / 2;
        this.scene.add(grid);
    }

    _buildTruss() {
        this._trussMat = new THREE.MeshStandardMaterial({
            color: 0x1a1e28, roughness: 0.55, metalness: 0.85,
            emissive: 0x000000,
        });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(14, 0.22, 10, 48), this._trussMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 15.5;
        this.scene.add(ring);
        for (const rot of [0, Math.PI / 2]) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(28.5, 0.35, 0.35), this._trussMat);
            bar.position.y = 15.5;
            bar.rotation.y = rot;
            this.scene.add(bar);
        }
    }

    _buildFixtures() {
        this._coneGeo = new THREE.CylinderGeometry(2.4, 0.32, 1, 18, 1, true);
        this._coneGeo.translate(0, 0.5, 0);
        this._coreGeo = new THREE.CylinderGeometry(0.9, 0.10, 1, 12, 1, true);
        this._coreGeo.translate(0, 0.5, 0);

        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.5, metalness: 0.8 });
        this._fixtures = [];

        const mkLens = () => {
            const m = new THREE.Mesh(
                new THREE.CircleGeometry(0.22, 16),
                new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
            );
            m.rotation.x = -Math.PI / 2;
            return m;
        };

        for (let i = 0; i < 6; i++) {
            const baseX = (i + 0.75) / 6.5;
            const group = new THREE.Group();
            group.position.set((baseX - 0.5) * 24, 0, 6.5);

            const baseMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.3, 12), bodyMat);
            baseMesh.position.y = 0.15;
            group.add(baseMesh);
            const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.5), bodyMat);
            headMesh.position.y = 0.75;
            group.add(headMesh);

            const pivot = new THREE.Group();
            pivot.position.y = 0.85;
            pivot.add(mkLens());
            group.add(pivot);

            this.scene.add(group);
            this._fixtures.push(this._makeFixtureState(group, pivot, 'floor', i));
        }

        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * TAU + Math.PI / 4;
            const group = new THREE.Group();
            group.position.set(Math.cos(a) * 14, 15.5, Math.sin(a) * 14);

            const mount = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 0.3), bodyMat);
            mount.position.y = -0.4;
            group.add(mount);
            const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.5), bodyMat);
            headMesh.position.y = -1.0;
            group.add(headMesh);

            const pivot = new THREE.Group();
            pivot.position.y = -1.1;
            pivot.add(mkLens());
            group.add(pivot);

            this.scene.add(group);
            this._fixtures.push(this._makeFixtureState(group, pivot, 'top', i));
        }
    }

    _makeFixtureState(group, pivot, side, i) {
        const beamMat = makeBeamMaterial();
        const coreMat = makeBeamMaterial();
        const beam = new THREE.Mesh(this._coneGeo, beamMat);
        const core = new THREE.Mesh(this._coreGeo, coreMat);
        beam.visible = core.visible = false;
        pivot.add(beam, core);

        const lensSprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this._glowTex, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        pivot.add(lensSprite);

        let pool = null;
        if (side === 'top') {
            pool = new THREE.Sprite(new THREE.SpriteMaterial({
                map: this._glowTex, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
            }));
            this.scene.add(pool);
        }
        return { group, pivot, beam, core, beamMat, coreMat, lensSprite, pool, side, i };
    }

    _buildOrb() {
        this._orbPos = new THREE.Vector3(0, 5.5, -6);
        this._orbMat = new THREE.ShaderMaterial({
            vertexShader: ORB_VERT,
            fragmentShader: ORB_FRAG,
            uniforms: {
                uTime: { value: 0 },
                uAmp: { value: 0.3 },
                uColor: { value: new THREE.Color(1, 0.4, 0.5) },
                uHot: { value: 0 },
            },
        });
        this._orb = new THREE.Mesh(new THREE.IcosahedronGeometry(2.3, 5), this._orbMat);
        this._orb.position.copy(this._orbPos);
        this.scene.add(this._orb);

        this._orbLight = new THREE.PointLight(0xffffff, 40, 90, 1.8);
        this._orbLight.position.copy(this._orbPos);
        this.scene.add(this._orbLight);

        this._orbGlow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this._glowTex, transparent: true, opacity: 0.5,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this._orbGlow.position.copy(this._orbPos);
        this.scene.add(this._orbGlow);

        // Accretion ring (tilted disc with rotating streaks)
        this._orbRingMat = new THREE.ShaderMaterial({
            vertexShader: ORBRING_VERT,
            fragmentShader: ORBRING_FRAG,
            uniforms: {
                uColor: { value: new THREE.Color(1, 0.5, 0.6) },
                uTime: { value: 0 },
                uEnergy: { value: 0.5 },
                uKick: { value: 0 },
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        this._orbRing = new THREE.Mesh(new THREE.RingGeometry(3.0, 5.6, 72, 1), this._orbRingMat);
        this._orbRing.position.copy(this._orbPos);
        this._orbRing.rotation.x = -1.15;
        this._orbRing.rotation.y = 0.25;
        this.scene.add(this._orbRing);

        // Orbiting particle swarm
        const count = 500;
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(count * 3);
        const seed = new Float32Array(count);
        for (let i = 0; i < count; i++) seed[i] = (i + 1) * 3.70123;
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
        this._swarmMat = new THREE.ShaderMaterial({
            vertexShader: SWARM_VERT,
            fragmentShader: SWARM_FRAG,
            uniforms: {
                uTime: { value: 0 },
                uEnergy: { value: 0.5 },
                uKick: { value: 0 },
                uColor: { value: new THREE.Color(1, 0.6, 0.7) },
                uPixelRatio: { value: this.renderer.getPixelRatio() },
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        this._swarm = new THREE.Points(geo, this._swarmMat);
        this._swarm.frustumCulled = false;
        this._swarm.position.copy(this._orbPos);
        this._swarm.rotation.z = 0.5;
        this._swarm.rotation.x = 0.2;
        this.scene.add(this._swarm);
    }

    _buildAsteroids() {
        this._asteroids = [];
        const mat = new THREE.MeshStandardMaterial({
            color: 0x2b2f3c, roughness: 0.95, metalness: 0.1, flatShading: true,
        });
        for (let i = 0; i < 9; i++) {
            const size = 0.7 + Math.random() * 1.8;
            const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), mat);
            // squish for irregular rock shapes
            mesh.scale.set(1, 0.6 + Math.random() * 0.5, 0.7 + Math.random() * 0.5);
            this.scene.add(mesh);
            this._asteroids.push({
                mesh,
                radius: 34 + Math.random() * 30,
                height: 5 + Math.random() * 26,
                speed: (0.015 + Math.random() * 0.035) * (Math.random() < 0.5 ? 1 : -1),
                phase: Math.random() * TAU,
                tumble: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.6),
            });
        }
    }

    _buildHaze() {
        const count = 600;
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(count * 3);
        const seed = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const r = Math.sqrt(Math.random()) * 30;
            const a = Math.random() * TAU;
            pos.set([Math.cos(a) * r, Math.random() * 20, Math.sin(a) * r], i * 3);
            seed[i] = Math.random();
        }
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
        this._hazeMat = new THREE.ShaderMaterial({
            vertexShader: HAZE_VERT,
            fragmentShader: HAZE_FRAG,
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: new THREE.Color(0.5, 0.6, 1.0) },
                uGlow: { value: 0 },
                uPixelRatio: { value: this.renderer.getPixelRatio() },
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        this._haze = new THREE.Points(geo, this._hazeMat);
        this._haze.frustumCulled = false;
        this.scene.add(this._haze);
    }

    _buildCrowd() {
        const count = 350;
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(count * 3);
        const seed = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            pos.set([
                (Math.random() - 0.5) * 46,
                0.6 + Math.random() * 2.2,
                12 + Math.random() * 26,
            ], i * 3);
            seed[i] = Math.random();
        }
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
        this._crowdMat = new THREE.ShaderMaterial({
            vertexShader: CROWD_VERT,
            fragmentShader: CROWD_FRAG,
            uniforms: {
                uTime: { value: 0 },
                uBeat: { value: 0 },
                uBeatPhase: { value: 0 },
                uEnergy: { value: 0 },
                uColorA: { value: new THREE.Color(0.4, 0.6, 1.0) },
                uColorB: { value: new THREE.Color(1.0, 0.5, 0.7) },
                uPixelRatio: { value: this.renderer.getPixelRatio() },
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        this._crowd = new THREE.Points(geo, this._crowdMat);
        this._crowd.frustumCulled = false;
        this.scene.add(this._crowd);
    }

    _buildLasers() {
        this._laserGroup = new THREE.Group();
        this._laserGroup.position.set(0, 8.5, -10);
        this._laserMats = [];
        const geo = new THREE.PlaneGeometry(0.07, 55);
        geo.translate(0, 27.5, 0);
        for (let i = 0; i < 12; i++) {
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
                side: THREE.DoubleSide,
            });
            const blade = new THREE.Mesh(geo, mat);
            blade.rotation.x = 0.5;
            this._laserGroup.add(blade);
            this._laserMats.push(mat);
        }
        this.scene.add(this._laserGroup);
    }

    _buildRings() {
        this._ringPool = [];
        const geo = new THREE.RingGeometry(0.92, 1, 64);
        for (let i = 0; i < 6; i++) {
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.visible = false;
            this.scene.add(mesh);
            this._ringPool.push({ mesh, mat, r: 0, alpha: 0, speed: 0 });
        }
    }

    _buildShells() {
        this._shellPool = [];
        const geo = new THREE.SphereGeometry(1, 32, 20);
        for (let i = 0; i < 3; i++) {
            const mat = new THREE.ShaderMaterial({
                vertexShader: SHELL_VERT,
                fragmentShader: SHELL_FRAG,
                uniforms: {
                    uColor: { value: new THREE.Color(1, 1, 1) },
                    uAlpha: { value: 0 },
                },
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.visible = false;
            this.scene.add(mesh);
            this._shellPool.push({ mesh, mat, r: 0, alpha: 0 });
        }
    }

    _buildComets() {
        this._comets = [];
        for (let i = 0; i < 3; i++) {
            const head = new THREE.Sprite(new THREE.SpriteMaterial({
                map: this._streakTex, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
            }));
            head.scale.set(26, 6, 1);
            this.scene.add(head);
            const tail = [];
            for (let k = 0; k < 9; k++) {
                const s = new THREE.Sprite(new THREE.SpriteMaterial({
                    map: this._glowTex, transparent: true, opacity: 0,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                }));
                this.scene.add(s);
                tail.push(s);
            }
            this._comets.push({
                head, tail,
                active: false,
                pos: new THREE.Vector3(),
                vel: new THREE.Vector3(),
                life: 0,
                history: [],
            });
        }
    }

    _buildFlash() {
        this._flashMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            depthTest: false, depthWrite: false,
        });
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._flashMat);
        quad.position.z = -1;
        quad.renderOrder = 999;
        quad.frustumCulled = false;
        this.camera.add(quad);
        this.scene.add(this.camera);
    }

    // ------------------------------------------------------------- helpers

    resize() {
        const w = this.canvas.clientWidth || window.innerWidth;
        const h = this.canvas.clientHeight || window.innerHeight;
        if (w === this._w && h === this._h) return;
        this._w = w;
        this._h = h;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    _setColor(target, rgb) {
        target.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    }

    _spawnRing(color, speedFrac) {
        const slot = this._ringPool.find(r => !r.mesh.visible) || this._ringPool[0];
        slot.r = 1;
        slot.alpha = 0.85;
        slot.speed = 14 + speedFrac * 30;
        this._setColor(slot.mat.color, color);
        slot.mesh.visible = true;
        slot.mesh.position.copy(this._orbPos);
        // A shockwave shell rides along on drop kicks
        const shell = this._shellPool.find(s => !s.mesh.visible);
        if (shell) {
            shell.r = 2;
            shell.alpha = 0.8;
            this._setColor(shell.mat.uniforms.uColor.value, color);
            shell.mesh.visible = true;
            shell.mesh.position.copy(this._orbPos);
        }
    }

    _spawnComet() {
        const c = this._comets.find(c => !c.active);
        if (!c) return;
        c.active = true;
        c.life = 2.2 + Math.random() * 1.2;
        const side = Math.random() < 0.5 ? -1 : 1;
        c.pos.set(-side * (140 + Math.random() * 60), 70 + Math.random() * 60, -120 - Math.random() * 80);
        c.vel.set(side * (90 + Math.random() * 50), -12 - Math.random() * 18, 8 + Math.random() * 20);
        c.history.length = 0;
    }

    // -------------------------------------------------------------- render

    render(engine, now, dt) {
        this.resize();
        this._t += dt;
        const t = this._t;

        const kick = engine.envKick;
        const bass = engine.envBass;
        const mid = engine.envMid;
        const treble = engine.envTreble;
        const norm = engine.normEnergy;
        const beatPhase = ((engine.beatFloat % 1) + 1) % 1;
        const pulse = Math.exp(-beatPhase * 4);
        const section = engine.section;
        const c0 = engine._col(0), c1 = engine._col(1), c2 = engine._col(2);

        // Section transitions: dive-bomb the camera when the drop lands
        if (section !== this._prevSection) {
            if (section === 'drop') this._dive = 1;
            this._prevSection = section;
        }
        this._dive *= Math.exp(-dt / 0.9);
        const dropTarget = section === 'drop' ? 1 : (section === 'build' ? 0.35 : 0);
        this._dropLevel = lerp(this._dropLevel, dropTarget, 1 - Math.exp(-dt / 0.6));

        // ---- Camera director ----
        const cam = this._cam;
        const targets = {
            intro:      { r: 36, h: 19, s: 0.030 },
            breakdown:  { r: 34, h: 17, s: 0.035 },
            verse:      { r: 27, h: 11, s: 0.060 },
            build:      { r: 22, h: 8.5, s: 0.095 },
            drop:       { r: 19, h: 6.5, s: 0.140 },
        };
        const tg = targets[section] || targets.verse;
        const k = 1 - Math.exp(-dt / 1.2);
        cam.radius = lerp(cam.radius, tg.r, k);
        cam.height = lerp(cam.height, tg.h, k);
        cam.speed = lerp(cam.speed, tg.s, k);
        cam.angle += cam.speed * dt;

        cam.shake = Math.max(cam.shake * Math.exp(-dt / 0.18), kick * 0.55 + this._dive * 0.5);
        const sx = Math.sin(t * 47.3) * cam.shake * 0.22;
        const sy = Math.sin(t * 53.1 + 1.7) * cam.shake * 0.18;

        const sway = Math.sin(t * 0.21) * 2.2;
        const radius = cam.radius - this._dive * 7;
        const height = cam.height - this._dive * 4;
        this.camera.position.set(
            Math.cos(cam.angle) * radius + sway + sx,
            height + Math.sin(t * 0.17 + 1) * 1.4 + sy,
            Math.sin(cam.angle) * radius + Math.cos(t * 0.13) * 2.2
        );
        // Subtle roll during drops
        this._roll = lerp(this._roll, this._dropLevel * Math.sin(t * 0.45) * 0.09, 1 - Math.exp(-dt / 0.5));
        this.camera.up.set(Math.sin(this._roll), 1, 0).normalize();
        this._v3.set(
            this._orbPos.x + Math.sin(t * 0.4) * 1.5,
            this._orbPos.y + Math.sin(t * 0.33) * 0.8,
            this._orbPos.z
        );
        this.camera.lookAt(this._v3);
        this.camera.up.set(0, 1, 0); // keep children (warp/flash) screen-aligned

        const wantFov = 56 + kick * 9 + this._dropLevel * 5 + this._dive * 8 + norm * 2;
        cam.fov = lerp(cam.fov, wantFov, 1 - Math.exp(-dt / 0.08));
        if (Math.abs(cam.fov - this.camera.fov) > 0.01) {
            this.camera.fov = cam.fov;
            this.camera.updateProjectionMatrix();
        }

        // ---- Sky / stars ----
        this._skyMat.uniforms.uTime.value = t;
        this._setColor(this._skyMat.uniforms.uAccent.value, c1);
        this._sky.rotation.y += dt * 0.004;
        this._starLayers[0].rotation.y += dt * 0.006;
        this._starLayers[1].rotation.y -= dt * 0.004;
        this._starLayers[0].material.opacity = 0.65 + treble * 0.35 + 0.1 * Math.sin(t * 0.7);
        this._starLayers[1].material.opacity = 0.45 + treble * 0.3 + 0.1 * Math.sin(t * 0.9 + 2);

        // ---- Aurora ----
        for (let i = 0; i < this._auroraMats.length; i++) {
            const m = this._auroraMats[i];
            m.uniforms.uTime.value = t + i * 40;
            m.uniforms.uGlow.value = 0.4 + norm * 0.6 + treble * 0.4;
            this._setColor(m.uniforms.uColorA.value, i === 0 ? c1 : c2);
            this._setColor(m.uniforms.uColorB.value, i === 0 ? c2 : c0);
        }

        // ---- Galaxy ----
        this._galaxyMat.uniforms.uTime.value = t;
        this._galaxyMat.uniforms.uSpin.value = 0.12 + norm * 0.25 + this._dropLevel * 0.15;
        this._galaxyMat.uniforms.uFlare.value = kick;
        this._galaxyMat.uniforms.uBright.value = 0.55 + treble * 0.35 + norm * 0.3;
        this._setColor(this._galaxyMat.uniforms.uEdge.value, c1);
        this._galaxy.rotation.y += dt * (0.01 + norm * 0.02);

        // ---- Hyperspace warp field ----
        this._warpMat.uniforms.uTime.value = t;
        this._warpMat.uniforms.uSpeed.value = 3 + norm * 6 + this._dropLevel * 42 + this._dive * 30;
        this._warpMat.uniforms.uAlpha.value = 0.18 + norm * 0.2 + this._dropLevel * 0.55;
        this._setColor(this._warpMat.uniforms.uColor.value, [lerp(190, c2[0], 0.35) | 0, lerp(205, c2[1], 0.35) | 0, lerp(255, c2[2], 0.35) | 0]);

        // ---- Floor ----
        this._floorMat.uniforms.uTime.value = t;
        this._floorMat.uniforms.uBeat.value = beatPhase;
        this._floorMat.uniforms.uEnergy.value = norm;
        this._setColor(this._floorMat.uniforms.uColor.value, c1);

        // ---- Truss ----
        this._setColor(this._trussMat.emissive, c0);
        this._trussMat.emissiveIntensity = pulse * 0.35 + norm * 0.1;

        // ---- Fixtures + beams ----
        const heads = engine._allHeads();
        const lasersOn = !engine._prefs.disableLasers;
        for (let i = 0; i < heads.length; i++) {
            const h = heads[i];
            const f = this._fixtures[i];
            if (!f) continue;
            const inten = clamp(h.env + h.boost, 0, 1.2);
            const on = inten > 0.02 && lasersOn;

            const pan = h.angle * 1.6;
            const tiltBase = f.side === 'floor'
                ? 0.72 + 0.12 * Math.sin(t * 0.3 + f.i * 1.3)
                : 0.55 + 0.10 * Math.sin(t * 0.26 + f.i * 2.1);
            const st = Math.sin(tiltBase), ct = Math.cos(tiltBase);
            if (f.side === 'floor') {
                this._dir.set(Math.sin(pan) * st, ct, Math.cos(pan) * st);
            } else {
                this._dir.set(Math.sin(pan) * st, -ct, Math.cos(pan) * st);
            }
            f.pivot.quaternion.setFromUnitVectors(this._up, this._dir);
            f.group.rotation.y = pan;

            f.beam.visible = f.core.visible = on;
            f.beamMat.uniforms.uIntensity.value = on ? inten * 0.55 : 0;
            f.beamMat.uniforms.uTime.value = t;
            f.coreMat.uniforms.uIntensity.value = on ? inten * 0.8 : 0;
            f.coreMat.uniforms.uTime.value = t;
            f.coreMat.uniforms.uHot.value = clamp((inten - 0.35) / 0.65, 0, 1);

            const col = engine._headColor(h);
            this._setColor(f.beamMat.uniforms.uColor.value, col);
            this._setColor(f.coreMat.uniforms.uColor.value, col);
            this._setColor(f.lensSprite.material.color, col);

            const width = (0.55 + bass * 0.5) * (f.side === 'floor' ? 1 : 0.8);
            const len = f.side === 'floor'
                ? 46
                : clamp(f.group.position.y - 1.1, 6, 17) / Math.max(0.35, ct);
            f.beam.scale.set(width, len, width);
            f.core.scale.set(width, len, width);

            f.lensSprite.material.opacity = on ? clamp(inten, 0, 1) * 0.9 : 0;
            const ls = 1.1 + inten * 2.2;
            f.lensSprite.scale.set(ls, ls, 1);

            if (f.pool) {
                if (on && this._dir.y < -0.05) {
                    const hit = -f.pivot.getWorldPosition(this._v3).y / this._dir.y;
                    const px = this._v3.x + this._dir.x * hit;
                    const pz = this._v3.z + this._dir.z * hit;
                    f.pool.position.set(px, 0.15, pz);
                    const ps = (2.5 + width * 5) * (0.5 + inten * 0.7);
                    f.pool.scale.set(ps, ps, 1);
                    f.pool.material.opacity = clamp(inten * 0.5, 0, 0.75);
                    this._setColor(f.pool.material.color, col);
                } else {
                    f.pool.material.opacity = 0;
                }
            }
        }

        // ---- Orb + accretion ring + swarm ----
        this._orbMat.uniforms.uTime.value = t;
        this._orbMat.uniforms.uAmp.value = 0.22 + kick * 1.5 + bass * 0.55;
        this._orbMat.uniforms.uHot.value = clamp(kick * 1.2, 0, 1);
        this._setColor(this._orbMat.uniforms.uColor.value, c0);
        this._orb.rotation.y += dt * (0.2 + norm * 0.5);
        this._orb.rotation.x = Math.sin(t * 0.23) * 0.2;
        const orbScale = 1 + kick * 0.25 + pulse * 0.08;
        this._orb.scale.setScalar(orbScale);

        this._setColor(this._orbLight.color, c0);
        this._orbLight.intensity = 25 + kick * 140 + norm * 40 + engine.flash * 250;
        this._setColor(this._orbGlow.material.color, c0);
        const gs = 13 + kick * 9 + norm * 4;
        this._orbGlow.scale.set(gs, gs, 1);
        this._orbGlow.material.opacity = 0.35 + kick * 0.45 + norm * 0.15;

        this._orbRingMat.uniforms.uTime.value = t;
        this._orbRingMat.uniforms.uEnergy.value = norm;
        this._orbRingMat.uniforms.uKick.value = kick;
        this._setColor(this._orbRingMat.uniforms.uColor.value, c0);
        this._orbRing.rotation.z += dt * (0.3 + norm * 0.8);

        this._swarmMat.uniforms.uTime.value = t;
        this._swarmMat.uniforms.uEnergy.value = norm;
        this._swarmMat.uniforms.uKick.value = kick;
        this._setColor(this._swarmMat.uniforms.uColor.value, c0);

        // ---- Asteroids ----
        for (const a of this._asteroids) {
            const ang = a.phase + t * a.speed;
            a.mesh.position.set(
                Math.cos(ang) * a.radius,
                a.height + Math.sin(t * 0.1 + a.phase) * 2.5,
                Math.sin(ang) * a.radius
            );
            a.mesh.rotation.x += a.tumble.x * dt;
            a.mesh.rotation.y += a.tumble.y * dt;
            a.mesh.rotation.z += a.tumble.z * dt;
        }

        // ---- Haze / crowd ----
        this._hazeMat.uniforms.uTime.value = t;
        this._hazeMat.uniforms.uGlow.value = treble + norm * 0.5;
        this._setColor(this._hazeMat.uniforms.uColor.value, c2);

        this._crowdMat.uniforms.uTime.value = t;
        this._crowdMat.uniforms.uBeat.value = engine.beatFloat;
        this._crowdMat.uniforms.uBeatPhase.value = beatPhase;
        this._crowdMat.uniforms.uEnergy.value = norm;
        this._setColor(this._crowdMat.uniforms.uColorA.value, c1);
        this._setColor(this._crowdMat.uniforms.uColorB.value, c2);

        // ---- Laser fan (build / drop only) ----
        const laserTarget = lasersOn && section === 'drop' ? 1 : (lasersOn && section === 'build' ? 0.45 : 0);
        this._laserLevel = lerp(this._laserLevel, laserTarget, 1 - Math.exp(-dt / 0.4));
        if (this._laserLevel > 0.01) {
            const fan = (0.5 + 0.45 * Math.sin(t * (section === 'drop' ? 1.6 : 0.7))) * 1.1;
            this._laserGroup.rotation.y = Math.sin(t * 0.35) * 0.6;
            for (let i = 0; i < this._laserMats.length; i++) {
                const frac = i / (this._laserMats.length - 1) - 0.5;
                const blade = this._laserGroup.children[i];
                blade.rotation.z = frac * fan;
                blade.rotation.y = frac * 0.4;
                this._setColor(this._laserMats[i].color, i % 3 === 0 ? c0 : c2);
                this._laserMats[i].opacity = this._laserLevel * (0.25 + engine.envHighMid * 0.75) * 0.8;
            }
        } else {
            for (const m of this._laserMats) m.opacity = 0;
        }

        // ---- Impact rings + shockwave shells ----
        if (engine.rings.length > this._ringCount) {
            const newest = engine.rings[engine.rings.length - 1];
            this._spawnRing(newest.color, newest.speed);
        }
        this._ringCount = engine.rings.length;
        for (const r of this._ringPool) {
            if (!r.mesh.visible) continue;
            r.r += r.speed * dt;
            r.alpha *= Math.exp(-dt / 0.45);
            if (r.alpha < 0.02) { r.mesh.visible = false; continue; }
            r.mesh.scale.setScalar(r.r);
            r.mesh.quaternion.copy(this.camera.quaternion);
            r.mat.opacity = r.alpha;
        }
        for (const s of this._shellPool) {
            if (!s.mesh.visible) continue;
            s.r += (10 + s.r * 0.9) * dt;
            s.alpha *= Math.exp(-dt / 0.5);
            if (s.alpha < 0.02) { s.mesh.visible = false; continue; }
            s.mesh.scale.setScalar(s.r);
            s.mat.uniforms.uAlpha.value = s.alpha;
        }

        // ---- Comets (every 16 beats, more often in drops) ----
        const cometEvery = section === 'drop' ? 8 : 16;
        if (engine.beatIndex >= 0 && engine.beatIndex % cometEvery === 0 &&
            engine.beatIndex !== this._lastCometBeat && Math.random() < 0.65) {
            this._lastCometBeat = engine.beatIndex;
            this._spawnComet();
        }
        for (const c of this._comets) {
            if (!c.active) continue;
            c.life -= dt;
            if (c.life <= 0) {
                c.active = false;
                c.head.material.opacity = 0;
                for (const s of c.tail) s.material.opacity = 0;
                continue;
            }
            c.pos.addScaledVector(c.vel, dt);
            c.history.unshift(c.pos.clone());
            if (c.history.length > c.tail.length + 1) c.history.pop();

            c.head.position.copy(c.pos);
            const fade = clamp(c.life / 0.6, 0, 1);
            c.head.material.opacity = fade * 0.95;
            // Orient the streak along its on-screen travel direction
            this._v3.copy(c.pos).project(this.camera);
            this._v3b.copy(c.pos).addScaledVector(c.vel, 0.1).project(this.camera);
            c.head.material.rotation = Math.atan2(this._v3b.y - this._v3.y, this._v3b.x - this._v3.x);
            for (let i = 0; i < c.tail.length; i++) {
                const hp = c.history[i + 1];
                if (!hp) { c.tail[i].material.opacity = 0; continue; }
                c.tail[i].position.copy(hp);
                const sc = 5 * (1 - i / c.tail.length) + 1;
                c.tail[i].scale.set(sc, sc, 1);
                c.tail[i].material.opacity = fade * 0.5 * (1 - i / c.tail.length);
            }
        }

        // ---- Strobe flash ----
        this._flashMat.opacity = clamp(engine.flash * 0.5, 0, 0.55);
        this._ambient.intensity = 0.5 + engine.flash * 3.0 + norm * 0.2;

        this.renderer.render(this.scene, this.camera);
    }

    // -------------------------------------------------------------- cleanup

    dispose() {
        this.scene.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const m of mats) m.dispose();
            }
        });
        this._glowTex.dispose();
        this._streakTex.dispose();
        this.renderer.dispose();
    }
}
