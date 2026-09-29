// Run with: node --test tests/js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenTracker, PlayRecorder, countThreshold } from '../../static/js/services/listenTracker.js';

function harness(song = { id: 7, duration: 200 }) {
    let wall = 1_000_000;
    const events = [];
    let n = 0;
    const tr = new ListenTracker({
        onEvent: (e) => events.push(e),
        now: () => wall,
        newId: () => `play-${++n}`,
    });
    tr.begin(song, 0);
    let pos = 0;
    /** Play `secs` of real time at 1x (one tick per second). */
    const play = (secs, rate = 1) => {
        for (let i = 0; i < secs; i++) {
            wall += 1000; pos += rate;
            tr.tick({ position: pos, playing: true, rate });
        }
    };
    const seek = (to) => { pos = to; tr.sync(to); };
    return { tr, events, play, seek, tick: (o) => tr.tick(o), setWall: (v) => (wall += v), get pos() { return pos; } };
}

test('thresholds', () => {
    assert.equal(countThreshold(200), 30);
    assert.equal(countThreshold(40), 20);
    assert.equal(countThreshold(4), 5);
    assert.equal(countThreshold(0), 30);
});

test('a listen reports started, then counted, then a final tally', () => {
    const h = harness();
    h.play(7);
    assert.equal(h.events.length, 0);
    h.play(2); // 9s >= 8s start mark
    assert.deepEqual(h.events.map(e => e.counted), [false]);
    h.play(21); // 30s
    assert.deepEqual(h.events.map(e => e.counted), [false, true]);
    h.play(10);
    h.tr.end();
    const last = h.events.at(-1);
    assert.equal(last.duration, 40);
    assert.equal(last.counted, true);
    assert.equal(new Set(h.events.map(e => e.play_id)).size, 1);
});

test('skipping early records nothing', () => {
    const h = harness();
    h.play(5);
    h.tr.end();
    assert.equal(h.events.length, 0);
});

test('seeking forward does not inflate listening time', () => {
    const h = harness();
    h.play(3);
    h.seek(150);
    h.play(3);
    h.tr.end();
    assert.equal(h.events.length, 0); // 6s only
    const h2 = harness();
    h2.play(3);
    h2.tick({ position: 190, playing: true }); // instant jump
    h2.play(2);
    h2.tr.end();
    assert.equal(h2.events.length, 0);
});

test('pause gap is not counted', () => {
    const h = harness();
    h.play(6);
    h.tick({ position: h.pos, playing: false });
    h.setWall(600_000); // paused 10 minutes
    h.tr.sync(h.pos);
    h.play(3);
    h.tr.end();
    // 9s of real listening: started + final tally, never counted
    assert.ok(h.events.every(e => e.counted === false));
    assert.equal(h.events.at(-1).duration, 9);
});

test('2x playback still counts fully', () => {
    const h = harness();
    h.play(10, 2); // 20 media seconds
    h.tr.end();
    assert.equal(h.events.at(-1).duration, 20);
});

test('repeat-one loop starts a new listen', () => {
    const h = harness({ id: 7, duration: 40 });
    h.play(20); // counted (threshold 20)
    h.seek(0);
    // position wrapped after playing to the end
    const h2 = harness({ id: 7, duration: 40 });
    h2.play(39);
    h2.tick({ position: 0.5, playing: true, rate: 1 });
    h2.play(25);
    h2.tr.end();
    const ids = new Set(h2.events.map(e => e.play_id));
    assert.equal(ids.size, 2);
    assert.ok(h2.events.every(e => e.counted || e.duration >= 8));
});

test('preview / invalid ids are ignored', () => {
    const events = [];
    const tr = new ListenTracker({ onEvent: (e) => events.push(e) });
    tr.begin({ id: undefined, duration: 100 });
    tr.begin({ id: -1, duration: 100 });
    assert.equal(tr.songId, null);
});

// ---------------------------------------------------------------- recorder

function memStorage() {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), _m: m };
}

function recorderHarness(responses) {
    const storage = memStorage();
    const timers = [];
    const calls = [];
    let wall = 5_000_000;
    const make = () => new PlayRecorder({
        storage,
        now: () => wall,
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: () => {},
        beaconFn: null,
        fetchFn: async (url, init) => {
            calls.push(JSON.parse(init.body));
            const r = responses.shift();
            if (r instanceof Error) throw r;
            return { ok: r >= 200 && r < 300, status: r };
        },
    });
    return { storage, timers, calls, make, advance: (ms) => (wall += ms) };
}

const P = (over = {}) => ({ song_id: 1, play_id: 'a', duration: 10, counted: false, started_at: 5_000_000, client: 'web', ...over });

test('recorder merges by play_id and clears on success', async () => {
    const h = recorderHarness([200]);
    const r = h.make();
    r.enqueue(P());
    r.enqueue(P({ duration: 35, counted: true }));
    assert.equal(r.pending, 1);
    h.advance(12_000);
    assert.equal(await r.flush(), true);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(
        { d: h.calls[0].plays[0].duration, c: h.calls[0].plays[0].counted, age: h.calls[0].plays[0].age_seconds },
        { d: 35, c: true, age: 12 });
    assert.equal(r.pending, 0);
});

test('recorder keeps plays through failures and survives a reload', async () => {
    const h = recorderHarness([new Error('offline'), 503, 200]);
    let r = h.make();
    r.enqueue(P());
    assert.equal(await r.flush(), false);
    assert.equal(r.pending, 1);
    assert.ok(h.timers.some(t => t.ms >= 10_000)); // backoff scheduled

    r = h.make(); // "page reload": queue restored from storage
    assert.equal(r.pending, 1);
    assert.equal(await r.flush(), false); // 503
    assert.equal(r.pending, 1);
    assert.equal(await r.flush(), true); // 200
    assert.equal(r.pending, 0);
});

test('an entry updated while its request is in flight is not lost', async () => {
    const storage = memStorage();
    let release;
    const gate = new Promise(res => { release = res; });
    const r = new PlayRecorder({
        storage, beaconFn: null, setTimer: () => 1, clearTimer: () => {},
        fetchFn: async () => { await gate; return { ok: true, status: 200 }; },
    });
    r.enqueue(P());
    const p = r.flush();
    r.enqueue(P({ duration: 50, counted: true })); // grows mid-flight
    release();
    await p;
    assert.equal(r.pending, 1);
});

test('a malformed-batch 400 is dropped, not retried forever', async () => {
    const h = recorderHarness([400]);
    const r = h.make();
    r.enqueue(P());
    await r.flush();
    assert.equal(r.pending, 0);
});

test('onRecorded only fires for new or newly counted plays', async () => {
    let calls = 0;
    const r = new PlayRecorder({
        storage: memStorage(), beaconFn: null, setTimer: () => 1, clearTimer: () => {},
        fetchFn: async () => ({ ok: true, status: 200 }),
        onRecorded: () => calls++,
    });
    r.enqueue(P({ started_at: Date.now() - 1000 }));
    await r.flush();
    assert.equal(calls, 1);
    r.enqueue(P({ duration: 20, started_at: Date.now() })); // top-up of an already-saved play
    await r.flush();
    assert.equal(calls, 1);
    r.enqueue(P({ duration: 35, counted: true, started_at: Date.now() })); // now qualifies -> lists change
    await r.flush();
    assert.equal(calls, 2);
    r.enqueue(P({ duration: 80, counted: true, started_at: Date.now() })); // final tally
    await r.flush();
    assert.equal(calls, 2);
});
