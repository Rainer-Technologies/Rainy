import { RequestHelper } from "../helper/request.js";
import { Ok, Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} FriendModel
 * @property {number} id
 * @property {string} username
 * @property {string} email
 */

/**
 * @typedef {Object} FriendRequestModel
 * @property {number} id
 * @property {number} user_id
 * @property {string} username
 * @property {string} email
 */

/**
 * @typedef {Object} PlaylistInviteModel
 * @property {number} id
 * @property {number} playlist_id
 * @property {string} playlist_name
 * @property {string} invited_by_username
 */

export class FriendsService extends Service {
    constructor() {
        super('/api/friends');
    }

    /** @returns {Promise<Result<{friends: FriendModel[]}, ErrorModel>>} */
    friends() {
        return this.wrap(RequestHelper.request(this.url('')));
    }

    /** @returns {Promise<Result<{incoming: FriendRequestModel[], outgoing: FriendRequestModel[]}, ErrorModel>>} */
    requests() {
        return this.wrap(RequestHelper.request(this.url('/requests')));
    }

    /** @returns {Promise<Result<{invites: PlaylistInviteModel[]}, ErrorModel>>} */
    playlistInvites() {
        return this.wrap(RequestHelper.request('/api/playlists/invites'));
    }

    /** @returns {Promise<Result<{success: boolean, status: string, message: string}, ErrorModel>>} */
    sendRequest(identifier) {
        return this.wrap(RequestHelper.request(this.url('/requests'), {
            method: 'POST',
            body: { email: identifier }
        }));
    }

    /** @returns {Promise<Result<{success: boolean}, ErrorModel>>} */
    acceptRequest(requestId) {
        return this.wrap(RequestHelper.request(this.url(`/requests/${requestId}/accept`), {
            method: 'POST'
        }));
    }

    /** @returns {Promise<Result<{success: boolean}, ErrorModel>>} */
    declineRequest(requestId) {
        return this.wrap(RequestHelper.request(this.url(`/requests/${requestId}/decline`), {
            method: 'POST'
        }));
    }

    /** @returns {Promise<Result<{success: boolean}, ErrorModel>>} */
    async removeFriend(friendId) {
        const data = await this.wrap(RequestHelper.request(this.url(`/${friendId}`), {
            method: 'DELETE'
        }));
        if (data.error) return data;
        return Ok(data.value);
    }

    /** @returns {Promise<Result<{success: boolean}, ErrorModel>>} */
    acceptPlaylistInvite(shareId) {
        return this.wrap(RequestHelper.request(`/api/playlists/invites/${shareId}/accept`, {
            method: 'POST'
        }));
    }

    /** @returns {Promise<Result<{success: boolean}, ErrorModel>>} */
    declinePlaylistInvite(shareId) {
        return this.wrap(RequestHelper.request(`/api/playlists/invites/${shareId}/decline`, {
            method: 'POST'
        }));
    }
}

const __singleton = new FriendsService();

/**
 * @returns {FriendsService}
 */
export function useFriendsService() {
    return __singleton;
};