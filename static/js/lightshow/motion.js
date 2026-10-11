/**
 * Beat-locked motion helpers shared by every environment.
 *
 * They are pure functions of the fractional beat number, so anything built
 * on them is locked to the music by construction and a seek lands on the
 * same picture as uninterrupted playback.
 */
import { smooth } from './palette.js';

/** Snap-and-hold motion: move during the first ~45% of each beat, then hold. */
export const stepEase = (b) => {
    const i = Math.floor(b);
    return i + smooth(Math.min(1, (b - i) * 2.2));
};

/** ±1 alternating on every beat, with an eased swing between. */
export const altBeat = (b) => Math.cos(Math.PI * stepEase(b));

/** Deterministic 0..1 noise for an integer-ish seed. */
export const hash = (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
};
