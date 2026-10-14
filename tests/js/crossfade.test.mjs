// Exercise the real AudioPlayer methods without booting the app/Connect or a live DB.
// Browser audio and scheduling are the seam; UI/network services stay isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Audio extends EventTarget {
    constructor(id) {
        super();
        Object.assign(this, { id, _src: '', volume: 0.8, currentTime: 0,
            duration: 100, playbackRate: 1, paused: true, ended: false,
            seeking: false, muted: false, readyState: 4, playCalls: 0, loadCalls: 0, sources: [] });
    }
    get src() { return this._src; }
    set src(value) { this._src = value; this.sources.push(value); }
    play() {
        this.playCalls++;
        this.paused = false;
        return this.pendingPlay || Promise.resolve();
    }
    pause() { this.paused = true; }
    load() { this.loadCalls++; }
    removeAttribute(name) { if (name === 'src') this._src = ''; }
    emit(name) { this.dispatchEvent(new Event(name)); }
}

const source = readFileSync(new URL('../../static/js/player.js', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\n/gm, '').replace('export class AudioPlayer', 'class AudioPlayer');
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness() {
    let now = 0, seq = 0;
    const frames = new Map(), timers = new Map(), fetches = [];
    const storage = new Map([['rainy_volume', '0.8']]);
    const scope = {
        performance: { now: () => now },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        fetch: async url => { fetches.push(url); return { blob: async () => ({}) }; },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        requestAnimationFrame: fn => { frames.set(++seq, fn); return seq; },
        cancelAnimationFrame: id => frames.delete(id),
        setInterval: fn => { timers.set(++seq, fn); return seq; },
        clearInterval: id => timers.delete(id),
        window: new EventTarget(), document: { getElementById: () => null },
        CustomEvent: class extends Event {
            constructor(type, options) { super(type); this.detail = options.detail; }
        },
        Logger: { error() {}, log() {} }, t: s => s,
        peekAudioGraph: () => null, getAudioGraph: () => null,
    };
    const Player = vm.runInNewContext(`${source}\nAudioPlayer;`, scope);
    const p = Object.create(Player.prototype);
    const outgoing = new Audio('audio-player'), incoming = new Audio('crossfade-audio');
    outgoing.src = '/api/music/stream/1'; outgoing.currentTime = 95; outgoing.paused = false;
    Object.assign(p, { audio: outgoing, crossfadeAudio: incoming,
        playlist: [{ id: 1 }, { id: 2 }, { id: 3 }], currentIndex: 0, currentSong: { id: 1 },
        _crossfadeEnabled: true, _crossfadeDuration: 5, _crossfading: false,
        _crossfadeTriggered: false, _crossfadeRaf: null, _eqFilters: [], _eqGains: Array(10).fill(0),
        isPlaying: true, repeatMode: 'none', abPointA: null, abPointB: null,
        _listenTracker: { sync() {}, end() {} },
        updateNowPlaying(song) { this.currentSong = song; },
        savePlaybackState() {}, _maybeExtendMix() {}, _flushListenTracking() {},
        clearAbRepeat() {}, handleMetadataLoaded() {}, handleTimeUpdate() {},
        handlePlay() { this.isPlaying = true; }, handlePause() { this.isPlaying = false; },
        handleCanPlay() {}, handleWaiting() {}, handleError() {},
        updateVolumeGradient() {}, updateFsVolumeGradient() {},
    });
    function tick(ms) {
        now = ms;
        for (const [id, fn] of [...frames]) { frames.delete(id); fn(now); }
        for (const fn of [...timers.values()]) fn();
    }
    return { p, outgoing, incoming, frames, timers, fetches, storage, tick, scope };
}

test('Smart Mix highlight follows real now-playing updates across deck promotion and manual selection', async () => {
    const h = harness();
    // Run production updateNowPlaying, not the transport-only harness override.
    delete h.p.updateNowPlaying;
    Object.assign(h.scope, { Utils: { escapeHtml: value => value }, setTimeout() {} });
    Object.assign(h.p, {
        nowPlayingTitle: {}, nowPlayingArtist: {}, nowPlayingArtwork: {},
        _tempoMapLoaded: true, tempoBySongId: new Map(),
        _startListenTracking(song) { this._listenTracker.songId = song.id; },
        ensureLikedDataInitialized: async () => {}, updateReactionButtons() {},
    });
    let rowUpdates = 0;
    const rows = h.p.playlist.map(song => {
        const classes = new Set();
        return { dataset: { song: String(song.id) }, classList: {
            toggle(name, enabled) {
                rowUpdates++;
                if (enabled) classes.add(name); else classes.delete(name);
            },
            contains: name => classes.has(name),
        } };
    });
    const detail = { querySelectorAll: selector => {
        assert.equal(selector, '.mix-track');
        return rows;
    } };
    h.scope.document.getElementById = id => id === 'mix-detail' ? detail : null;
    const mixesSource = readFileSync(new URL('../../static/js/modules/mixes.js', import.meta.url), 'utf8')
        .replace(/^import\s[\s\S]*?;\n/gm, '').replace('export class MixesView', 'class MixesView');
    const MixesView = vm.runInNewContext(`${mixesSource}\nMixesView;`, h.scope);
    const view = new MixesView({}, h.p);
    const playingIds = () => rows.filter(row => row.classList.contains('playing')).map(row => row.dataset.song);
    const notifications = [];
    h.scope.window.addEventListener('rainy:now-playing', event => notifications.push(event.detail));
    view._markPlaying();
    assert.deepEqual(playingIds(), ['1']);

    // Promotion itself emits no physical play/loadstart event.
    h.p._startCrossfade(1);
    await settle();
    h.outgoing.currentTime = 100;
    h.incoming.currentTime = 5;
    h.tick(5000);
    assert.equal(h.p.audio, h.incoming);
    assert.equal(h.p.currentSong.id, 2);
    assert.deepEqual(playingIds(), ['2'], 'promotion must move the Smart Mix playing row');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].player, h.p);
    assert.equal(notifications[0].song, h.p.currentSong);

    // Subsequent user selection now uses the promoted physical deck too.
    h.p.playSong(2);
    assert.deepEqual(playingIds(), ['3'], 'manual selection must not depend on the original audio element');
    assert.equal(notifications.length, 2);
    h.p.togglePlayPause();
    h.incoming.emit('pause');
    assert.deepEqual(playingIds(), ['3'], 'the highlight represents the current song, including when paused');

    // Another player sharing the window must not refresh this view.
    const updatesBeforeForeignSong = rowUpdates;
    const otherPlayer = Object.create(h.p);
    otherPlayer.updateNowPlaying(h.p.playlist[0]);
    assert.equal(notifications.length, 3, 'the foreign event also comes from production updateNowPlaying');
    assert.equal(rowUpdates, updatesBeforeForeignSong, 'ignore notifications from a different player');
    assert.deepEqual(playingIds(), ['3']);
    await settle();
});

test('handoff keeps the already-playing incoming stream without reload, seek or duplicate audio', async () => {
    const h = harness();
    h.p._startCrossfade(1);
    await settle();
    h.incoming.currentTime = 5;
    h.outgoing.currentTime = 100;
    h.tick(5000);
    // Drive the old reload/seek handoff too: it used to produce two copies of song 2.
    h.outgoing.emit('loadedmetadata');
    h.outgoing.emit('seeked');
    h.outgoing.emit('playing');
    const audibleNext = [h.outgoing, h.incoming].filter(a => !a.paused && a.volume > 0.01 &&
        (a.src.includes('/2') || a.src.startsWith('blob:')));
    assert.equal(audibleNext.length, 1, 'the incoming song must never play twice at handoff');
    assert.equal(h.p.audio, h.incoming, 'promote the buffered decoder rather than restarting it');
    assert.equal(h.incoming.currentTime, 5, 'no jump/repeated second');
    assert.equal(h.incoming.playCalls, 1);
    assert.equal(h.incoming.loadCalls, 0, 'no buffering gap at promotion');
    assert.equal(h.fetches.length, 0, 'do not download another complete copy of the stream');
    assert.equal(h.p.currentIndex, 1);
    assert.equal(h.p.isPlaying, true);
});

test('a cancelled play promise cannot cancel or schedule work in a newer fade', async () => {
    const h = harness();
    let rejectOld;
    h.incoming.pendingPlay = new Promise((_, reject) => { rejectOld = reject; });
    h.p._startCrossfade(1);
    h.p._cancelCrossfade();
    h.incoming.pendingPlay = null;
    h.p._startCrossfade(2);
    await settle();
    rejectOld(new Error('old decoder aborted'));
    await settle();
    assert.equal(h.p._crossfading, true, 'a late rejection belongs to the cancelled fade only');
    h.p._cancelCrossfade();
});

test('natural end finishes the fade even when background-tab animation frames never run', async () => {
    const h = harness();
    h.p._startCrossfade(1);
    await settle();
    h.incoming.currentTime = 5;
    h.outgoing.currentTime = 100;
    h.outgoing.ended = true;
    h.outgoing.paused = true;
    h.p.handleEnded();
    assert.equal(h.p.audio, h.incoming, 'a hidden tab cannot leave the player attached to an ended song');
    assert.equal(h.p.currentIndex, 1);
    assert.equal(h.p.audio.volume, 0.8);
    assert.equal(h.p._crossfading, false);
});

test('events follow the promoted element and retired events cannot skip or pause the new song', async () => {
    const h = harness();
    let updates = 0, ends = 0;
    h.p.handleTimeUpdate = () => { updates++; };
    h.p.handleEnded = () => { ends++; };
    h.p._bindAudioEvents?.(h.outgoing);
    h.p._bindAudioEvents?.(h.incoming);
    h.outgoing.emit('timeupdate');
    assert.equal(updates, 1, 'active audio must drive the player');
    h.p._startCrossfade(1);
    await settle();
    h.outgoing.currentTime = 100;
    h.incoming.currentTime = 5;
    h.tick(5000);
    updates = 0;
    h.outgoing.emit('pause');
    h.outgoing.emit('ended');
    h.outgoing.emit('timeupdate');
    assert.equal(h.p.isPlaying, true);
    assert.equal(ends, 0);
    assert.equal(updates, 0);
    h.incoming.emit('timeupdate');
    assert.equal(updates, 1, 'the promoted element must now drive progress');
    h.incoming.emit('pause');
    assert.equal(h.p.isPlaying, false, 'pause still works after handoff');
});

test('a stalled media clock cannot fade out the working song based on wall time', async () => {
    const h = harness();
    h.p._startCrossfade(1);
    await settle();
    // Neither decoder made progress despite five seconds of elapsed wall time.
    h.tick(5000);
    assert.equal(h.p.currentIndex, 0);
    assert.equal(h.outgoing.volume, 0.8, 'keep the outgoing stream audible until media advances');
    h.p._cancelCrossfade();
});

test('muting during a fade silences both streams and stays muted through handoff', async () => {
    const h = harness();
    h.p._startCrossfade(1);
    await settle();
    h.outgoing.currentTime = 97.5;
    h.incoming.currentTime = 2.5;
    h.tick(2500);
    h.p.setVolume(0);
    assert.equal(h.incoming.volume, 0, 'volume controls must affect the incoming song too');
    h.tick(2600);
    assert.equal(h.outgoing.volume, 0, 'the fade cannot overwrite a new master volume');
    h.outgoing.currentTime = 100;
    h.incoming.currentTime = 5;
    h.tick(5000);
    assert.equal(h.p.audio.volume, 0);
});

for (const [name, configure] of [
    ['paused', h => { h.outgoing.paused = true; }],
    ['already attempted', h => { h.p._crossfadeTriggered = true; }],
    ['remote controller', h => { h.p._controllerTarget = { device_id: 'remote' }; }],
    ['A-B loop', h => { h.p.abPointA = 90; h.p.abPointB = 99; }],
    ['seeking', h => { h.outgoing.seeking = true; }],
    ['repeat one', h => { h.p.repeatMode = 'one'; }],
]) {
    test(`crossfade does not start while ${name}`, () => {
        const h = harness();
        configure(h);
        h.p._checkCrossfade();
        assert.equal(h.incoming.playCalls, 0);
    });
}

test('EQ follows both crossfade decks and keeps the active filters after promotion', async () => {
    const h = harness();
    const graphs = new Map();
    h.scope.getAudioGraph = audio => {
        if (!graphs.has(audio)) {
            const ctx = { state: 'running', createBiquadFilter: () => ({
                frequency: {}, Q: {}, gain: {}, connect() {},
            }) };
            graphs.set(audio, { ctx, source: {}, setChain() {}, resume() {} });
        }
        return graphs.get(audio);
    };
    h.p._eqEnabled = true;
    h.p._ensureEqGraph();
    h.p._startCrossfade(1);
    await settle();
    assert.equal(graphs.size, 2, 'the incoming song must not bypass the equalizer');
    h.p.applyEqGains(Array(10).fill(6));
    h.outgoing.currentTime = 100;
    h.incoming.currentTime = 5;
    h.tick(5000);
    assert.equal(h.p._eqContext, graphs.get(h.incoming).ctx);
    assert.equal(h.p._eqFilters[0].gain.value, 6);
    h.p.toggleEqEnabled();
    assert.equal(h.p._eqFilters[0].gain.value, 0);
});

test('lightshow retargets its clock and analyser rather than following the retired deck', () => {
    const h = harness();
    const engineSource = readFileSync(new URL('../../static/js/lightshow/engine.js', import.meta.url), 'utf8')
        .replace(/^import\s[\s\S]*?;\n/gm, '').replace('export class LightShowEngine', 'class LightShowEngine');
    const Engine = vm.runInNewContext(`${engineSource}\nLightShowEngine;`, { performance: { now: () => 0 } });
    const show = Object.create(Engine.prototype);
    let changes = 0;
    Object.assign(show, { audioEl: h.outgoing, live: { audioEl: h.outgoing },
        _idle: { audioEl: h.outgoing }, clock: { reset() {} },
        conductor: { onTrackChange() { changes++; } }, _tell() {}, _onLoadStart() {} });
    show.setAudioElement?.(h.incoming);
    assert.equal(show.audioEl, h.incoming);
    assert.equal(show.live, null);
    assert.equal(show._idle, null);
    assert.equal(changes, 1);
});

test('speed and mute changes are shared by both decks during overlap', async () => {
    const h = harness();
    h.p._bindAudioEvents(h.outgoing);
    h.p._bindAudioEvents(h.incoming);
    h.p._startCrossfade(1);
    await settle();
    h.p.setPlaybackSpeed(2);
    assert.equal(h.incoming.playbackRate, 2);
    h.outgoing.muted = true;
    h.outgoing.emit('volumechange');
    assert.equal(h.incoming.muted, true, 'keyboard mute must silence both decks');
    h.p._cancelCrossfade();
});

test('sleep fade controls the master volume rather than fighting the crossfade envelopes', async () => {
    const h = harness();
    const sleepSource = readFileSync(new URL('../../static/js/modules/sleepTimer.js', import.meta.url), 'utf8')
        .replace(/^import\s[\s\S]*?;\n/gm, '').replace('export class SleepTimer', 'class SleepTimer');
    const Timer = vm.runInNewContext(`${sleepSource}\nSleepTimer;`, {
        setInterval: h.scope.setInterval, clearInterval: h.scope.clearInterval,
        Date: { now: () => h.scope.performance.now() }, Logger: { info() {} },
    });
    h.p._startCrossfade(1);
    await settle();
    const sleep = new Timer(h.p);
    sleep.originalVolume = 0.8;
    sleep._startFade();
    h.outgoing.currentTime = 97.5;
    h.incoming.currentTime = 2.5;
    h.tick(7500);
    assert.equal(h.p.getVolume(), 0.4);
    h.tick(7500);
    assert.ok(Math.abs(h.outgoing.volume - 0.4 * Math.SQRT1_2) < 0.00001);
    assert.equal(h.storage.get('rainy_volume'), '0.8', 'sleep fading must not overwrite the saved preference');
    sleep.cancel();
    assert.equal(h.p.getVolume(), 0.8);
    h.p._cancelCrossfade();
});

test('normal initial buffering of the incoming stream does not cancel its play attempt', async () => {
    const h = harness();
    let resolvePlay;
    h.incoming.pendingPlay = new Promise(resolve => { resolvePlay = resolve; });
    h.p._bindAudioEvents(h.incoming);
    h.p._startCrossfade(1);
    h.incoming.emit('waiting');
    assert.equal(h.p._crossfading, true, 'loading the next stream is not a playback failure');
    resolvePlay();
    await settle();
    assert.equal(h.p._crossfadeSession.started, true);
    h.p._cancelCrossfade();
});

test('pressing pause stops the incoming deck immediately, before queued browser events', async () => {
    const h = harness();
    h.p._startCrossfade(1);
    await settle();
    h.p.togglePlayPause();
    assert.equal(h.incoming.paused, true);
    assert.equal(h.p._crossfading, false);
    assert.equal(h.outgoing.paused, true);
});

for (const action of ['previous', 'next', 'controller']) {
    test(`${action} cancels overlap before async work or browser events`, async () => {
        const h = harness();
        h.p._startCrossfade(1);
        await settle();
        if (action === 'previous') h.p.playPrevious();
        if (action === 'next') {
            h.p.radio = { noteSkip() {} };
            h.p._maybeExtendMix = () => new Promise(() => {});
            h.p.playNext();
        }
        if (action === 'controller') {
            h.p._showControllerBanner = () => {};
            h.p._controllerPoll = () => {};
            h.p._startControllerMode({ device_id: 'remote', device_name: 'Test remote' });
        }
        assert.equal(h.incoming.paused, true);
        assert.equal(h.p._crossfading, false);
    });
}

test('Connect reports the master volume, not the outgoing fade envelope', async () => {
    const h = harness();
    let snapshot;
    Object.assign(h.scope, { CONNECT_MAX_QUEUE: 500, connectWindowStart: () => 0,
        useConnectService: () => ({ heartbeat: payload => { snapshot = payload; return Promise.resolve({}); } }) });
    h.scope.window.app = { user: { id: 1 } };
    delete h.p._connectHeartbeat;
    h.p._connectDeviceId = 'isolated-test';
    h.p._connectEnsureStream = () => {};
    h.p._connectSongSummary = song => song;
    h.p._startCrossfade(1);
    await settle();
    h.outgoing.currentTime = 97.5;
    h.incoming.currentTime = 2.5;
    h.tick(2500);
    h.p._connectHeartbeat();
    assert.equal(snapshot.volume, 80);
    h.p._cancelCrossfade();
    await settle();
});

test('a failed incoming decoder falls back to normal ended auto-advance', async () => {
    const h = harness();
    let advances = 0;
    h.p.playNext = () => { advances++; };
    h.incoming.pendingPlay = Promise.reject(new Error('decode failed'));
    h.p._startCrossfade(1);
    await settle();
    assert.equal(h.p._crossfading, false);
    assert.equal(h.outgoing.volume, 0.8);
    h.outgoing.ended = true;
    h.p.handleEnded();
    assert.equal(advances, 1, 'the attempted flag must not swallow normal ended');
});

test('late fulfilment of a cancelled play cannot schedule a second fade driver', async () => {
    const h = harness();
    let resolveOld;
    h.incoming.pendingPlay = new Promise(resolve => { resolveOld = resolve; });
    h.p._startCrossfade(1);
    h.p._cancelCrossfade();
    h.incoming.pendingPlay = null;
    h.p._startCrossfade(2);
    await settle();
    resolveOld();
    await settle();
    assert.equal(h.timers.size, 1);
    assert.equal(h.frames.size, 0);
    h.p._cancelCrossfade();
    assert.equal(h.timers.size, 0);
});

test('incoming buffering after startup restores the outgoing stream and cannot repeat the intro', async () => {
    const h = harness();
    h.p._bindAudioEvents(h.incoming);
    h.p._startCrossfade(1);
    await settle();
    h.outgoing.currentTime = 97.5;
    h.incoming.currentTime = 2.5;
    h.tick(2500);
    h.incoming.emit('waiting');
    assert.equal(h.outgoing.volume, 0.8);
    assert.equal(h.incoming.paused, true);
    assert.equal(h.p._crossfading, false);
    h.p._checkCrossfade();
    assert.equal(h.incoming.playCalls, 1);
});

test('slow incoming startup fades over the remaining tail instead of locking the player', async () => {
    const h = harness();
    let resolvePlay;
    h.incoming.pendingPlay = new Promise(resolve => { resolvePlay = resolve; });
    h.p._startCrossfade(1);
    h.outgoing.currentTime = 98;
    resolvePlay();
    await settle();
    h.outgoing.currentTime = 99;
    h.incoming.currentTime = 1;
    h.tick(1000);
    assert.ok(Math.abs(h.outgoing.volume - 0.8 * Math.SQRT1_2) < 0.00001);
    h.outgoing.currentTime = 100;
    h.incoming.currentTime = 2;
    h.tick(2000);
    assert.equal(h.p.currentIndex, 1);
    assert.equal(h.p.audio.currentTime, 2);
});

test('consecutive handoffs alternate physical decks and leave no orphan fade driver', async () => {
    const h = harness();
    h.p._bindAudioEvents(h.outgoing);
    h.p._bindAudioEvents(h.incoming);
    h.p._startCrossfade(1);
    await settle();
    h.outgoing.currentTime = 100;
    h.incoming.currentTime = 5;
    h.tick(5000);
    h.p.audio.currentTime = 95;
    h.p._startCrossfade(2);
    await settle();
    h.p.audio.currentTime = 100;
    h.p.crossfadeAudio.currentTime = 5;
    h.tick(10000);
    assert.equal(h.p.audio, h.outgoing);
    assert.equal(h.p.currentIndex, 2);
    assert.equal(h.p.audio.currentTime, 5);
    assert.equal(h.timers.size, 0);
    assert.equal(h.p.crossfadeAudio.paused, true);
});
