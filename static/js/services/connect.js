import { RequestHelper } from "../helper/request.js";
import { Service } from "./base.js";

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
 * @property {string} repeat_mode - 'off' | 'none' | 'all' | 'one'
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

    /**
     * Announce this device's playback state to the Connect hub.
     * @param {Object} payload - full device/state snapshot
     */
    heartbeat(payload) {
        return this.wrap(RequestHelper.request(this.url('/heartbeat'), {
            method: 'POST',
            body: payload
        }));
    }

    /**
     * List active Connect devices.
     * @param {string} [excludeId] - omit this device from the results
     * @returns {Promise<import('../helper/result.js').Result<{ devices: ConnectDeviceModel[] }, any>>}
     */
    listDevices(excludeId = null) {
        const query = excludeId ? `?exclude=${encodeURIComponent(excludeId)}` : '';
        return this.wrap(RequestHelper.request(this.url('/devices' + query)));
    }

    /**
     * Fetch a single device's latest state.
     * @param {string} deviceId
     * @returns {Promise<import('../helper/result.js').Result<{ device: ConnectDeviceModel }, any>>}
     */
    getDevice(deviceId) {
        return this.wrap(RequestHelper.request(this.url(`/device/${encodeURIComponent(deviceId)}`)));
    }

    /**
     * Deregister a device (e.g. on page unload).
     * @param {string} deviceId
     */
    removeDevice(deviceId) {
        return this.wrap(RequestHelper.request(this.url(`/device/${encodeURIComponent(deviceId)}`), {
            method: 'DELETE'
        }));
    }

    /**
     * Send a remote-control command to a device.
     * @param {string} deviceId
     * @param {string} command - play | pause | play_pause | next | previous |
     *  seek | volume | shuffle | repeat | play_song | transfer
     * @param {Object} [args]
     */
    sendCommand(deviceId, command, args = {}) {
        return this.wrap(RequestHelper.request(this.url(`/device/${encodeURIComponent(deviceId)}/command`), {
            method: 'POST',
            body: { command, args }
        }));
    }

    /**
     * Fetch (and clear) pending commands queued for a device.
     * @param {string} deviceId
     * @returns {Promise<import('../helper/result.js').Result<{ commands: ConnectCommandModel[] }, any>>}
     */
    pollCommands(deviceId) {
        return this.wrap(RequestHelper.request(this.url(`/commands?device_id=${encodeURIComponent(deviceId)}`)));
    }
}

const __singleton = new ConnectService();

/** @returns {ConnectService} */
export function useConnectService() {
    return __singleton;
}
