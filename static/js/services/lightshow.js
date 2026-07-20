import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

export class LightshowService extends Service {
    constructor() {
        super('/api/music');
    }

    /**
     * @param {number} songId
     * @returns {Promise<Result<{ success: boolean, lightshow: object }, ErrorModel | ResponseError>>}
     */
    get(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lightshow`)));
    }

    /**
     * @param {number} songId
     * @param {object} data Pregenerated light show payload
     * @returns {Promise<Result<{ success: boolean }, ErrorModel | ResponseError>>}
     */
    save(songId, data) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lightshow`), {
            method: 'POST',
            body: data
        }));
    }

    /**
     * @param {number} songId
     * @returns {Promise<Result<{ success: boolean }, ErrorModel | ResponseError>>}
     */
    remove(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lightshow`), {
            method: 'DELETE'
        }));
    }
}

const __singleton = new LightshowService();

/**
 * @returns {LightshowService}
 */
export function useLightshowService() {
    return __singleton;
};
