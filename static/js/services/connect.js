import { RequestHelper, ResponseError } from "../helper/request.js";
import { Service } from "./base.js";

/** Largest queue window a device advertises or receives in a command. */
export const CONNECT_MAX_QUEUE = 500;
// Tracks kept before the current one, and how far the current track moves
// before the window slides. Same numbers as the server's own windowing.
const QUEUE_LEAD = 50;
const QUEUE_STEP = 100;

// Connect is polled every second or two: a request that hangs (laptop sleep,
// network change) must give up, or the loop waiting on it never runs again.
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Where a CONNECT_MAX_QUEUE window around `index` starts in a queue of
 * `length` tracks. It only moves in steps, so advancing one track does not
 * produce a new window (and a re-upload) every time.
 * @param {number} length
 * @param {number} index
 * @returns {number}
 */
export function connectWindowStart(length, index) {
    if (length <= CONNECT_MAX_QUEUE) return 0;
    const start = Math.max(0, Math.floor((index - QUEUE_LEAD) / QUEUE_STEP) * QUEUE_STEP);
    return Math.min(start, length - CONNECT_MAX_QUEUE);
}

/** One vocabulary: the mobile app says 'off' where the web says 'none'. */
export function normalizeRepeat(mode) {
    return (mode === 'all' || mode === 'one') ? mode : 'none';
}

/**
 * A device's playback position right now. Its snapshot is `state_age`
 * seconds old by the server's clock, plus whatever passed since we received
 * it (`receivedAt`, a performance.now() stamp).
 * @param {ConnectDeviceModel} device
 * @param {number} [receivedAt]
 * @returns {number}
 */
export function connectLivePosition(device, receivedAt) {
    let position = Number(device?.position) || 0;
    if (device?.is_playing) {
        position += Number(device.state_age) || 0;
        if (receivedAt != null) position += Math.max(0, performance.now() - receivedAt) / 1000;
    }
    const duration = Number(device?.duration) || 0;
    return duration > 0 ? Math.min(duration, position) : position;
}

/**
 * @typedef {Object} ConnectDeviceModel
 * @property {string} device_id
 * @property {string} device_name
 * @property {string} device_type - 'web' | 'mobile' | ...
 * @property {number|null} song_id
 * @property {string|null} song_title
 * @property {string|null} song_artist
 * @property {string|null} song_album
 * @property {string|null} cover_path
 * @property {number} position
 * @property {number} duration
 * @property {boolean} is_playing
 * @property {number} volume - 0..100
 * @property {boolean} is_shuffled
 * @property {string} repeat_mode - 'none' | 'all' | 'one'
 * @property {Array<Object>} [queue] - window of the device's queue (absent when `queue_unchanged`)
 * @property {number} queue_index - current track, relative to `queue`
 * @property {number} queue_offset - where `queue` starts in the device's real queue
 * @property {number} queue_total - length of the device's real queue
 * @property {string} queue_hash - pass back to getDevice() to skip an unchanged queue
 * @property {boolean} [queue_unchanged]
 * @property {number} last_cmd_id - id of the last command the device applied
 * @property {number} state_age - seconds since this snapshot, by the server's clock
 * @property {boolean} online
 * @property {number} idle_for - seconds since the device last showed signs of life
 * @property {number} last_seen - epoch seconds
 */

/**
 * @typedef {Object} ConnectCommandModel
 * @property {string} command
 * @property {Object} [args]
 */

export class ConnectService extends Service {
    constructor() {
        super('/api/connect');
    }

    /** A wrapped request that gives up after REQUEST_TIMEOUT_MS. */
    _request(path, init = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        return this.wrap(RequestHelper.request(this.url(path), { ...init, signal: controller.signal }))
            .finally(() => clearTimeout(timer));
    }

    /**
     * True when the server answered that the thing does not exist / is not
     * available (a 4xx), as opposed to a request that did not get through.
     */
    static refused(result) {
        return !!result?.error && !(result.error instanceof ResponseError);
    }

    /**
     * Announce this device's playback state to the Connect hub.
     * @param {Object} payload - full device/state snapshot
     * @returns {Promise<import('../helper/result.js').Result<{ need_queue: boolean }, any>>}
     */
    heartbeat(payload) {
        return this._request('/heartbeat', { method: 'POST', body: payload });
    }

    /**
     * List active Connect devices.
     * @param {string} [excludeId] - omit this device from the results
     * @param {{ queues?: boolean, offline?: boolean }} [options] -
     *  `queues: false` leaves each device's queue out (fetch the one you need
     *  with getDevice); `offline: true` also lists devices that went quiet
     *  recently (`online` false)
     * @returns {Promise<import('../helper/result.js').Result<{ devices: ConnectDeviceModel[] }, any>>}
     */
    listDevices(excludeId = null, { queues = true, offline = false } = {}) {
        const params = [];
        if (excludeId) params.push(`exclude=${encodeURIComponent(excludeId)}`);
        if (!queues) params.push('queues=0');
        if (offline) params.push('offline=1');
        return this._request('/devices' + (params.length ? `?${params.join('&')}` : ''));
    }

    /**
     * Fetch a single device's latest state.
     * @param {string} deviceId
     * @param {string} [queueHash] - `queue_hash` of the queue already held;
     *  when it still matches, the device comes back with `queue_unchanged`
     *  instead of the queue
     * @returns {Promise<import('../helper/result.js').Result<{ device: ConnectDeviceModel }, any>>}
     */
    getDevice(deviceId, queueHash = '') {
        const query = queueHash ? `?queue_hash=${encodeURIComponent(queueHash)}` : '';
        return this._request(`/device/${encodeURIComponent(deviceId)}${query}`);
    }

    /**
     * Deregister a device (e.g. on page unload).
     * @param {string} deviceId
     */
    removeDevice(deviceId) {
        return this._request(`/device/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    }

    /**
     * Send a remote-control command to a device.
     * @param {string} deviceId
     * @param {string} command - play | pause | play_pause | next | previous |
     *  seek | volume | shuffle | repeat | play_song | play_queue | transfer
     * @param {Object} [args]
     * @returns {Promise<import('../helper/result.js').Result<{ command_id: number }, any>>}
     *  `command_id` shows up as the device's `last_cmd_id` once it applied it
     */
    sendCommand(deviceId, command, args = {}) {
        return this._request(`/device/${encodeURIComponent(deviceId)}/command`, {
            method: 'POST',
            body: { command, args }
        });
    }

    /**
     * URL of a device's command stream (server-sent events, `command`
     * events carrying {id, command, args}). The server pushes commands the
     * moment they are sent, and an open stream keeps the device listed as
     * online — neither depends on this page's timers, which browsers
     * throttle to one a minute in a background tab.
     * @param {string} deviceId
     * @param {number} [afterId] - last command id already applied
     * @returns {string}
     */
    streamUrl(deviceId, afterId = 0) {
        return this.url(`/stream?device_id=${encodeURIComponent(deviceId)}&after=${Number(afterId) || 0}`);
    }

    /**
     * Fetch (and clear) pending commands queued for a device.
     * @param {string} deviceId
     * @returns {Promise<import('../helper/result.js').Result<{ commands: ConnectCommandModel[] }, any>>}
     */
    pollCommands(deviceId) {
        return this._request(`/commands?device_id=${encodeURIComponent(deviceId)}`);
    }
}

const __singleton = new ConnectService();

/** @returns {ConnectService} */
export function useConnectService() {
    return __singleton;
}
