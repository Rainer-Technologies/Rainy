import { Logger } from "../helper/logger.js";
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

        this.watch('remote-id', (_path, _oldValue, newValue) => {
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
        if (remoteId) {
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

        if (this._devices.length === 0) {
            root.append(this._renderEmptyState());
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
        this._renderDeviceList();
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
            coverEl.innerHTML = remote.cover_path
                ? `<img src="/api/music/cover/${encodeURIComponent(remote.cover_path)}" alt="" onerror="this.remove()">`
                : '';
            coverEl.classList.toggle('empty', !remote.cover_path);
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
            return;
        }
        section.classList.remove('hidden');

        if (this._remoteQueueLabel.value) {
            this._remoteQueueLabel.value.textContent =
                `Queue (${queue.length} song${queue.length === 1 ? '' : 's'})`;
        }

        Array.from(list.children).forEach(el => el.remove());
        const currentIndex = Number(remote.queue_index) || 0;
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
    /* Commands                                                            */
    /* ------------------------------------------------------------------ */

    /** @param {string} command @param {Object} [args] */
    async _command(command, args = {}) {
        const deviceId = this.get('remote-id');
        if (!deviceId) return;
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
