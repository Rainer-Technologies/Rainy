// The Voyage environment's world model (static/js/lightshow/environments/voyage/world.js):
// a score turned into terrain rows, colours, gates and portals. No WebGL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Score } from '../../static/js/lightshow/score.js';
import {
    speedFor, rowsFor, poolEnvelope, smoothRows, bakeEnvelopes, sectionPalettes, bakePalettes, buildGates,
    gateWindow, buildPortals, lastEvent, lastHits, GATE, PAL_COLS, ROWS_MAX,
} from '../../static/js/lightshow/environments/voyage/world.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** A one-minute, 120 BPM song: intro, verse, build, (stop) drop, outro. */
function song(duration = 60) {
    const frames = duration * 50;
    const flat = (v) => b64(new Uint8Array(frames).fill(v));
    const rms = new Uint8Array(frames);
    for (let i = 0; i < frames; i++) rms[i] = i / 50 >= 32 && i / 50 < 48 ? 240 : 60;   // loud in the drop
    const beats = [], downbeats = [], kicks = [];
    for (let t = 0; t < duration; t += 0.5) {
        beats.push(t);
        if (Math.round(t * 2) % 4 === 0) downbeats.push(t);
        kicks.push([t, 0.8]);
    }
    return Score.from({
        v: 2, duration, fps: 50, tempo: 120, tempoConf: 0.9, beats, downbeats,
        onsets: { k: kicks, s: [], h: [] },
        env: { sub: flat(100), bass: flat(100), mid: flat(100), high: flat(100), air: flat(100), rms: b64(rms), harm: flat(100) },
        sections: [
            { t0: 0, t1: 8, label: 'intro', energy: 0.2, key: 'C', mode: 'major' },
            { t0: 8, t1: 24, label: 'verse', energy: 0.5, key: 'C', mode: 'major' },
            { t0: 24, t1: 32, label: 'build', energy: 0.6, key: 'C', mode: 'major' },
            { t0: 32, t1: 48, label: 'drop', energy: 0.95, key: 'A', mode: 'minor' },
            { t0: 48, t1: 60, label: 'outro', energy: 0.2, key: 'A', mode: 'minor' },
        ],
        events: [{ t: 31.5, type: 'stop', dur: 0.4 }, { t: 32, type: 'drop' }, { t: 24, type: 'riser', dur: 8 }],
        profile: { genre: 'edm', intensity: 0.8 },
    });
}

test('speed follows the tempo, within limits', () => {
    assert.equal(speedFor(120), 26);
    assert.ok(speedFor(160) > speedFor(120));
    assert.equal(speedFor(400), speedFor(300), 'capped');
    assert.equal(speedFor(undefined), 26);
});

test('envelopes are pooled by peak, so a single hit survives the resample', () => {
    const src = new Uint8Array(1000);
    src[503] = 255;
    const out = poolEnvelope(src, 100);
    assert.equal(out[50], 255);
    assert.equal(out.reduce((a, b) => a + b, 0), 255);
    assert.equal(poolEnvelope(null, 10).length, 10);
    const smooth = smoothRows(Uint8Array.from([0, 0, 0, 90, 0, 0, 0]), 1);
    assert.deepEqual([...smooth], [0, 0, 30, 30, 30, 0, 0]);
});

test('a song bakes into at most ROWS_MAX rows, with the loud part as the mass of the land', () => {
    assert.equal(rowsFor(60), 540);
    assert.equal(rowsFor(3600), ROWS_MAX);
    assert.equal(rowsFor(0), 64);
    const s = song();
    const env = bakeEnvelopes(s);
    assert.equal(env.rows, 540);
    assert.equal(env.a.length, env.rows * 4);
    const row = (t) => Math.floor((t / 60) * env.rows) * 4;
    assert.equal(env.a[row(10)], 100, 'sub');
    assert.equal(env.b[row(40) + 1], 240, 'rms in the drop');
    assert.ok(env.b[row(40) + 2] > 200, 'mass in the drop');
    assert.ok(env.b[row(10) + 2] < 80, 'mass in the verse');
    const long = bakeEnvelopes(song(600));
    assert.equal(long.rows, ROWS_MAX);
});

test('every moment has its section\'s colours; builds and stops are marked', () => {
    const s = song();
    const pals = sectionPalettes(s, 210);
    assert.equal(pals.length, 5);
    const rows = 540;
    const tex = bakePalettes(s, pals, rows);
    assert.equal(tex.length, rows * PAL_COLS * 4);
    const at = (t) => tex.subarray(Math.floor((t / 60) * rows) * PAL_COLS * 4, Math.floor((t / 60) * rows) * PAL_COLS * 4 + PAL_COLS * 4);
    const verse = at(16), drop = at(40);
    assert.deepEqual([...verse.subarray(0, 3)], pals[1].a.map(Math.round));
    assert.deepEqual([...drop.subarray(4, 7)], pals[3].b.map(Math.round));
    assert.equal(drop[7], 255, 'a drop is as hot as it gets');
    assert.ok(verse[7] < drop[7]);
    assert.equal(verse[11], 0, 'no tension in the verse');
    assert.ok(at(31)[11] > 200, 'tension at the top of the build');
    assert.ok(at(28)[11] > 100 && at(28)[11] < at(31)[11]);
    assert.equal(at(31.7)[15], 255, 'inside the silence before the drop');
    assert.equal(at(30)[15], 0);
    // Sections melt into each other, but a drop cuts in.
    const before = at(7.9), after = at(8.1);
    assert.ok(Math.abs(before[0] - after[0]) <= 2, 'intro → verse is a blend');
});

test('beats become gates: bars, phrases, and a build filling in', () => {
    const s = song();
    const g = buildGates(s);
    for (let i = 1; i < g.t.length; i++) assert.ok(g.t[i] >= g.t[i - 1], 'sorted');
    const kindAt = (t) => g.kind[g.t.findIndex((x) => Math.abs(x - t) < 1e-6)];
    assert.equal(kindAt(0), GATE.PHRASE, 'a section opens with a phrase arch');
    assert.equal(kindAt(0.5), GATE.BEAT);
    assert.equal(kindAt(2), GATE.BAR);
    assert.equal(kindAt(8), GATE.PHRASE, 'first bar of the verse');
    assert.equal(kindAt(24), GATE.PHRASE);
    assert.equal(kindAt(16), GATE.BAR, 'bar 4 of the verse');
    const subs = [...g.t].filter((t, i) => g.kind[i] === GATE.SUB);
    assert.ok(subs.length > 0 && subs.every((t) => t >= 24 && t < 32), 'only the build subdivides');
    assert.ok(subs.some((t) => Math.abs((t * 8) % 1) < 1e-6 && Math.abs((t * 4) % 1) > 1e-6), 'quarter beats near the top');
    assert.ok(!subs.some((t) => t < 27), 'not at the start of the build');
    const [i0, i1] = gateWindow(g, 10, 12);
    assert.deepEqual([...g.t.subarray(i0, i1)], [10.5, 11, 11.5, 12]);
    assert.ok(g.power.every((p) => p >= 0.2 && p <= 1));
});

test('sections become portals, and the past is found by time', () => {
    const s = song();
    const portals = buildPortals(s);
    assert.deepEqual(portals.map((p) => p.t), [8, 24, 32, 48]);
    assert.deepEqual(portals.map((p) => p.drop), [false, false, true, false]);
    assert.equal(lastEvent(s, 'drop', 31.9), null);
    assert.equal(lastEvent(s, 'drop', 33).t, 32);
    assert.equal(lastEvent(s, 'drop', 50, 6), null, 'too long ago');
    const hits = lastHits(s, 'k', 10.2, 4);
    assert.deepEqual(hits.map((h) => h[0]), [10, 9.5, 9, 8.5]);
    assert.deepEqual(lastHits(s, 'k', -1, 2).map((h) => h[1]), [0, 0], 'padded when there are none');
});
