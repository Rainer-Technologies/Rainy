/**
 * Rainy Light Show SDK — what an environment package may import.
 *
 * Packages reach this file as `@rainy/lightshow` (see the import map in
 * index.html); it is the only module of Rainy's they import. Everything
 * else an environment needs comes in through `mount(ctx)` and the show
 * state `S` it is given every frame (docs/ENVIRONMENTS.md).
 *
 * This is a public contract: names are only ever added within one
 * API_VERSION, never removed or changed.
 */

/** The version of the environment contract this Rainy speaks (a package's manifest names the one it was written for). */
export const API_VERSION = 1;

// Maths and colour. Colours are [r, g, b] in 0..255.
export { TAU, clamp, lerp, smooth, hsl, mixHue, rgba, mixRgb, toWhite, paletteFor } from './palette.js';
// Motion locked to the beat.
export { stepEase, altBeat, hash } from './motion.js';
// Looking things up in a score's sorted time arrays.
export { floorIndex } from './score.js';
// What is sung when: the timings every environment shares, and how a line hands over to the next.
export { LEAD, HOLD_MAX, REST_AFTER, HELD, pickTransition } from './lyricsTimeline.js';
// The conductor's limits.
export { MIN_FLASH_GAP, PHRASE_BARS } from './conductor.js';
