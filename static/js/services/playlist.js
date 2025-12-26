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
     * @returns {Promise<Result<{
     *  success: boolean;
     *  id: number;
     *  name: string;
     * }, ErrorModel | ResponseError>>} 
     */
    create(name) {
        return this.wrap(RequestHelper.request(this.url('/'), {
            method: 'POST',
            body: { name }
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

        if(data.error) return error;
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

        if(data.error) return error;
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

        if(data.error) return error;
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

        if(data.error) return error;
        return Ok(true);
    }
};