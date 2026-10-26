import { RequestHelper } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} ListenSessionModel
 * @property {number} id
 * @property {'live'|'ended'} status
 * @property {'host'|'guest'} role
 * @property {'host'|'invited'|'joined'|'left'} state - the viewer's own state
 * @property {{id: number, username: string}} host
 * @property {{id: number, username: string, state: 'invited'|'joined'}[]} members
 * @property {{id: number, title: string, artist: string, album: string, cover_path: string}|null} song
 * @property {boolean} playing
 * @property {number} position - seconds, where the host's playback is now
 * @property {number} state_seq - moves when the host changes song, play state or place
 * @property {boolean} host_live
 * @property {number} host_age - seconds since the host's device last reported
 * @property {number} version
 */

export class ListenService extends Service {
    constructor() {
        super('/api/listen');
    }

    /**
     * Open the host's session on this device and invite a friend.
     * @returns {Promise<Result<{session: ListenSessionModel}, ErrorModel>>}
     */
    invite(friendId, deviceId) {
        return this.wrap(RequestHelper.request(this.url('/invite'), {
            method: 'POST',
            body: { friend_id: friendId, device_id: deviceId },
        }));
    }

    /** @returns {Promise<Result<{session: ListenSessionModel}, ErrorModel>>} */
    get(sessionId) {
        return this.wrap(RequestHelper.request(this.url(`/${sessionId}`)));
    }

    /** @returns {Promise<Result<{session: ListenSessionModel}, ErrorModel>>} */
    join(sessionId) {
        return this.wrap(RequestHelper.request(this.url(`/${sessionId}/join`), { method: 'POST' }));
    }

    /** Leave, or decline the invitation. */
    leave(sessionId) {
        return this.wrap(RequestHelper.request(this.url(`/${sessionId}/leave`), { method: 'POST' }));
    }

    /** End the session for everyone (host only). */
    end(sessionId) {
        return this.wrap(RequestHelper.request(this.url(`/${sessionId}/end`), { method: 'POST' }));
    }
}

const __singleton = new ListenService();

/**
 * @returns {ListenService}
 */
export function useListenService() {
    return __singleton;
};
