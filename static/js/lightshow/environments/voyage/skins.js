/**
 * Voyage skins: how the same world looks for each genre profile.
 *
 * A skin is only numbers. Everything is built from the same road, land, sky
 * and rig; the skin sets how rough the land is, whether a sea floods it, what
 * the gates look like, how busy the sky gets and how hard the camera flies.
 */

/** Gate outline: number of sides (0 = a ring). */
export const SHAPE = { RING: 0, TRIANGLE: 3, SQUARE: 4, HEXAGON: 6 };

const BASE = {
    amp: 30,          // height of the land (units)
    rough: 0.4,       // 0 = rolling hills, 1 = sharp ridges
    cell: 4,          // grid cell (units)
    grid: 1,          // brightness of the grid lines
    sea: 0,           // sea level as a fraction of amp (0 = dry)
    fog: 0.0045,      // haze density
    stars: 1,
    nebula: 0.7,
    aurora: 0.6,      // how much aurora the quiet sections get
    lightning: 1,     // sheet lightning on snares in a drop
    sunStripes: 0,    // synthwave bands across the sun
    gate: SHAPE.RING,
    gateSpin: 0,      // turns per bar for the phrase arches
    beams: 1,         // how many beams the rig uses (multiplier)
    dust: 1,
    fly: 1,           // how hard the camera moves
    low: 0,           // 0..1: keep the camera down by the road
};

const SKINS = {
    edm: { rough: 0.55, cell: 3.5, grid: 1.2, nebula: 0.8, sunStripes: 1, gate: SHAPE.HEXAGON, gateSpin: 0.25, beams: 1.3, fly: 1.15 },
    pop: { rough: 0.35, nebula: 0.75, sunStripes: 0.6, gate: SHAPE.RING, beams: 1 },
    rock: { amp: 36, rough: 0.9, cell: 4.5, grid: 0.9, nebula: 0.45, stars: 0.7, aurora: 0.3, lightning: 1.6, gate: SHAPE.TRIANGLE, beams: 0.8, dust: 1.5, fly: 1.2 },
    hiphop: { amp: 26, rough: 0.5, cell: 5, grid: 1.1, nebula: 0.55, gate: SHAPE.SQUARE, beams: 0.9, fly: 0.9, low: 1 },
    latin: { rough: 0.3, nebula: 0.85, sunStripes: 0.8, sea: 0.12, gate: SHAPE.RING, gateSpin: 0.125, beams: 1.1, fly: 1.05 },
    chill: { amp: 24, rough: 0.15, cell: 5, grid: 0.7, sea: 0.3, fog: 0.0038, stars: 1.4, nebula: 0.9, aurora: 1, lightning: 0, gate: SHAPE.RING, beams: 0.5, dust: 0.7, fly: 0.6 },
    orchestral: { amp: 34, rough: 0.25, cell: 6, grid: 0.6, sea: 0.2, fog: 0.005, stars: 1.2, nebula: 1, aurora: 0.9, lightning: 0.3, gate: SHAPE.RING, beams: 0.6, dust: 0.8, fly: 0.7 },
};

/** The skin for a genre profile (pop when unknown). */
export function skinFor(genre) {
    return { ...BASE, ...(SKINS[genre] || SKINS.pop) };
}
