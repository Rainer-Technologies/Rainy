import { Logger } from "../helper/logger.js";
import { useCastService } from "../services/cast.js";
import { useConnectService } from "../services/connect.js";
import { I } from "./icon.js";
import { a, Component, H, h, on, Ref, useRef } from "./index.js";
import { Modal } from "./modal.js";

/**
 * Rainy Connect — device picker + remote control modal.
 *
 * Lists every active Connect device (excluding this player), lets the user
 * pick one as a remote-control target, and drives it via the Connect command
 * API. "Play here" hands playback back to this player by sending a
 * `transfer` command to the remote device.
 */
export class ConnectModal extends Component {
    static componentName = 'rainy-connect-modal';

    created() {
        /** @type {Ref<HTMLDivElement>} */
        this._deviceList = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._remotePanel = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._remotePlayBtn = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._remoteSeekFill = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._remoteTime = useRef(null);
        /** @type {Ref<HTMLInputElement>} */
        this._remoteVolume = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._remoteShuffleBtn = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._remoteRepeatBtn = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._transferBtn = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._remoteQueueSection = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._remoteQueueLabel = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._remoteQueueList = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._takeControlBtn = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._remoteSeekBar = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._remoteDeviceLabel = useRef(null);

        this._refreshTimer = null;
        this._tickTimer = null;
        this._seekDragging = false;
        this._seekPercent = null;
        this._volumeBusy = false;
        this._transferBusy = false;
        this._takeControlBusy = false;

        /** @type {Array<import('../services/connect.js').ConnectDeviceModel>} */
        this._devices = [];
        /** @type {import('../services/connect.js').ConnectDeviceModel | null} */
        this._remote = null;

        this.set('remote-id', null, { silent: true });

        // Rainy Cast (Chromecast) — the receiver is controlled directly by this
        // browser, so it's surfaced here alongside Rainy Connect devices.
        this._castTarget = false;      // the selected "remote" is the Chromecast
        this._pendingCast = false;     // waiting for a Cast session to connect
        this._wasCastConnected = false;
        this._lastCastListKey = '';    // throttle device-list rebuilds
        this._lastCoverSrc = null;     // avoid reloading cover art each tick
        this._lastQueueSignature = ''; // avoid rebuilding the queue each tick
        this._castUnsub = useCastService().onChange(() => this._onCastChange());

        this.watch('remote-id', (_path, oldValue, newValue) => {
            if (newValue !== oldValue) {
                // Force a full repaint when switching targets.
                this._lastCoverSrc = null;
                this._lastQueueSignature = '';
            }
            if (newValue) this._showRemotePanel();
            else this._hideRemotePanel();
        });

        // Commit seek drags even when the pointer is released outside the bar
        this._seekMoveHandler = (e) => {
            if (this._seekDragging) this._remoteSeekFromEvent(e);
        };
        this._seekEndHandler = () => {
            if (!this._seekDragging) return;
            this._seekDragging = false;
            const duration = this._remote?.duration || 0;
            if (duration && this._seekPercent != null) {
                this._command('seek', { position: Math.floor(this._seekPercent * duration) });
            }
        };
        window.addEventListener('mousemove', this._seekMoveHandler);
        window.addEventListener('touchmove', this._seekMoveHandler, { passive: true });
        window.addEventListener('mouseup', this._seekEndHandler);
        window.addEventListener('touchend', this._seekEndHandler);
    }

    destroyed() {
        this._stopTimers();
        this._castUnsub?.();
        window.removeEventListener('mousemove', this._seekMoveHandler);
        window.removeEventListener('touchmove', this._seekMoveHandler);
        window.removeEventListener('mouseup', this._seekEndHandler);
        window.removeEventListener('touchend', this._seekEndHandler);
    }

    show() {
        this.root.show();
        this._refresh();
        this._startTimers();
    }

    hide() {
        this._stopTimers();
        this.root.hide();
    }

    /* ------------------------------------------------------------------ */
    /* Polling                                                             */
    /* ------------------------------------------------------------------ */

    _startTimers() {
        this._stopTimers();
        // Refresh the device list / remote state every 5s while open
        this._refreshTimer = setInterval(() => this._refresh(), 5000);
        // Smooth seek-bar extrapolation between refreshes
        this._tickTimer = setInterval(() => this._tick(), 1000);
    }

    _stopTimers() {
        if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
        if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    }

    async _refresh() {
        const ownId = window.player?._connectDeviceId;
        const result = await useConnectService().listDevices(ownId);
        if (!result.error) {
            this._devices = result.value?.devices ?? [];
        }
        // On error keep the last known device list, but always (re)render so
        // "This Device" is present even before the first successful fetch.

        const remoteId = this.get('remote-id');
        if (remoteId === '__cast__') {
            // The Chromecast is the active target — refresh from Cast state.
            const cast = useCastService();
            if (!cast.state.connected) {
                this._castTarget = false;
                this.set('remote-id', null);
                this._remote = null;
            } else {
                this._castTarget = true;
                this._remote = this._castSnapshot();
            }
        } else if (remoteId) {
            const still = this._devices.find(d => d.device_id === remoteId);
            if (!still) {
                // Remote vanished — fall back to local control
                this.set('remote-id', null);
                this._remote = null;
                window.showToast?.('That device went offline', 'info');
            } else {
                this._remote = still;
            }
        }

        this._renderDeviceList();
        if (this.get('remote-id')) this._updateRemotePanel();
    }

    /** Extrapolate the remote seek bar between refreshes while playing. */
    _tick() {
        const remote = this._remote;
        if (!remote || this._seekDragging || this.get('remote-id') !== remote.device_id) return;
        if (!remote.is_playing || !remote.duration) return;

        const lastSeen = this._normalizeLastSeen(remote.last_seen);
        const elapsed = (Date.now() / 1000) - lastSeen;
        const position = Math.min(remote.duration, (remote.position || 0) + Math.max(0, elapsed));
        this._paintRemoteSeek(position, remote.duration);
    }

    /** Server may report last_seen as epoch seconds or ms — normalize to seconds. */
    _normalizeLastSeen(lastSeen) {
        const now = Date.now() / 1000;
        if (!lastSeen) return now;
        // Heuristic: values far beyond "now in seconds" are milliseconds
        return lastSeen > now * 2 ? lastSeen / 1000 : lastSeen;
    }

    /* ------------------------------------------------------------------ */
    /* Device list                                                         */
    /* ------------------------------------------------------------------ */

    _renderDeviceList() {
        const root = this._deviceList.value;
        if (!root) return;
        Array.from(root.children).forEach(el => el.remove());

        // "This Device" — always first, switches back to local control
        root.append(this._renderThisDeviceRow());

        let hasOther = false;

        // Chromecast — shown as soon as the Cast framework is ready (the
        // picker surfaces actual receivers), while a session is active, or in
        // a "blocked" state that explains why it can't initialize.
        const cast = useCastService();
        if (cast.sdkReady || cast.state.connected || cast.blocked) {
            root.append(this._renderCastRow(cast.state));
            hasOther = true;
        }

        if (this._devices.length === 0) {
            // Only show the empty hint when there's no Chromecast row either,
            // otherwise it contradicts the Cast option above it.
            if (!hasOther) root.append(this._renderEmptyState());
            return;
        }

        for (const device of this._devices) {
            root.append(this._renderDeviceRow(device));
        }
    }

    _renderThisDeviceRow() {
        const player = window.player;
        const song = player?.currentSong;
        const isLocal = !this.get('remote-id');

        const status = song
            ? `${song.title || 'Unknown'} — ${song.artist || 'Unknown Artist'}`
            : 'Idle';

        const row = h.button(a.type('button'),
            a.class('connect-device', 'connect-device-local', isLocal ? 'selected' : ''),
            on.click(() => this._selectLocal()),
            h.div(a.class('connect-device-icon'),
                I.Monitor('currentColor'),
                this._renderEqBars(player?.isPlaying)
            ),
            h.div(a.class('connect-device-info'),
                h.div(a.class('connect-device-name'),
                    'This Device',
                    h.span(a.class('connect-device-badge'), player?._connectDeviceName || 'Web Player')
                ),
                h.div(a.class('connect-device-song', song ? '' : 'idle'), status)
            ),
            h.div(a.class('connect-device-state'),
                isLocal
                    ? h.span(a.class('connect-playing-label'), 'Playing here')
                    : I.ArrowHeadRight('currentColor', a.class('connect-chevron'))
            )
        );

        if (song && player) {
            row.append(this._renderMiniProgress(player.audio?.currentTime || 0, player.audio?.duration || 0));
        }
        return row;
    }

    /**
     * The Chromecast row. When a Cast session exists it's the controlled
     * remote; otherwise tapping it opens Google's device picker. If the Cast
     * SDK can't initialize (insecure origin / unsupported browser) the row
     * shows why and is non-interactive.
     * @param {import('../services/cast.js').CastState} state
     */
    _renderCastRow(state) {
        const cast = useCastService();
        const selected = this._castTarget;
        const label = state.deviceName || 'Chromecast';
        let status;
        let disabled = false;
        let onClick = () => this._selectCast();

        if (state.connected) {
            status = state.song_title
                ? `${state.song_title} — ${state.song_artist || 'Unknown Artist'}`
                : 'Connected';
        } else if (cast.sdkReady) {
            status = state.connecting ? 'Connecting…' : 'Tap to connect';
        } else if (cast.blocked && cast.blockReason === 'insecure') {
            status = 'Needs HTTPS — use http://localhost or enable HTTPS';
            disabled = true;
            onClick = () => window.showToast?.(
                'Chrome withholds the Cast SDK on http:// (non-localhost). Open http://localhost:6969 or serve Rainy over HTTPS.', 'info');
        } else {
            status = 'Not supported in this browser';
            disabled = true;
            onClick = () => window.showToast?.('Casting is not supported in this browser.', 'info');
        }

        return h.button(a.type('button'),
            a.class('connect-device', 'connect-device-cast',
                selected ? 'selected' : '', state.connected ? 'connected' : '',
                disabled ? 'disabled' : ''),
            on.click(onClick),
            h.div(a.class('connect-device-icon'),
                I.Cast('currentColor'),
                this._renderEqBars(state.connected && state.is_playing)
            ),
            h.div(a.class('connect-device-info'),
                h.div(a.class('connect-device-name'),
                    label,
                    h.span(a.class('connect-device-badge'), 'Cast')
                ),
                h.div(a.class('connect-device-song', state.connected ? '' : 'idle'), status)
            ),
            h.div(a.class('connect-device-state'),
                selected
                    ? h.span(a.class('connect-playing-label'), 'Casting')
                    : I.ArrowHeadRight('currentColor', a.class('connect-chevron'))
            )
        );
    }

    /**
     * @param {import('../services/connect.js').ConnectDeviceModel} device
     */
    _renderDeviceRow(device) {
        const selected = this.get('remote-id') === device.device_id;
        const hasSong = !!device.song_title;

        const status = hasSong
            ? `${device.song_title} — ${device.song_artist || 'Unknown Artist'}`
            : 'Idle';

        const row = h.button(a.type('button'),
            a.class('connect-device', selected ? 'selected' : ''),
            on.click(() => this._selectRemote(device)),
            h.div(a.class('connect-device-icon'),
                this._deviceIcon(device.device_type),
                this._renderEqBars(device.is_playing)
            ),
            h.div(a.class('connect-device-info'),
                h.div(a.class('connect-device-name'), device.device_name || 'Unknown Device'),
                h.div(a.class('connect-device-song', hasSong ? '' : 'idle'), status)
            ),
            h.div(a.class('connect-device-state'),
                selected
                    ? h.span(a.class('connect-playing-label'), 'Controlling')
                    : I.ArrowHeadRight('currentColor', a.class('connect-chevron'))
            )
        );

        if (hasSong) {
            row.append(this._renderMiniProgress(device.position || 0, device.duration || 0));
        }
        return row;
    }

    _renderEmptyState() {
        return h.div(a.class('connect-empty'),
            h.div(a.class('connect-empty-icon'), I.Cast('currentColor')),
            h.div(a.class('connect-empty-title'), 'No other devices around'),
            h.div(a.class('connect-empty-text'),
                'Start playing music on your phone or another browser signed in to Rainy, and it will show up here — ready to control.')
        );
    }

    /** @param {string} type */
    _deviceIcon(type) {
        if (type === 'mobile') return I.Phone('currentColor');
        return I.Monitor('currentColor');
    }

    /** Animated equalizer bars shown while a device is playing. */
    _renderEqBars(active) {
        return h.span(a.class('connect-eq', active ? 'active' : ''),
            h.i(), h.i(), h.i()
        );
    }

    _renderMiniProgress(position, duration) {
        const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
        return h.div(a.class('connect-device-progress'),
            h.div(a.class('connect-device-progress-fill'), a.style(`width: ${percent}%`))
        );
    }

    /* ------------------------------------------------------------------ */
    /* Selection                                                           */
    /* ------------------------------------------------------------------ */

    _selectLocal() {
        this._remote = null;
        this.set('remote-id', null);
        // Exit controller mode if active — user wants to listen on this device
        const player = window.player;
        if (player?.isControllerMode) player._stopControllerMode();
        // Handing back to this device stops any active Chromecast session.
        if (this._castTarget) {
            this._castTarget = false;
            useCastService().endSession();
        }
        this._renderDeviceList();
    }

    /** Select the Chromecast as the controlled remote (or connect to one). */
    _selectCast() {
        const cast = useCastService();
        if (cast.state.connected) {
            this._castTarget = true;
            this._remote = this._castSnapshot();
            this.set('remote-id', '__cast__');
            this._renderDeviceList();
            this._updateRemotePanel();
            return;
        }
        // Open Google's device picker; _onCastChange takes over on connect.
        this._pendingCast = true;
        cast.requestSession();
    }

    /** @param {import('../services/connect.js').ConnectDeviceModel} device */
    _selectRemote(device) {
        this._remote = device;
        this.set('remote-id', device.device_id);
        this._renderDeviceList();
        this._updateRemotePanel();
    }

    /* ------------------------------------------------------------------ */
    /* Remote control panel                                                */
    /* ------------------------------------------------------------------ */

    _showRemotePanel() {
        this._remotePanel.value?.classList.remove('hidden');
    }

    _hideRemotePanel() {
        this._remotePanel.value?.classList.add('hidden');
    }

    _updateRemotePanel() {
        const remote = this._remote;
        if (!remote) return;

        // Section label with the remote's name
        if (this._remoteDeviceLabel.value) {
            this._remoteDeviceLabel.value.textContent = remote.device_name || 'Unknown Device';
        }

        // Now-playing card
        const titleEl = this._remotePanel.value?.querySelector('.connect-remote-title');
        const artistEl = this._remotePanel.value?.querySelector('.connect-remote-artist');
        const coverEl = this._remotePanel.value?.querySelector('.connect-remote-cover');
        if (titleEl) titleEl.textContent = remote.song_title || 'Nothing playing';
        if (artistEl) artistEl.textContent = remote.song_artist
            ? `${remote.song_artist}${remote.song_album ? ' · ' + remote.song_album : ''}`
            : (remote.song_album || 'Idle');
        if (coverEl) {
            const coverSrc = remote.cover_url
                || (remote.cover_path ? `/api/music/cover/${encodeURIComponent(remote.cover_path)}` : null);
            // Only rebuild the <img> when the source actually changes, so
            // frequent state ticks don't reload the artwork.
            if (coverSrc !== this._lastCoverSrc) {
                this._lastCoverSrc = coverSrc;
                coverEl.innerHTML = coverSrc
                    ? `<img src="${coverSrc}" alt="" onerror="this.remove()">`
                    : '';
                coverEl.classList.toggle('empty', !coverSrc);
            }
        }

        // Play/pause button
        this._paintRemotePlayBtn(remote.is_playing);

        // Seek bar + time
        this._paintRemoteSeek(remote.position || 0, remote.duration || 0);

        // Volume (don't fight the user while they're dragging)
        const volumeSlider = this._remoteVolume.value;
        if (volumeSlider && document.activeElement !== volumeSlider) {
            const v = Math.max(0, Math.min(100, remote.volume ?? 80));
            volumeSlider.value = v;
            volumeSlider.style.setProperty('--volume-percent', `${v}%`);
        }

        // Shuffle / repeat state
        this._remoteShuffleBtn.value?.classList.toggle('active', !!remote.is_shuffled);
        this._paintRepeatBtn(remote.repeat_mode);

        // Transfer button — only makes sense while this player has a song
        const song = window.player?.currentSong;
        if (this._transferBtn.value) {
            this._transferBtn.value.classList.toggle('hidden', !song);
        }

        // Remote queue (tap-to-play) + Take Control availability
        this._updateRemoteQueue();

        // "Take Control" is redundant for the Chromecast — it's already
        // controlled directly from this browser.
        if (this._castTarget) this._takeControlBtn.value?.classList.add('hidden');
    }

    _paintRemotePlayBtn(isPlaying) {
        const btn = this._remotePlayBtn.value;
        if (!btn) return;
        btn.title = isPlaying ? 'Pause' : 'Play';
        btn.innerHTML = '';
        btn.append(isPlaying ? I.Pause('currentColor') : I.Play('currentColor'));
    }

    _paintRemoteSeek(position, duration) {
        const fill = this._remoteSeekFill.value;
        const timeEl = this._remoteTime.value;
        const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
        if (fill) fill.style.width = `${percent}%`;
        if (timeEl) timeEl.textContent = `${this._formatTime(position)} / ${this._formatTime(duration)}`;
    }

    _paintRepeatBtn(mode) {
        const btn = this._remoteRepeatBtn.value;
        if (!btn) return;
        const normalized = this._normalizeRepeat(mode);
        btn.classList.toggle('active', normalized !== 'none');
        btn.title = `Repeat: ${normalized === 'none' ? 'off' : normalized}`;
        btn.innerHTML = '';
        const svg = I.Loop('currentColor');
        btn.append(svg);
        // Badge for repeat-one
        const badge = btn.querySelector('.connect-repeat-one');
        if (badge) badge.remove();
        if (normalized === 'one') {
            const one = h.span(a.class('connect-repeat-one'), '1');
            btn.append(one);
        }
    }

    /** Server may report 'off' or 'none' — normalize to player modes. */
    _normalizeRepeat(mode) {
        if (mode === 'all' || mode === 'one') return mode;
        return 'none';
    }

    /* ------------------------------------------------------------------ */
    /* Remote queue                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Rebuild the remote's queue list. Called from _updateRemotePanel so the
     * queue tracks every refresh / optimistic echo. The whole section hides
     * when the remote has no queue.
     */
    _updateRemoteQueue() {
        const section = this._remoteQueueSection.value;
        const list = this._remoteQueueList.value;
        if (!section || !list) return;

        const remote = this._remote;
        const queue = Array.isArray(remote?.queue) ? remote.queue : [];
        if (!queue.length) {
            section.classList.add('hidden');
            this._lastQueueSignature = '';
            return;
        }
        section.classList.remove('hidden');

        if (this._remoteQueueLabel.value) {
            this._remoteQueueLabel.value.textContent =
                `Queue (${queue.length} song${queue.length === 1 ? '' : 's'})`;
        }

        const currentIndex = Number(remote.queue_index) || 0;
        // Skip the (expensive) DOM rebuild when the queue is unchanged, so
        // frequent Cast state ticks don't thrash the list.
        const signature = `${queue.length}:${currentIndex}:${queue.map(s => s?.id).join(',')}`;
        if (signature === this._lastQueueSignature) return;
        this._lastQueueSignature = signature;

        Array.from(list.children).forEach(el => el.remove());
        queue.forEach((song, index) => {
            list.append(this._renderQueueRow(song, index, index === currentIndex));
        });

        // Take Control is always available when a remote is selected
        this._takeControlBtn.value?.classList.remove('hidden');
    }

    /** One tappable row in the remote queue. */
    _renderQueueRow(song, index, isCurrent) {
        return h.button(a.type('button'),
            a.class('connect-queue-item', isCurrent ? 'current' : ''),
            a.title(isCurrent ? 'Playing on remote' : `Play "${song?.title || 'Unknown'}" on remote`),
            on.click(() => this._playQueueSong(song)),
            h.span(a.class('connect-queue-index'),
                isCurrent
                    ? this._renderEqBars(true)
                    : String(index + 1)
            ),
            h.span(a.class('connect-queue-info'),
                h.span(a.class('connect-queue-title'), song?.title || 'Unknown'),
                h.span(a.class('connect-queue-artist'), song?.artist || 'Unknown Artist')
            ),
            h.span(a.class('connect-queue-play'), I.Play('currentColor'))
        );
    }

    /** Tap-to-play: tell the remote to jump to this song. */
    _playQueueSong(song) {
        if (song?.id == null) return;
        this._command('play_song', { song_id: song.id });
    }

    _formatTime(seconds) {
        const s = Math.max(0, Math.floor(seconds || 0));
        const mins = Math.floor(s / 60);
        const secs = s % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    /* ------------------------------------------------------------------ */
    /* Rainy Cast (Chromecast)                                             */
    /* ------------------------------------------------------------------ */

    /** React to Cast SDK state changes (connection, transport, metadata). */
    _onCastChange() {
        const cast = useCastService();
        const s = cast.state;
        const connected = s.connected;

        // Freshly connected → load the current queue and take over the modal.
        if (connected && !this._wasCastConnected) {
            this._startCasting();
        }
        this._wasCastConnected = connected;

        // Session ended while we were controlling it — fall back to local.
        if (!connected && this._castTarget) {
            this._castTarget = false;
            this._remote = null;
            this.set('remote-id', null);
        }

        // Rebuild the device list only when discovery/connection state changes,
        // not on every ~1s position tick (which would thrash the DOM).
        const listKey = `${s.available}|${connected}|${s.connecting}|${s.deviceName}`;
        if (listKey !== this._lastCastListKey) {
            this._lastCastListKey = listKey;
            if (this._deviceList.value) this._renderDeviceList();
        }

        if (this._castTarget && connected) {
            this._remote = this._castSnapshot();
            this._updateRemotePanel();
        }
    }

    /** Load the player's current queue onto the receiver and select it. */
    _startCasting() {
        const player = window.player;
        const cast = useCastService();
        const queue = (player?.playlist || []).slice(0, 200);
        const index = Math.max(0, player?.currentIndex || 0);
        const position = player?.audio ? Math.floor(player.audio.currentTime || 0) : 0;
        if (queue.length) cast.loadQueue(queue, index, position);

        this._castTarget = true;
        this._pendingCast = false;
        this._remote = this._castSnapshot();
        this.set('remote-id', '__cast__');
        this._renderDeviceList();
        this._updateRemotePanel();
    }

    /** Build a Connect-device-shaped snapshot from live Cast state. */
    _castSnapshot() {
        const s = useCastService().state;
        const player = window.player;
        const song = player?.currentSong;
        const queue = (player?.playlist || []).slice(0, 200).map(q => ({
            id: q?.id ?? null,
            title: q?.title ?? null,
            artist: q?.artist ?? null,
            album: q?.album ?? null,
            cover_path: q?.cover_path ?? null,
        }));
        return {
            device_id: '__cast__',
            device_name: s.deviceName || 'Chromecast',
            device_type: 'cast',
            song_id: song?.id ?? null,
            song_title: s.song_title || song?.title || null,
            song_artist: s.song_artist || song?.artist || null,
            song_album: s.song_album || song?.album || null,
            cover_url: s.cover_url || null,
            cover_path: song?.cover_path || null,
            position: s.position || 0,
            duration: s.duration || song?.duration || 0,
            is_playing: s.is_playing,
            volume: s.volume ?? 100,
            is_shuffled: false,
            repeat_mode: 'none',
            queue,
            queue_index: Math.max(0, player?.currentIndex || 0),
            last_seen: Date.now() / 1000,
        };
    }

    /** Route a transport command to the Chromecast. */
    _castCommand(command, args = {}) {
        const cast = useCastService();
        switch (command) {
            case 'play_pause': cast.playPause(); break;
            case 'play': cast.play(); break;
            case 'pause': cast.pause(); break;
            case 'seek': cast.seek(Number(args.position) || 0); break;
            case 'volume': cast.setVolume(Number(args.volume) ?? 100); break;
            case 'shuffle': cast.setShuffle(!!args.enabled); break;
            case 'repeat': cast.setRepeat(args.mode || 'none'); break;
            case 'next': cast.next(); break;
            case 'previous': cast.previous(); break;
            case 'play_song': this._castPlaySong(args.song_id); break;
        }
        // Optimistic echo so the UI feels instant; real state arrives via events.
        if (this._remote) {
            if (command === 'play_pause') this._remote.is_playing = !this._remote.is_playing;
            if (command === 'play') this._remote.is_playing = true;
            if (command === 'pause') this._remote.is_playing = false;
            if (command === 'seek') this._remote.position = Number(args.position) || 0;
            if (command === 'volume') this._remote.volume = Number(args.volume) ?? this._remote.volume;
            this._remote.last_seen = Date.now() / 1000;
            this._updateRemotePanel();
        }
    }

    /** Jump the Chromecast queue to a specific song. */
    _castPlaySong(songId) {
        const player = window.player;
        const queue = (player?.playlist || []).slice(0, 200);
        const index = queue.findIndex(s => Number(s?.id) === Number(songId));
        if (index < 0) return;
        useCastService().loadQueue(queue, index, 0);
    }

    /* ------------------------------------------------------------------ */
    /* Commands                                                            */
    /* ------------------------------------------------------------------ */

    /** @param {string} command @param {Object} [args] */
    async _command(command, args = {}) {
        const deviceId = this.get('remote-id');
        if (!deviceId) return;

        // The Chromecast is driven directly, not via the Connect hub.
        if (this._castTarget) {
            this._castCommand(command, args);
            return;
        }

        const result = await useConnectService().sendCommand(deviceId, command, args);
        if (result.error) {
            Logger.warn('Connect command failed:', command, result.error);
            window.showToast?.('Device did not respond', 'error');
            return;
        }
        // Optimistic local echo so the UI feels instant
        if (this._remote) {
            switch (command) {
                case 'play_pause': this._remote.is_playing = !this._remote.is_playing; break;
                case 'play': this._remote.is_playing = true; break;
                case 'pause': this._remote.is_playing = false; break;
                case 'seek': this._remote.position = Number(args.position) || 0; break;
                case 'volume': this._remote.volume = Number(args.volume) ?? this._remote.volume; break;
                case 'shuffle': this._remote.is_shuffled = !!args.enabled; break;
                case 'repeat': this._remote.repeat_mode = args.mode; break;
            }
            this._remote.last_seen = Date.now() / 1000;
            this._updateRemotePanel();
        }
    }

    _toggleRemotePlay() {
        this._command('play_pause');
    }

    _remoteSeekFromEvent(e) {
        const bar = this._remoteSeekBar.value;
        if (!bar) return;
        const rect = bar.getBoundingClientRect();
        const clientX = e.touches?.length ? e.touches[0].clientX : e.clientX;
        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        this._seekPercent = percent;
        const duration = this._remote?.duration || 0;
        this._paintRemoteSeek(percent * duration, duration);
    }

    _remoteVolumeChange(e) {
        const value = Number(e.target.value);
        e.target.style.setProperty('--volume-percent', `${value}%`);
        if (this._remote) this._remote.volume = value;
    }

    _remoteVolumeCommit(e) {
        this._command('volume', { volume: Number(e.target.value) });
    }

    _toggleRemoteShuffle() {
        this._command('shuffle', { enabled: !this._remote?.is_shuffled });
    }

    _cycleRemoteRepeat() {
        const order = ['none', 'all', 'one'];
        const current = this._normalizeRepeat(this._remote?.repeat_mode);
        const next = order[(order.indexOf(current) + 1) % order.length];
        this._command('repeat', { mode: next });
    }

    /**
     * Hand playback from the remote device to this player: tell the remote
     * to transfer (it stops and reports the song), then start it locally at
     * the same position.
     */
    async _transferHere() {
        if (this._transferBusy) return;
        const remote = this._remote;
        const player = window.player;
        if (!remote || !player) return;

        this._transferBusy = true;
        this._transferBtn.value?.classList.add('busy');
        try {
            // Pulling back from a Chromecast: stop the session and resume the
            // same queue locally at the receiver's current position.
            if (this._castTarget) {
                const position = Number(remote.position) || 0;
                const queue = (player.playlist || []).slice(0, 200);
                const index = Math.max(0, player.currentIndex || 0);
                await useCastService().endSession();
                this._castTarget = false;
                if (queue.length) {
                    player._connectPlayQueueObjects(queue, index, position);
                } else if (player.currentSong?.id != null) {
                    await player._connectPlaySongById(player.currentSong.id, position);
                }
                this._selectLocal();
                window.showToast?.('Playing here — Chromecast handed off', 'success');
                return;
            }

            const position = Number(remote.position) || Math.floor(player.audio?.currentTime || 0);

            // Build the full queue from the remote's reported queue
            const remoteQueue = Array.isArray(remote.queue) ? remote.queue : [];
            const remoteIndex = Number(remote.queue_index) || 0;

            if (remoteQueue.length > 0) {
                // Send full queue + index + position to the remote (so it can stop cleanly)
                await useConnectService().sendCommand(remote.device_id, 'transfer', {
                    song_id: remote.song_id ?? null,
                    position,
                });

                // Play the full queue here at the same index and position
                player._connectPlayQueueObjects(remoteQueue, remoteIndex, position);
            } else {
                // Fallback: single song transfer
                const songId = remote.song_id ?? player.currentSong?.id;
                if (songId == null) {
                    window.showToast?.('Nothing to transfer', 'info');
                    return;
                }
                await useConnectService().sendCommand(remote.device_id, 'transfer', {
                    song_id: songId,
                    position,
                });
                await player._connectPlaySongById(songId, position);
            }

            // Back to local control
            this._selectLocal();
            window.showToast?.(`Playing here — ${remote.device_name} handed off`, 'success');
        } catch (e) {
            Logger.warn('Connect transfer failed:', e);
            window.showToast?.('Transfer failed', 'error');
        } finally {
            this._transferBusy = false;
            this._transferBtn.value?.classList.remove('busy');
        }
    }

    /**
     * Enter Controller Mode: this player becomes a pure remote control for
     * the selected device — local audio stops and the player bar mirrors
     * the remote's state until the user hits Stop.
     */
    async _takeControl() {
        if (this._takeControlBusy) return;
        const remote = this._remote;
        const player = window.player;
        if (!remote || !player) return;

        this._takeControlBusy = true;
        this._takeControlBtn.value?.classList.add('busy');
        try {
            player._startControllerMode({
                device_id: remote.device_id,
                device_name: remote.device_name || 'Unknown Device'
            });
            // Close the modal — the player bar now shows the remote's state
            this.hide();
        } catch (e) {
            Logger.warn('Connect take-control failed:', e);
            window.showToast?.('Could not take control', 'error');
        } finally {
            this._takeControlBusy = false;
            this._takeControlBtn.value?.classList.remove('busy');
        }
    }

    /* ------------------------------------------------------------------ */
    /* Render                                                              */
    /* ------------------------------------------------------------------ */

    render() {
        const root = this.root = H.of(Modal,
            I.Cast('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), 'Rainy Connect'),
            h.p(a.slot('header-subtitle'), 'Play and control music on your devices'),
            h.div(a.slot('body'), a.class('connect-body'),
                h.div(a.class('connect-section-label'), 'Listen on'),
                h.div(this._deviceList, a.class('connect-devices')),

                h.div(this._remotePanel, a.class('connect-remote', 'hidden'),
                    h.div(a.class('connect-section-label'),
                        'Controlling',
                        h.span(this._remoteDeviceLabel, a.class('connect-section-label-name'))
                    ),
                    h.div(a.class('connect-remote-nowplaying'),
                        h.div(a.class('connect-remote-cover', 'empty')),
                        h.div(a.class('connect-remote-info'),
                            h.div(a.class('connect-remote-title'), 'Nothing playing'),
                            h.div(a.class('connect-remote-artist'), 'Idle')
                        )
                    ),
                    h.div(a.class('connect-remote-seek-row'),
                        h.div(this._remoteSeekBar, a.class('connect-remote-seek'),
                            on.mousedown((e) => {
                                this._seekDragging = true;
                                this._remoteSeekFromEvent(e);
                            }),
                            on.touchstart((e) => {
                                this._seekDragging = true;
                                this._remoteSeekFromEvent(e);
                            }),
                            h.div(a.class('connect-remote-seek-fill'), this._remoteSeekFill)
                        ),
                        h.span(this._remoteTime, a.class('connect-remote-time'), '0:00 / 0:00')
                    ),
                    h.div(a.class('connect-remote-controls'),
                        h.button(a.type('button'), a.class('connect-ctrl'), a.title('Shuffle'),
                            this._remoteShuffleBtn,
                            on.click(() => this._toggleRemoteShuffle()),
                            I.Shuffle('currentColor')
                        ),
                        h.button(a.type('button'), a.class('connect-ctrl'), a.title('Previous'),
                            on.click(() => this._command('previous')),
                            I.Back('currentColor')
                        ),
                        h.button(a.type('button'), a.class('connect-ctrl', 'connect-ctrl-main'), a.title('Play'),
                            this._remotePlayBtn,
                            on.click(() => this._toggleRemotePlay()),
                            I.Play('currentColor')
                        ),
                        h.button(a.type('button'), a.class('connect-ctrl'), a.title('Next'),
                            on.click(() => this._command('next')),
                            I.Next('currentColor')
                        ),
                        h.button(a.type('button'), a.class('connect-ctrl'), a.title('Repeat'),
                            this._remoteRepeatBtn,
                            on.click(() => this._cycleRemoteRepeat()),
                            I.Loop('currentColor')
                        )
                    ),
                    h.div(a.class('connect-remote-volume'),
                        I.VolumeFull('currentColor'),
                        h.input(this._remoteVolume, a.type('range'), a.class('connect-volume-slider'),
                            a.min('0'), a.max('100'), a.value('80'),
                            on.input((e) => this._remoteVolumeChange(e)),
                            on.change((e) => this._remoteVolumeCommit(e))
                        )
                    ),
                    h.div(this._remoteQueueSection, a.class('connect-remote-queue', 'hidden'),
                        h.div(a.class('connect-section-label'),
                            h.span(this._remoteQueueLabel, a.class('connect-queue-count'), 'Queue')
                        ),
                        h.div(this._remoteQueueList, a.class('connect-queue-list'))
                    ),
                    h.div(a.class('connect-remote-actions'),
                        h.button(a.type('button'), a.class('btn', 'btn-primary', 'connect-transfer'),
                            this._transferBtn,
                            on.click(() => this._transferHere()),
                            I.Cast('currentColor'),
                            h.span(a.class('connect-transfer-label'), 'Play here')
                        ),
                        h.button(a.type('button'), a.class('btn', 'connect-take-control', 'hidden'),
                            this._takeControlBtn,
                            a.title('Control this device from here'),
                            on.click(() => this._takeControl()),
                            I.Import('currentColor'),
                            h.span(a.class('connect-take-control-label'), 'Take Control')
                        )
                    )
                )
            )
        );

        return root;
    }
};

customElements.define(ConnectModal.componentName, ConnectModal);
