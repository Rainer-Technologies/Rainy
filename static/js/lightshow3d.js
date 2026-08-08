/**
 * Rainy Light Show — "Nebula" 3D renderer.
 *
 * A fully three-dimensional concert universe rendered with Three.js (WebGL).
 * This module is ONLY a renderer: the LightShowEngine brain (lightshow.js)
 * still owns audio analysis, onset detection, the beat grid, section
 * choreography, head movements and color scenes. Every frame it hands its
 * state to NebulaRenderer.render(engine, now, dt), which translates that
 * choreography into a 3D stage:
 *
 *  - 6 floor + 4 truss moving-head fixtures with volumetric shader beams,
 *    lens flares and floor pools, aimed by the brain's beat-quantized angles
 *  - A morphing, kick-displaced energy orb at stage center (the sun)
 *  - A pulsing TRON-style floor grid that breathes with the beat
 *  - GPU haze (600 shader-animated particles), a twinkling star shell and a
 *    slowly rotating nebula sky dome
 *  - A crowd of 350 light sticks waving on the beat in front of the stage
 *  - A laser fan behind the stage that wakes up in build/drop sections
 *  - Expanding impact rings on drop kicks, white strobe flash passes
 *  - A cinematic camera director: slow crane shots for calm sections, low
 *    aggressive orbits with kick-punch FOV and shake for drops
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
        float axial = pow(1.0 - vUv.y, 1.7);                 // fade along length
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
        vPos = position.xy; // circle is rotated -90°, so local xy = stage plane
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FLOOR_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uBeat;   // beat phase 0..1
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
        // slow nebula band swirling around the horizon
        float band = sin(vDir.x * 2.4 + uTime * 0.05) * sin(vDir.y * 4.0 - uTime * 0.03) * sin(vDir.z * 3.1 + uTime * 0.04);
        band = pow(max(band, 0.0), 2.0);
        vec3 col = base + uAccent * band * 0.10 * (1.0 - up * 0.5);
        gl_FragColor = vec4(col, 1.0);
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
    uniform float uBeat;    // beat float (continuous)
    uniform float uEnergy;
    uniform float uPixelRatio;
    attribute float seed;
    varying float vSeed;
    void main() {
        vSeed = seed;
        vec3 p = position;
        // wave on the beat, each stick offset by its own phase
        p.y += max(0.0, sin(uBeat * 3.14159 + seed * 6.28318)) * (0.4 + uEnergy * 0.8);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.8 + seed * 2.0) * uPixelRatio * (140.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
    }
`;

const CROWD_FRAG = /* glsl */`
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform float uBeatPhase; // 0..1 within beat
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

        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        this.renderer.setClearColor(0x020209, 1);

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x03030f, 0.009);
        this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 600);

        // Cinematic camera rig state
        this._cam = {
            angle: 0.7, radius: 34, height: 17, speed: 0.035,
            shake: 0, fov: 58,
        };

        this._glowTex = makeGlowTexture();
        this._tmpColor = new THREE.Color();
        this._up = new THREE.Vector3(0, 1, 0);
        this._dir = new THREE.Vector3();
        this._v3 = new THREE.Vector3();

        this._buildLights();
        this._buildSky();
        this._buildFloor();
        this._buildTruss();
        this._buildFixtures();
        this._buildOrb();
        this._buildHaze();
        this._buildCrowd();
        this._buildLasers();
        this._buildRings();
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
            fog: false,
        });
        this._sky = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 20), this._skyMat);
        this._sky.renderOrder = -10;
        this.scene.add(this._sky);

        // Two counter-rotating star shells for parallax twinkle
        this._starLayers = [];
        for (const [count, radius, size, opacity] of [[900, 260, 2.2, 0.85], [500, 200, 3.0, 0.6]]) {
            const geo = new THREE.BufferGeometry();
            const pos = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                const v = new THREE.Vector3().randomDirection().multiplyScalar(radius + Math.random() * 30);
                if (v.y < -20) v.y = -v.y; // keep stars above the horizon pit
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

    _buildFloor() {
        // Occluder disc (blocks stars below the horizon line)
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
        // Shared geometry: unit cone (height 1, base at origin, apex along +Y)
        this._coneGeo = new THREE.CylinderGeometry(2.4, 0.32, 1, 18, 1, true);
        this._coneGeo.translate(0, 0.5, 0);
        this._coreGeo = new THREE.CylinderGeometry(0.9, 0.10, 1, 12, 1, true);
        this._coreGeo.translate(0, 0.5, 0);

        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.5, metalness: 0.8 });
        this._fixtures = []; // aligned with engine._allHeads() order (floor first)

        const mkLens = () => {
            const m = new THREE.Mesh(
                new THREE.CircleGeometry(0.22, 16),
                new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
            );
            m.rotation.x = -Math.PI / 2; // face +Y (beam direction)
            return m;
        };

        // 6 floor heads across the front edge of the stage
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

        // 4 top heads hanging from the truss ring
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
        geo.translate(0, 27.5, 0); // emit from group origin
        for (let i = 0; i < 12; i++) {
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
                side: THREE.DoubleSide,
            });
            const blade = new THREE.Mesh(geo, mat);
            blade.rotation.x = 0.5; // tilt up over the crowd
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

        cam.shake = Math.max(cam.shake * Math.exp(-dt / 0.18), kick * 0.55);
        const sx = Math.sin(t * 47.3) * cam.shake * 0.22;
        const sy = Math.sin(t * 53.1 + 1.7) * cam.shake * 0.18;

        const sway = Math.sin(t * 0.21) * 2.2;
        this.camera.position.set(
            Math.cos(cam.angle) * cam.radius + sway + sx,
            cam.height + Math.sin(t * 0.17 + 1) * 1.4 + sy,
            Math.sin(cam.angle) * cam.radius + Math.cos(t * 0.13) * 2.2
        );
        this._v3.set(
            this._orbPos.x + Math.sin(t * 0.4) * 1.5,
            this._orbPos.y + Math.sin(t * 0.33) * 0.8,
            this._orbPos.z
        );
        this.camera.lookAt(this._v3);

        const wantFov = 56 + kick * 9 + (section === 'drop' ? 4 : 0) + norm * 2;
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

            // Aim: brain's 2D screen angle becomes an azimuth pan in 3D
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
                // Where the beam meets the floor plane (y = 0)
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

        // ---- Orb ----
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

        // ---- Impact rings (spawn when the brain emits a 2D ring) ----
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

        // ---- Strobe flash ----
        // NB: `engine.flash` is ONLY decayed inside the 2D renderer's draw
        // code (lightshow.js _render). In nebula mode that code never runs,
        // so the flash value would stick forever and the white flash quad
        // would stay on screen permanently. Decay it here exactly like the
        // 2D path does (tau 0.08) so the strobe fades out.
        this._flashMat.opacity = clamp(engine.flash * 0.5, 0, 0.55);
        engine.flash *= Math.exp(-dt / 0.08);
        if (engine.flash < 0.005) engine.flash = 0;
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
        this.renderer.dispose();
    }
}
