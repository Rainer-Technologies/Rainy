import { RequestHelper, ResponseError } from "../helper/request.js";
import { Ok, Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} PlaylistModel
 * @property {number} id
 * @property {string} name
 * @property {string} icon
 * @property {string} icon_color
 * @property {string} created_at
 */

export class PlaylistService extends Service {
    constructor() {
        super('/api/playlists');
    }

    /** @returns {Promise<Result<Array<PlaylistModel>, ErrorModel | ResponseError>>} */
    all() {
        return this.wrap(RequestHelper.request(this.url('/')));
    }

    /** 
     * @param {string} name
     * @param {string} icon - Icon identifier
     * @param {string} iconColor - Icon color hex
     * @returns {Promise<Result<{
     *  success: boolean;
     *  id: number;
     *  name: string;
     *  icon: string;
     *  icon_color: string;
     * }, ErrorModel | ResponseError>>} 
     */
    create(name, icon = 'music-note', iconColor = '#fa586a', privateFlag = false) {
        return this.wrap(RequestHelper.request(this.url('/'), {
            method: 'POST',
            body: { name, icon, icon_color: iconColor, private: !!privateFlag }
        }));
    }

    /**
     * @param {string} playlistId 
     * @returns {Promise<Result<PlaylistModel & {
     *  songs: Array<import('./music.js').SongModel>
     * }, ErrorModel | ResponseError>>}
     */
    fetch(playlistId) {
        return this.wrap(RequestHelper.request(this.url(`/${playlistId}`)));
    }

    /**
     * @param {string} playlistId 
     * @returns {Promise<Result<boolean, ErrorModel | ResponseError>>}
     */
    async delete(playlistId) {
        const data = await this.wrap(RequestHelper.request(this.url(`/${playlistId}`), {
            method: 'DELETE'
        }));

        if (data.error) return data;
        return Ok(true);
    }

    /**
     * @param {string} playlistId 
     * @returns {Promise<Result<boolean, ErrorModel | ResponseError>>}
     */
    async rename(playlistId, name) {
        const data = await this.wrap(RequestHelper.request(this.url(`/${playlistId}`), {
            method: 'PUT',
            body: { name }
        }));

        if (data.error) return data;
        return Ok(true);
    }

    /**
     * @param {string} playlistId 
     * @param {string} songId
     * @returns {Promise<Result<boolean, ErrorModel | ResponseError>>}
     */
    async addSong(playlistId, songId) {
        const data = await this.wrap(RequestHelper.request(this.url(`/${playlistId}/songs`), {
            method: 'POST',
            body: { song_id: songId }
        }));

        if (data.error) return data;
        return Ok(true);
    }

    /**
     * @param {string} playlistId 
     * @param {string} songId
     * @returns {Promise<Result<boolean, ErrorModel | ResponseError>>}
     */
    async removeSong(playlistId, songId) {
        const data = await this.wrap(RequestHelper.request(this.url(`/${playlistId}/songs/${songId}`), {
            method: 'DELETE'
        }));

        if (data.error) return data;
        return Ok(true);
    }

    /**
     * Update playlist icon and color
     * @param {string} playlistId 
     * @param {string} icon - Icon identifier
     * @param {string} iconColor - Icon color hex
     * @returns {Promise<Result<boolean, ErrorModel | ResponseError>>}
     */
    async updateAppearance(playlistId, icon, iconColor) {
        const data = await this.wrap(RequestHelper.request(this.url(`/${playlistId}`), {
            method: 'PUT',
            body: { icon, icon_color: iconColor }
        }));

        if (data.error) return data;
        return Ok(true);
    }

    /**
     * Reorder songs in a playlist (drag-and-drop)
     * @param {string|number} playlistId
     * @param {Array<number>} orderedTrackIds - Track IDs in the desired order
     * @returns {Promise<Result<boolean, ErrorModel | ResponseError>>}
     */
    async reorder(playlistId, orderedTrackIds) {
        const data = await this.wrap(RequestHelper.request(this.url(`/${playlistId}/reorder`), {
            method: 'POST',
            body: { ordered_track_ids: orderedTrackIds }
        }));

        if (data.error) return data;
        return Ok(true);
    }

    // ── Sharing ────────────────────────────────────────────────────

    /**
     * Everyone with a share on this playlist (owner only)
     * @param {number} playlistId
     * @returns {Promise<Result<{shares: Array<{id: number, user_id: number, username: string, role: string, status: string}>}, ErrorModel>>}
     */
    shares(playlistId) {
        return this.wrap(RequestHelper.request(this.url(`/${playlistId}/shares`)));
    }

    /**
     * Invite a friend to collaborate (owner only)
     * @param {number} playlistId
     * @param {number} friendUserId
     * @returns {Promise<Result<{success: boolean, message: string}, ErrorModel>>}
     */
    inviteFriend(playlistId, friendUserId) {
        return this.wrap(RequestHelper.request(this.url(`/${playlistId}/shares`), {
            method: 'POST',
            body: { user_id: friendUserId }
        }));
    }

    /**
     * Revoke a collaborator's access (owner only)
     * @param {number} playlistId
     * @param {number} shareId
     * @returns {Promise<Result<{success: boolean}, ErrorModel>>}
     */
    revokeShare(playlistId, shareId) {
        return this.wrap(RequestHelper.request(this.url(`/${playlistId}/shares/${shareId}`), {
            method: 'DELETE'
        }));
    }

    /**
     * Collaborator removes the shared playlist from their account
     * @param {number} playlistId
     * @returns {Promise<Result<{success: boolean}, ErrorModel>>}
     */
    leavePlaylist(playlistId) {
        return this.wrap(RequestHelper.request(this.url(`/${playlistId}/leave`), {
            method: 'POST'
        }));
    }
};

const __singleton = new PlaylistService();

/**
 * @returns {PlaylistService}
 */
export function usePlaylistService() {
    return __singleton;
};
