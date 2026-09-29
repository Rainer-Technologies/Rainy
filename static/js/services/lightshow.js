import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} LightshowJob
 * @property {number} id
 * @property {number|null} song_id
 * @property {'song'|'backfill'} scope
 * @property {boolean} force
 * @property {'queued'|'running'|'completed'|'failed'} status
 * @property {number} progress
 * @property {string|null} message
 * @property {object|null} result
 * @property {string|null} error
 * @property {string|null} created_at
 * @property {string|null} completed_at
 */

export class LightshowService extends Service {
    constructor() {
        super('/api/music');
    }

    /**
     * Full score for playback. When the song has no up-to-date show yet the
     * server queues its analysis and answers `{ success: false, pending }`.
     * @param {number} songId
     * @returns {Promise<Result<{ success: boolean, lightshow?: object, pending?: boolean, job?: LightshowJob }, ErrorModel | ResponseError>>}
     */
    get(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lightshow`)));
    }

    /**
     * Lightweight summary (tempo, profile, sections) + latest analysis job.
     * @param {number} songId
     * @returns {Promise<Result<{ success: boolean, show: object|null, job: LightshowJob|null }, ErrorModel | ResponseError>>}
     */
    status(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lightshow/status`)));
    }

    /**
     * Queue a forced re-analysis of one song.
     * @param {number} songId
     * @returns {Promise<Result<{ success: boolean, job: LightshowJob }, ErrorModel | ResponseError>>}
     */
    analyze(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}/lightshow/analyze`), {
            method: 'POST',
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

    /**
     * Queue a library-wide analysis (missing/outdated shows, or all with force).
     * @param {boolean} [force]
     * @returns {Promise<Result<{ success: boolean, job: LightshowJob }, ErrorModel | ResponseError>>}
     */
    backfill(force = false) {
        return this.wrap(RequestHelper.request(this.url('/lightshow/backfill'), {
            method: 'POST',
            body: { force },
        }));
    }

    /**
     * Live queue, recent history and library coverage.
     * @returns {Promise<Result<{ success: boolean, coverage: { ready: number, total: number }, queue: LightshowJob[], history: LightshowJob[] }, ErrorModel | ResponseError>>}
     */
    jobs() {
        return this.wrap(RequestHelper.request(this.url('/lightshow/jobs')));
    }
}

const __singleton = new LightshowService();

/**
 * @returns {LightshowService}
 */
export function useLightshowService() {
    return __singleton;
};
