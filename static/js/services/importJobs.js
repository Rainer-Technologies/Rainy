import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} ImportJobModel
 * @property {number} id
 * @property {'youtube'|'spotify'} source
 * @property {'song'|'playlist'} kind
 * @property {string} url
 * @property {'queued'|'running'|'completed'|'failed'|'cancelled'} status
 * @property {number} progress
 * @property {string?} message
 * @property {object?} result
 * @property {string?} error
 * @property {string?} created_at
 * @property {string?} started_at
 * @property {string?} completed_at
 */

/**
 * @typedef {Object} JobListModel
 * @property {boolean} success
 * @property {Array<ImportJobModel>} queue
 * @property {Array<ImportJobModel>} history
 * @property {boolean} running
 */

export class ImportJobsService extends Service {
    constructor() {
        super('/api/music');
    }

    /**
     * Enqueue a background import.
     * @param {'youtube'|'spotify'} source
     * @param {'song'|'playlist'} kind
     * @param {string} url
     * @returns {Promise<Result<{success: boolean, job: ImportJobModel}, ErrorModel | ResponseError>>}
     */
    enqueue(source, kind, url) {
        return this.wrap(RequestHelper.request(this.url('/import-jobs'), {
            method: 'POST',
            body: { source, kind, url }
        }));
    }

    /**
     * List the live queue + recent history.
     * @returns {Promise<Result<JobListModel, ErrorModel | ResponseError>>}
     */
    list() {
        return this.wrap(RequestHelper.request(this.url('/import-jobs')));
    }

    /**
     * Fetch a single job's current state.
     * @param {number} jobId
     * @returns {Promise<Result<{success: boolean, job: ImportJobModel}, ErrorModel | ResponseError>>}
     */
    get(jobId) {
        return this.wrap(RequestHelper.request(this.url(`/import-jobs/${jobId}`)));
    }

    /**
     * Cancel a queued job.
     * @param {number} jobId
     * @returns {Promise<Result<{success: boolean}, ErrorModel | ResponseError>>}
     */
    cancel(jobId) {
        return this.wrap(RequestHelper.request(this.url(`/import-jobs/${jobId}`), {
            method: 'DELETE'
        }));
    }
};

const __singleton = new ImportJobsService();

/**
 * @returns {ImportJobsService}
 */
export function useImportJobsService() {
    return __singleton;
};
