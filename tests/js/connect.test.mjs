// Run with: node --test tests/js/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONNECT_MAX_QUEUE, connectLivePosition, connectWindowStart, normalizeRepeat,
} from '../../static/js/services/connect.js';

test('a queue that fits is not windowed', () => {
    assert.equal(connectWindowStart(CONNECT_MAX_QUEUE, 499), 0);
    assert.equal(connectWindowStart(0, 0), 0);
});

test('the window follows the current track in steps', () => {
    // Same numbers as models/connect.py window_queue() and the mobile app.
    assert.equal(connectWindowStart(2000, 0), 0);
    assert.equal(connectWindowStart(2000, 149), 0);
    assert.equal(connectWindowStart(2000, 150), 100);
    assert.equal(connectWindowStart(2000, 1234), 1100);
    // Never past the end: the window stays full.
    assert.equal(connectWindowStart(2000, 1999), 1500);
});

test('the current track is always inside its window', () => {
    for (const length of [501, 777, 2000]) {
        for (let index = 0; index < length; index++) {
            const start = connectWindowStart(length, index);
            assert.ok(index >= start && index < start + CONNECT_MAX_QUEUE, `${length}/${index}`);
        }
    }
});

test('repeat mode has one vocabulary', () => {
    assert.equal(normalizeRepeat('off'), 'none');
    assert.equal(normalizeRepeat(undefined), 'none');
    assert.equal(normalizeRepeat('all'), 'all');
    assert.equal(normalizeRepeat('one'), 'one');
});

test('live position adds the snapshot age only while playing', () => {
    const device = { position: 10, duration: 100, is_playing: true, state_age: 3 };
    assert.equal(connectLivePosition(device), 13);
    assert.equal(connectLivePosition({ ...device, is_playing: false }), 10);
    // Never past the end of the track.
    assert.equal(connectLivePosition({ ...device, position: 99 }), 100);
    // Time since the snapshot was received counts too.
    const later = connectLivePosition(device, performance.now() - 2000);
    assert.ok(later >= 15 && later < 15.5, String(later));
});
