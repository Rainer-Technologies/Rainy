// Song radio queue handling (static/js/modules/radio.js) against a fake
// player and a scripted /api/radio.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SongRadio } from '../../static/js/modules/radio.js';

const pending = (videoId, title = videoId) =>
    ({ videoId, title, artist: 'New Artist', duration: 200, cover_url: 'https://img/x', radio: true });
const downloaded = (id, title) =>
    ({ id, title, artist: 'New Artist', duration: 200, cover_path: `covers/${id}.jpg`, in_library: false });

// End every radio a test started, or its prefetch polling keeps Node alive.
const radios = [];
afterEach(() => {
    for (const radio of radios.splice(0)) {
        radio._session = null;
        clearTimeout(radio._pollTimer);
    }
});

/** A player with just what the radio touches, and a scripted server. */
function harness({ queue = [], prefetch = () => ({}) } = {}) {
    const calls = [];
    const player = {
        playlist: [], currentIndex: -1, playbackContext: null, isControllerMode: false,
        _shuffleRemaining: null, fsQueueList: null, adopted: [], kept: [],
        _songKey: (song, index) => String(song.id ?? song.videoId ?? `i:${index}`),
        playSong(index, playlist, context) {
            if (playlist) this.playlist = playlist;
            if (context) this.playbackContext = context;
            this.currentIndex = index;
        },
        adoptDownloadedSong(index, song) {
            const entry = this.playlist[index];
            delete entry.videoId;
            delete entry.cover_url;
            Object.assign(entry, song, { radio: true });
            this.adopted.push(index);
        },
        keepSong(song) { this.kept.push(song.id); },
    };
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        const data = url.endsWith('/prefetch')
            ? { tracks: prefetch(body.tracks.map(t => t.videoId)) }
            : { queue: typeof queue === 'function' ? queue(body) : queue };
        return { ok: true, json: async () => data };
    };
    const failedKeeps = [];
    const radio = new SongRadio(player, { onKeepFailed: song => failedKeeps.push(song.videoId) });
    radios.push(radio);
    const settle = () => new Promise(resolve => setImmediate(resolve));
    return { player, radio, calls, failedKeeps, settle, stop: () => clearTimeout(radio._pollTimer) };
}

const SEED = { id: 1, title: 'Seed', artist: 'Seed Artist', in_library: true };

test('the seed plays at once and the first batch is queued behind it', async () => {
    const h = harness({ queue: [pending('aaaaaaaaaa1'), pending('aaaaaaaaaa2')] });
    await h.radio.start(SEED);
    h.stop();
    assert.equal(h.player.currentIndex, 0);
    assert.deepEqual(h.player.playbackContext, { type: 'radio', id: 1, endless: true });
    assert.deepEqual(h.player.playlist.map(s => s.id ?? s.videoId), [1, 'aaaaaaaaaa1', 'aaaaaaaaaa2']);
});

test('starting a radio asks for the first batch only', async () => {
    const h = harness({ queue: [pending('aaaaaaaaaa1'), pending('aaaaaaaaaa2')] });
    // Like the real player: every song change asks the radio to top up.
    const playSong = h.player.playSong.bind(h.player);
    h.player.playSong = (...args) => { playSong(...args); h.radio.extend(); };
    await h.radio.start(SEED);
    await h.settle();
    h.stop();
    assert.deepEqual(h.calls.filter(c => !c.url.endsWith('/prefetch')).map(c => c.url),
        ['/api/radio/start']);
    assert.equal(h.player.playlist.length, 3);
});

test('upcoming tracks become real songs when their download lands', async () => {
    const h = harness({
        queue: [pending('aaaaaaaaaa1'), pending('aaaaaaaaaa2')],
        prefetch: () => ({ aaaaaaaaaa1: { status: 'ready', song: downloaded(50, 'One') },
                           aaaaaaaaaa2: { status: 'queued' } }),
    });
    await h.radio.start(SEED);
    await h.settle();
    h.stop();
    const [, first, second] = h.player.playlist;
    assert.equal(first.id, 50);
    assert.equal(first.videoId, undefined);
    assert.equal(first.in_library, false);
    assert.equal(second.id, undefined);
});

test('a track reached before its download is fetched and adopted while it plays', async () => {
    let ready = false;
    const h = harness({
        queue: [pending('aaaaaaaaaa1'), pending('aaaaaaaaaa2')],
        prefetch: () => (ready ? { aaaaaaaaaa1: { status: 'ready', song: downloaded(50, 'One') } }
                               : { aaaaaaaaaa1: { status: 'queued' } }),
    });
    await h.radio.start(SEED);
    await h.settle();
    h.stop();

    h.player.playSong(1);                 // the listener skips straight to the new song
    const playing = h.player.playlist[1];
    const before = h.calls.length;
    ready = true;
    await h.radio.extend();
    await h.settle();
    h.stop();

    const prefetch = h.calls.slice(before).find(c => c.url.endsWith('/prefetch'));
    assert.equal(prefetch.body.tracks[0].videoId, 'aaaaaaaaaa1', 'the playing track is requested first');
    assert.deepEqual(h.player.adopted, [1]);
    assert.equal(h.player.playlist[1], playing, 'same queue entry: the audio is not restarted');
    assert.equal(playing.id, 50);
});

test('keeping a track that is still downloading saves it once it lands', async () => {
    let ready = false;
    const h = harness({
        queue: [pending('aaaaaaaaaa1')],
        prefetch: () => (ready ? { aaaaaaaaaa1: { status: 'ready', song: downloaded(50, 'One') } }
                               : { aaaaaaaaaa1: { status: 'queued' } }),
    });
    await h.radio.start(SEED);
    await h.settle();
    h.stop();
    h.player.playSong(1);
    const playing = h.player.playlist[1];

    assert.equal(h.radio.keepWhenReady(playing), 'queued');
    assert.equal(playing.keepRequested, true);
    await h.settle();
    assert.deepEqual(h.player.kept, [], 'nothing to keep yet');

    ready = true;
    h.stop();
    await h.radio._poll();
    h.stop();
    assert.deepEqual(h.player.kept, [50]);
});

test('a failed download cannot be kept and says so', async () => {
    const h = harness({
        queue: [pending('aaaaaaaaaa1')],
        prefetch: () => ({ aaaaaaaaaa1: { status: 'failed' } }),
    });
    await h.radio.start(SEED);
    await h.settle();
    h.stop();
    h.player.playSong(1);
    const playing = h.player.playlist[1];
    assert.equal(h.radio.keepWhenReady(playing), 'failed');

    // Asked for before the failure was known: the request is dropped loudly.
    const h2 = harness({ queue: [pending('bbbbbbbbbb1')], prefetch: () => ({ bbbbbbbbbb1: { status: 'queued' } }) });
    await h2.radio.start(SEED);
    await h2.settle();
    h2.stop();
    h2.player.playSong(1);
    const song = h2.player.playlist[1];
    assert.equal(h2.radio.keepWhenReady(song), 'queued');
    await h2.settle();
    h2.stop();
    h2.radio._session.failed.clear();
    h2.radio._fail(h2.radio._session, 'bbbbbbbbbb1');
    assert.deepEqual(h2.failedKeeps, ['bbbbbbbbbb1']);
    assert.equal(song.keepRequested, false);
});

test('the queue is topped up when it runs low, excluding what is queued', async () => {
    const h = harness({
        queue: body => (body.exclude_video_ids?.length
            ? [pending('cccccccccc3')]
            : [pending('aaaaaaaaaa1'), downloaded(60, 'Local')]),
    });
    await h.radio.start(SEED);
    h.stop();
    await h.radio.extend();
    h.stop();
    const more = h.calls.find(c => c.url.endsWith('/more'));
    assert.deepEqual(more.body.exclude_video_ids, ['aaaaaaaaaa1']);
    assert.deepEqual(more.body.exclude_song_ids, [1, 60]);
    assert.equal(h.player.playlist.at(-1).videoId, 'cccccccccc3');
});

test('answers for a radio the listener left are ignored', async () => {
    const h = harness({ queue: [pending('aaaaaaaaaa1')] });
    const starting = h.radio.start(SEED);
    h.player.playSong(0, [{ id: 9, title: 'Something else' }], { type: 'library', id: null });
    await starting;
    h.stop();
    assert.deepEqual(h.player.playlist.map(s => s.id), [9]);
});
