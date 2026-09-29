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
 * @typedef {Object} LyricsJob
 * @property {number} id
 * @property {number|null} song_id
 * @property {'song'|'backfill'} scope
 * @property {boolean} force
 * @property {'queued'|'running'|'completed'|'failed'} status
 * @property {number} progress
 * @property {string|null} message
 * @property {object|null} result
 * @property {string|null} error
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
     * Aligned word timings ([start, end] per word, per line). While the server
     * is still analysing the song it answers `{ success: false, pending: true }`.
     * @param {string | number} songId
     * @returns {Promise<Result<{ success: boolean, words?: number[][][], language?: string, pending?: boolean, job?: LyricsJob }, ErrorModel | ResponseError>>}
     */
    words(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lyrics-words`)));
    }

    /**
     * Queue a forced re-alignment of one song's lyrics.
     * @param {string | number} songId
     * @returns {Promise<Result<{ success: boolean, job: LyricsJob }, ErrorModel | ResponseError>>}
     */
    analyze(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lyrics-words/analyze`), {
            method: 'POST'
        }));
    }

    /**
     * Queue a library-wide analysis (fetch missing lyrics + align words).
     * @param {boolean} [force] re-align every song, not just the ones that need it
     * @returns {Promise<Result<{ success: boolean, job: LyricsJob }, ErrorModel | ResponseError>>}
     */
    backfill(force = false) {
        return this.wrap(RequestHelper.request(this.url('/lyrics/backfill'), {
            method: 'POST',
            body: { force }
        }));
    }

    /**
     * Live queue, recent history and library coverage.
     * @returns {Promise<Result<{ success: boolean, coverage: { ready: number, total: number, unfetched: number }, queue: LyricsJob[], history: LyricsJob[] }, ErrorModel | ResponseError>>}
     */
    jobs() {
        return this.wrap(RequestHelper.request(this.url('/lyrics/jobs')));
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
