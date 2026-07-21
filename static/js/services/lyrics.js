import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} LyricsCandidate
 * @property {number} id
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number} duration
 * @property {boolean} synced
 * @property {string} snippet
 */

/**
 * @typedef {Object} SearchModel
 * @property {boolean} success
 * @property {Array<LyricsCandidate>} results
 */

/**
 * @typedef {Object} LyricsModel
 * @property {boolean} success
 * @property {{ synced: Array<{time: number, text: string}>, plain: string }} lyrics
 */

export class LyricsService extends Service {
    constructor() {
        super('/api/music');
    }

    /**
     * @param {string | number} songId
     * @returns {Promise<Result<LyricsModel, ErrorModel | ResponseError>>}
     */
    get(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lyrics`)));
    }

    /**
     * Force an automatic LRCLIB fetch and cache the result.
     * @param {string | number} songId
     * @returns {Promise<Result<LyricsModel, ErrorModel | ResponseError>>}
     */
    fetch(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lyrics?refresh=1`)));
    }

    /**
     * @param {string} query
     * @returns {Promise<Result<SearchModel, ErrorModel | ResponseError>>}
     */
    search(query) {
        return this.wrap(RequestHelper.request(this.url('/lyrics/search'), {
            method: 'POST',
            body: { query }
        }));
    }

    /**
     * @param {string | number} songId
     * @param {number} lrclibId
     * @returns {Promise<Result<LyricsModel, ErrorModel | ResponseError>>}
     */
    apply(songId, lrclibId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lyrics`), {
            method: 'POST',
            body: { lrclib_id: lrclibId }
        }));
    }

    /**
     * @param {string | number} songId
     * @returns {Promise<Result<{ success: boolean }, ErrorModel | ResponseError>>}
     */
    remove(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lyrics`), {
            method: 'DELETE'
        }));
    }
};

const __singleton = new LyricsService();

/**
 * @returns {LyricsService}
 */
export function useLyricsService() {
    return __singleton;
};
