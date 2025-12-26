import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} SongModel
 * @property {string} videoId
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {string} year
 * @property {number} duration
 * @property {string} duration_text
 * @property {string} cover_url
 */

/**
 * @typedef {Object} SearchModel
 * @property {boolean} success
 * @property {Array<SongModel>} results
 */

/**
 * @typedef {Object} ApplyModel
 * @property {boolean} success
 * @property {string} message
 * @property {import('./music.js').SongModel} song
 */

export class MetadataService extends Service {
    constructor() {
        super('/api/music');
    }

    /**
     * @param {string} query
     * @returns {Promise<Result<SearchModel, ErrorModel | ResponseError>>}
     */
    search(query) {
        return this.wrap(RequestHelper.request(this.url('/metadata/search'), {
            method: 'POST',
            body: { query }
        }));
    }

    /**
     * @param {string} songId 
     * @param {string} title 
     * @param {string} artist 
     * @param {string} album 
     * @param {string} year 
     * @param {string} genre 
     * @param {string} coverUrl 
     * @returns {Promise<Result<ApplyModel, ErrorModel | ResponseError>>}
     */
    apply(songId, title, artist, album, year, genre, coverUrl) {
        return this.wrap(RequestHelper.request(this.url(`/metadata/apply/${songId}`), {
            method: 'POST',
            body: { title, artist, album, year, genre, cover_url: coverUrl }
        }));
    }
};

const __singleton = new MetadataService();

/**
 * @returns {MetadataService}
 */
export function useMetadataService() {
    return __singleton;
};