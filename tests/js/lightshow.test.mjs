// The light show's shared core (static/js/lightshow): the conductor, the
// lyrics timeline and the environment registry. No DOM, no audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Conductor, MIN_FLASH_GAP } from '../../static/js/lightshow/conductor.js';
import { LyricsTimeline, buildLines, pickTransition, tokenize, LEAD, REST_AFTER } from '../../static/js/lightshow/lyricsTimeline.js';
import {
    ENVIRONMENTS, DEFAULT_ENVIRONMENT, normalizeEnvironment, resolveEnvironment, nextEnvironment,
} from '../../static/js/lightshow/environments/index.js';

/** A musical frame like the sources produce, with overrides. */
function frame(over = {}) {
    return {
        t: 0,
        bands: { sub: 0, bass: 0, mid: 0, high: 0, air: 0, rms: 0.5, harm: 0 },
        hits: { k: 0, s: 0, h: 0 },
        beat: 0, bar: 0, period: 0.5, newBeat: false, newBar: false,
        section: { label: 'verse', idx: 0, key: 'C', mode: 'major' },
        sectionBar: 0, nextIn: Infinity,
        dropIn: Infinity, stopDepth: 0, stopIn: Infinity, buildProgress: 0,
        events: [], profile: { genre: 'pop', intensity: 0.6 },
        jumped: false, running: true,
        ...over,
    };
}
const PREFS = { intensity: 'auto', reduceFlashing: false };

// ------------------------------------------------------------- conductor

test('conductor: at most three full flashes per second', () => {
    const c = new Conductor();
    let full = 0;
    for (let i = 0; i < 100; i++) {
        const now = 10 + i * 0.01;       // a hit asking for a flash every 10 ms
        c.update(frame(), PREFS, now, now, 0.01);
        c.flashAmt = 0;
        c.flash(1, [255, 255, 255]);
        if (c.flashAmt > 0.12) full++;
    }
    assert.ok(full <= Math.ceil(1 / MIN_FLASH_GAP), `${full} flashes in one second`);
    assert.ok(full >= 2, 'the limiter still lets flashes through');
});

test('conductor: reduce flashing turns strobes into soft colour pulses', () => {
    const c = new Conductor();
    c.update(frame(), { ...PREFS, reduceFlashing: true }, 5, 5, 0.016);
    c.flash(1, [255, 255, 255]);
    assert.ok(c.flashAmt <= 0.2);
    assert.notDeepEqual(c.flashColor, [255, 255, 255], 'tinted with the palette');
});

test('conductor: blackouts cut the dimmer at once, pause eases it down', () => {
    const c = new Conductor();
    c.update(frame({ stopDepth: 1 }), PREFS, 1, 1, 0.016);
    assert.ok(Math.abs(c.dim - 0.04) < 1e-9);
    c.update(frame({ jumped: true }), PREFS, 2, 2, 0.016);
    assert.equal(c.dim, 1);
    for (let i = 0; i < 120; i++) c.update(frame({ running: false }), PREFS, 2, 2 + i / 60, 1 / 60);
    assert.ok(Math.abs(c.dim - 0.35) < 0.01);
});

test('conductor: counts 8-bar phrases, but never starts one in a section\'s last two bars', () => {
    const c = new Conductor();
    c.update(frame({ sectionBar: 7 }), PREFS, 0, 0, 0.016);
    assert.equal(c.phrase, 0);
    c.update(frame({ sectionBar: 8 }), PREFS, 0, 0, 0.016);
    assert.equal(c.phrase, 1);
    c.update(frame({ sectionBar: 16, nextIn: 2 }), PREFS, 0, 0, 0.016);   // 2 s left, bars are 2 s long
    assert.equal(c.phrase, 1, 'held: the section ends in under two bars');
    c.update(frame({ sectionBar: 0, section: { label: 'chorus', idx: 1 } }), PREFS, 0, 0, 0.016);
    assert.equal(c.phrase, 0);
});

test('conductor: a drop snaps the palette, other sections glide to it', () => {
    const c = new Conductor();
    c.update(frame({ jumped: true }), PREFS, 0, 0, 0.016);
    const verse = c.palette.a.slice();
    c.update(frame({ section: { label: 'chorus', idx: 1, key: 'F#', mode: 'minor' } }), PREFS, 0, 0, 0.016);
    assert.notDeepEqual(c.palette.a, c.paletteTarget.a, 'still gliding');
    assert.notDeepEqual(c.palette.a, verse, 'but moving');
    c.update(frame({ section: { label: 'drop', idx: 2, key: 'A', mode: 'minor' } }), PREFS, 0, 0, 0.016);
    assert.deepEqual(c.palette.a, c.paletteTarget.a);
});

test('conductor: hit pulses attack at once and ring out; intensity follows the setting', () => {
    const c = new Conductor();
    c.update(frame({ hits: { k: 0.9, s: 0, h: 0 } }), PREFS, 0, 0, 0.016);
    assert.equal(c.pulse.k, 0.9);
    c.update(frame(), PREFS, 0, 0.1, 0.1);
    assert.ok(c.pulse.k < 0.9 && c.pulse.k > 0.3);
    assert.ok(Math.abs(c.I - (0.35 + 0.65 * 0.6)) < 1e-9);
    c.update(frame(), { ...PREFS, intensity: 'chill' }, 0, 0.2, 0.1);
    assert.equal(c.I, 0.3);
    c.flash(0.6, [255, 255, 255]);
    c.blind(0.5);
    c.burst(1);
    c.settle(0.1);
    assert.ok(c.flashAmt < 0.6 && c.blinderAmt < 0.5 && c.burstAmt < 1);
});

// ---------------------------------------------------------------- lyrics

const SYNCED = [
    { time: 10, text: 'Hello darkness (my old friend)' },
    { time: 14, text: '' },
    { time: 30, text: 'I have come again' },
];

test('lyrics: words in parentheses become ad-libs, the rest stays the line', () => {
    assert.deepEqual(tokenize('go (oh (yeah)) now').map((w) => [w.text, w.back]),
        [['go', false], ['oh', true], ['yeah', true], ['now', false]]);
    const { lines, adlibs } = buildLines(SYNCED, null);
    assert.deepEqual(lines[0].words.map((w) => w.text), ['Hello', 'darkness']);
    assert.equal(adlibs.length, 1);
    assert.deepEqual(adlibs[0].words.map((w) => w.text), ['my', 'old', 'friend']);
    assert.ok(lines[1].blank, 'an empty line is an instrumental ♪');
    // A song sung entirely in parentheses keeps its lines.
    const all = buildLines([{ time: 1, text: '(la la la)' }], null);
    assert.equal(all.lines.length, 1);
    assert.equal(all.adlibs.length, 0);
});

test('lyrics: aligned word times are used as they are, estimates stay inside the line', () => {
    const aligned = [[[10.2, 10.6], [10.7, 11.9], [12, 12.2], [12.3, 12.5], [12.6, 13]], null, null];
    const exact = buildLines(SYNCED, aligned).lines[0];
    assert.deepEqual(exact.words.map((w) => [w.s, w.e]), [[10.2, 10.6], [10.7, 11.9]]);
    const guess = buildLines(SYNCED, null).lines[2];
    assert.equal(guess.words[0].s, 30);
    for (let k = 1; k < guess.words.length; k++) assert.ok(guess.words[k].s >= guess.words[k - 1].e);
    assert.ok(guess.end < 36);
});

test('lyrics: a line goes live a little early, but not over the previous line\'s last word', () => {
    const { lines } = buildLines([{ time: 5, text: 'one two' }, { time: 6, text: 'three' }], [[[5, 5.3], [5.4, 6.4]], [[6.5, 7]]]);
    assert.ok(Math.abs(lines[0].on - (5 - LEAD)) < 1e-9);
    assert.equal(lines[1].on, 6.4, 'waits for "two" to finish');
});

test('lyrics: timeline lookups (line on stage, resting, instrumental breaks)', () => {
    const tl = new LyricsTimeline();
    const built = buildLines(SYNCED, null);
    tl.lines = built.lines;
    tl.adlibs = built.adlibs;
    assert.ok(tl.ready);
    assert.equal(tl.lineIndex(0), -1);
    assert.equal(tl.lineIndex(10), 0);
    assert.equal(tl.lineIndex(31), 2);
    assert.ok(tl.resting(3, -1));
    assert.ok(!tl.resting(10.5, 0));
    assert.ok(tl.resting(tl.lines[0].end + REST_AFTER + 0.1, 0));
    assert.deepEqual(tl.breakAt(3, -1), { a: 0, b: 10 }, 'the run-in before the first line');
    assert.equal(tl.breakAt(10.5, 0), null);
    assert.deepEqual(tl.breakAt(20, 1), { a: 14, b: 30 }, 'the ♪ line');
    assert.equal(tl.breakAt(40, 2).b, Infinity, 'the outro');
});

test('lyrics: transitions are deterministic and never repeat back to back', () => {
    const chorus = frame({ section: { label: 'chorus', idx: 1 } });
    assert.equal(pickTransition(chorus, 4, ''), pickTransition(chorus, 4, ''));
    let last = '';
    for (let i = 0; i < 12; i++) {
        const pick = pickTransition(chorus, i, last);
        assert.notEqual(pick, last);
        last = pick;
    }
    assert.equal(pickTransition(frame({ section: { label: 'build', idx: 2 } }), 3, 'sweep'), 'sweep', 'a one-way pool may repeat');
});

// ---------------------------------------------------------- environments

test('environments: unknown or unusable ids fall back to the default', () => {
    assert.equal(DEFAULT_ENVIRONMENT, 'classic');
    assert.ok(ENVIRONMENTS.classic.supported());
    assert.equal(normalizeEnvironment('nope'), 'classic');
    assert.equal(normalizeEnvironment(undefined), 'classic');
    assert.equal(normalizeEnvironment('constructor'), 'classic');
    assert.equal(resolveEnvironment('classic'), 'classic');
    for (const id of Object.keys(ENVIRONMENTS)) {
        assert.equal(resolveEnvironment(id, new Set([id])), 'classic', `${id} failed on this device`);
        assert.ok(nextEnvironment(id) in ENVIRONMENTS);
    }
});
