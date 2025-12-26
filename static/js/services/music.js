import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} SongModel
 * @property {number} id
 * @property {string} path
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {string} duration
 * @property {number} track
 * @property {string} year
 * @property {string} genre
 * @property {string} cover_path
 */

/**
 * @typedef {Object} SectionModel
 * @property {string} id
 * @property {string} title
 * @property {string} type
 * @property {Array<SongModel>} songs
 */

/**
 * @typedef {Object} LibraryModel
 * @property {boolean} success
 * @property {string?} message
 * @property {Array<SectionModel>} sections
 * @property {Array<SongModel>} all_songs
 * @property {number} total
 */

/**
 * @typedef {Object} FetchModel
 * @property {boolean} success
 * @property {SongModel} song
 */

/**
 * @typedef {Object} ImportModel
 * @property {boolean} success
 * @property {string} title
 * @property {string} artist
 */

export class MusicService extends Service {
    constructor() {
        super('/api/music');
    }

    /** @returns {Promise<Result<LibraryModel, ErrorModel | ResponseError>>} */
    library() {
        return this.wrap(RequestHelper.request(this.url('/library')));
    }

    /**
     * @param {string} songId 
     * @returns {Promise<Result<{ 
     *  success: boolean, 
     *  message: string 
     * }, ErrorModel | ResponseError>>}
     */
    delete(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}`), {
            method: 'DELETE'
        }));
    }

    /**
     * @param {string} songId 
     * @returns {Promise<Result<FetchModel, ErrorModel | ResponseError>>}
     */
    fetch(songId) {
        return this.wrap(RequestHelper.request(this.url(`/info/${songId}`)));
    }

    YouTube = {
        /**
         * @param {string} url 
         * @returns {Promise<Result<ImportModel, ErrorModel | ResponseError>>}
         */
        import: (url) => {
            return this.wrap(RequestHelper.request(this.url('/youtube-import'), {
                method: 'POST',
                body: { url }
            }));
        }
    }
};