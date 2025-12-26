import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} StatModel
 * @property {number} scan_id
 * @property {number} files_found
 * @property {number} files_added
 * @property {number} files_updated
 * @property {number} files_removed
 */

/**
 * @typedef {Object} ScanModel
 * @property {boolean} success
 * @property {string} message
 * @property {string} scan_type
 * @property {StatModel} stats
 * @property {number} total
 */

/**
 * @typedef {Object} StatusScanModel
 * @property {number} id
 * @property {string} type
 * @property {string} status
 * @property {number} files_found
 * @property {number} files_added
 * @property {number} files_updated
 * @property {number} files_removed
 * @property {string?} error
 * @property {string?} started_at
 * @property {string?} completed_at
 */

/**
 * @typedef {Object} StatusModel
 * @property {boolean} success
 * @property {boolean} has_scan
 * @property {string?} message
 * @property {StatusScanModel?} scan
 * @property {number?} library_total
 */

export class ScanService extends Service {
    constructor() {
        super('/api/music');
    }

    /** @returns {Promise<Result<ScanModel, ErrorModel | ResponseError>>} */
    quick() {
        return this.wrap(RequestHelper.request(this.url('/scan'), {
            method: 'POST'
        }));
    }

    /** @returns {Promise<Result<ScanModel, ErrorModel | ResponseError>>} */
    full() {
        return this.wrap(RequestHelper.request(this.url('/scan/full'), {
            method: 'POST'
        }));
    }

    /** @returns {Promise<Result<StatusModel, ErrorModel | ResponseError>>} */
    status() {
        return this.wrap(RequestHelper.request(this.url('/scan/status')));
    }
};