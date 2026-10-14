// Real-browser smoke fixture. Evaluate on Rainy's origin (e.g. /manifest.json),
// then click Run. Uses generated WAV tones, no login, library mutation or Connect.
(async () => {
    const { AudioPlayer } = await import('/js/player.js?crossfade-smoke=' + Date.now());
    const { MixesView } = await import('/js/modules/mixes.js?crossfade-smoke=' + Date.now());
    document.body.innerHTML = '<button id="start">Run isolated crossfade audio test</button><pre id="result">Ready</pre><audio id="audio-player" preload="auto"></audio><audio id="crossfade-audio" preload="auto"></audio><div id="mixes-home"></div><div id="mixes-status"></div><div id="mix-detail"><div class="mix-track" data-song="1">Tone 1</div><div class="mix-track" data-song="2">Tone 2</div><div class="mix-track" data-song="3">Tone 3</div></div><div id="test-title"></div><div id="test-artist"></div>';
    const makeTone = hz => {
        const rate = 16000, count = rate * 4;
        const buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
        const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
        text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        text(36, 'data'); view.setUint32(40, count * 2, true);
        for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * hz * i / rate) * 3000, true);
        return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    };
    const p = Object.create(AudioPlayer.prototype);
    const tracks = [220, 330, 440].map((hz, i) => ({ id: i + 1, title: `Test tone ${hz}`, duration: 4, url: makeTone(hz) }));
    const outgoing = document.querySelector('#audio-player'), secondary = document.querySelector('#crossfade-audio');
    const node = () => document.createElement('span');
    Object.assign(p, {
        audio: outgoing, crossfadeAudio: secondary, playlist: tracks, currentIndex: 0, currentSong: tracks[0],
        _crossfadeEnabled: true, _crossfadeDuration: 1, _crossfading: false, _crossfadeTriggered: false,
        _eqEnabled: true, _eqGains: [3, 2, 1, 0, 0, 0, 0, 0, 0, 0], _eqFilters: [], repeatMode: 'none',
        abPointA: null, abPointB: null, isBuffering: false, isPlaying: false, saveThrottleMs: 5000,
        _listenTracker: { songId: 1, sync() {}, tick() {}, end() {}, begin(song) { this.songId = song.id; } },
        nowPlayingTitle: document.querySelector('#test-title'), nowPlayingArtist: document.querySelector('#test-artist'),
        iconPlay: node(), iconPause: node(), iconLoading: node(), nowPlayingArtwork: node(),
        playPauseBtn: document.createElement('button'), totalTimeEl: node(), currentTimeEl: node(), progressFill: node(),
        _streamUrl: song => song.url,
        updateNowPlaying: AudioPlayer.prototype.updateNowPlaying,
        ensureLikedDataInitialized: () => Promise.resolve(), updateReactionButtons() {},
        savePlaybackState() {}, _maybeExtendMix() {}, _connectHeartbeat() {}, clearAbRepeat() {},
        updateVolumeGradient() {}, updateFsVolumeGradient() {},
        playNext() {
            window.smoke.finished = true;
            document.querySelector('#result').textContent = JSON.stringify(window.smoke, null, 2);
        },
    });
    window.smoke = { ready: true, promotions: [], mediaErrors: [], finished: false };
    window.smokePlayer = p;
    window.smokeMixes = new MixesView({}, p);
    for (const audio of [outgoing, secondary]) {
        p._bindAudioEvents(audio);
        const play = audio.play.bind(audio), load = audio.load.bind(audio);
        audio.testPlays = 0; audio.testLoads = 0;
        audio.play = () => { audio.testPlays++; return play(); };
        audio.load = () => { audio.testLoads++; return load(); };
        audio.addEventListener('error', () => window.smoke.mediaErrors.push(audio.error?.message || 'media error'));
    }
    const complete = p._completeCrossfade.bind(p);
    p._completeCrossfade = (...args) => {
        const incoming = p.crossfadeAudio, position = incoming.currentTime;
        const loads = incoming.testLoads, plays = incoming.testPlays;
        complete(...args);
        window.smoke.promotions.push({
            to: p.currentIndex, sameDecoder: p.audio === incoming,
            positionBefore: position, positionAfter: p.audio.currentTime,
            extraLoads: incoming.testLoads - loads, extraPlays: incoming.testPlays - plays,
            paused: p.audio.paused,
            audibleDecks: [p.audio, p.crossfadeAudio].filter(audio => !audio.paused && audio.volume > 0.001).length,
            eqAttached: p._eqSource === p._eqGraphs.get(incoming)?.graph.source,
            mixHighlightedSong: Number(document.querySelector('#mix-detail .mix-track.playing')?.dataset.song || 0),
        });
        document.querySelector('#result').textContent = JSON.stringify(window.smoke, null, 2);
    };
    document.querySelector('#start').onclick = async () => {
        try {
            p._ensureEqGraph();
            outgoing.src = tracks[0].url;
            outgoing.volume = 0.5;
            p.updateNowPlaying(tracks[0]);
            await outgoing.play();
        } catch (error) { window.smoke.mediaErrors.push(String(error)); }
    };
    return { ready: true, playerModuleImported: true, connectStarted: false };
})()
