/**
 * Voyage camera: how the song is flown.
 *
 * A rig is a pure function of the musical frame, like a classic scene: it
 * says where the camera is, what it looks at, how far it banks and how wide
 * it sees. The cinematographer picks a rig per section × genre, moves on to
 * an alternate every 8-bar phrase and blends between them, so the flight has
 * shots, and a seek lands on the same one.
 *
 * Space: the road runs down -Z through the origin, Y is up. The camera stays
 * near the origin (the world scrolls), so a pose is an offset from "on the
 * road, here and now".
 */
import { TAU, clamp, lerp, smooth, altBeat } from '@rainy/lightshow';

const pose = (x, y, z, lx, ly, lz, roll, fov) => ({ x, y, z, lx, ly, lz, roll, fov });

/** Over the centre line, eyes on the horizon. */
function cruise(F, o) {
    const sway = Math.sin(TAU * F.bar / 4);
    return pose(1.8 * sway, 3.6 - 1.6 * o.low, 0, 0.5 * sway, 13 - 3 * o.low, -90, -0.04 * sway, 62);
}

/** Weaving from kerb to kerb, banking into each turn. */
function bank(F, o) {
    const a = TAU * F.bar / 2 * (o.variant % 2 ? -1 : 1);
    const x = Math.sin(a), v = Math.cos(a);
    return pose(4.4 * x, 3.2 - 1.2 * o.low + 0.5 * Math.abs(x), 0, 1.5 * x, 11, -70, -0.24 * v * o.fly, 64);
}

/** High above the valley, looking down its length. */
function crane(F, o) {
    const drift = Math.sin(TAU * F.bar / 8);
    return pose(6 * drift, 19 + 3 * Math.sin(TAU * F.bar / 16), 8, -2 * drift, 3, -110, -0.03 * drift, 58);
}

/** Off to one side, the sun and the far wall of the valley in frame. */
function sidecar(F, o) {
    const dir = o.variant % 2 ? -1 : 1;
    const drift = Math.sin(TAU * F.bar / 8);
    return pose(dir * (7.2 + 0.6 * drift), 5.2 + 0.8 * drift, 0, -dir * 5, 22, -160, dir * 0.07, 56);
}

/** A build: down to the road and faster, eyes locked on the vanishing point. */
function dive(F, o) {
    const p = clamp(F.buildProgress, 0, 1);
    const shake = p * p * 0.12 * o.fly;
    return pose(shake * Math.sin(F.t * 41), lerp(8, 1.5, smooth(p)) + shake * Math.sin(F.t * 53), 0,
        0, lerp(12, 7, p), -120, shake * 0.2 * Math.sin(F.t * 29), lerp(60, 82, p * p));
}

/** A drop: low and wide, swinging on every beat, punched by every kick. */
function punch(F, o) {
    const s = altBeat(F.beat) * (o.variant % 2 ? -1 : 1);
    return pose(3.2 * s * o.fly, 2.3 - 0.7 * o.low, 0, 0.8 * s, 12, -80, -0.11 * s * o.fly, 76);
}

/** A breakdown: drifting up off the road, looking at the sky. */
function float(F, o) {
    const slow = F.t * 0.16;
    return pose(5 * Math.sin(slow), 15 + 4 * Math.sin(slow * 0.7), 6, 2 * Math.sin(slow * 0.6), 30, -150, 0.05 * Math.sin(slow * 0.9), 54);
}

/** An intro: rising from the road as the land comes into view. */
function reveal(F, o) {
    const p = smooth(clamp(F.sectionProgress, 0, 1));
    return pose(0, lerp(1.3, 5, p), 0, 0, lerp(5, 14, p), -100, 0, lerp(50, 62, p));
}

export const RIGS = { cruise, bank, crane, sidecar, dive, punch, float, reveal };

const TABLE = {
    intro:     ['reveal'],
    verse:     ['cruise', 'bank', 'sidecar', 'crane'],
    build:     ['dive'],
    chorus:    ['bank', 'crane', 'punch'],
    drop:      ['punch', 'bank', 'punch', 'crane'],
    breakdown: ['float', 'sidecar'],
    outro:     ['crane', 'float'],
};
// Calm skins keep to the gentle shots.
const GENTLE = { punch: 'cruise', bank: 'cruise', dive: 'cruise' };

function pickRig(label, phrase, variant, o) {
    const list = TABLE[label] || TABLE.verse;
    // Vary the opening shot from one section to the next instead of always starting on the first.
    let name = list[(phrase + (label === 'verse' || label === 'chorus' ? variant : 0)) % list.length];
    if (o.fly < 0.75 && GENTLE[name]) name = GENTLE[name];
    return name;
}

const mixPose = (a, b, k) => {
    const out = {};
    for (const key in a) out[key] = lerp(b[key], a[key], k);
    return out;
};

export class Cinematographer {
    constructor() {
        this.reset();
    }

    reset() {
        this.key = '';
        this.cur = null;      // { name, variant }
        this.prev = null;
        this.mixStart = 0;
        this.mixDur = 0;
    }

    /**
     * The camera's pose for this frame.
     * @param {object} S   show state
     * @param {object} o   { fly, low } from the skin, `still` for reduced motion, `dropAge` seconds since the last drop
     * @returns {{x,y,z,lx,ly,lz,roll,fov}}
     */
    update(S, o) {
        const F = S.F;
        const sec = F.section || { label: 'verse', idx: 0 };
        const name = pickRig(sec.label, S.phrase, sec.idx, o);
        const key = `${name}:${sec.idx}:${S.phrase}`;
        if (key !== this.key) {
            const sectionChanged = !this.cur || this.key.split(':')[1] !== String(sec.idx);
            this.prev = this.cur;
            this.cur = { name, variant: sec.idx + S.phrase };
            this.key = key;
            this.mixStart = F.t;
            if (F.jumped || !this.prev) this.mixDur = 0;
            else if (sec.label === 'drop' && sectionChanged) this.mixDur = 0.18;
            else this.mixDur = (sectionChanged ? 2 : 4) * (F.period || 0.5);
        }
        let mix = this.mixDur > 0 ? clamp((F.t - this.mixStart) / this.mixDur, 0, 1) : 1;
        if (F.t < this.mixStart) mix = 1;
        const opts = { fly: o.fly, low: o.low };
        let p = RIGS[this.cur.name](F, { ...opts, variant: this.cur.variant });
        if (mix < 1 && this.prev) p = mixPose(p, RIGS[this.prev.name](F, { ...opts, variant: this.prev.variant }), smooth(mix));
        else this.prev = null;

        if (o.still) {
            // Reduced motion: no banking, no punches, a steady lens.
            p.roll = 0;
            p.fov = 62;
            p.x *= 0.4;
            return p;
        }
        // Every kick pushes the lens out a touch; a drop kicks it hard and shakes the frame.
        const k = S.pulse.k * S.I;
        const hit = Math.exp(-Math.max(0, o.dropAge) * 2.4) * (o.dropAge >= 0 ? 1 : 0);
        p.fov += 2.2 * k * o.fly + 13 * hit;
        p.roll += 0.02 * S.pulse.s * S.I * altBeat(F.beat) * o.fly;
        const shake = 0.35 * hit * hit + 0.02 * k;
        p.x += shake * Math.sin(F.t * 61);
        p.y += shake * Math.sin(F.t * 47);
        return p;
    }
}
