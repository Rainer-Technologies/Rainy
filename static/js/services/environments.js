import { RequestHelper, ResponseError } from "../helper/request.js";
import { Err, Ok, Result } from "../helper/result.js";
import { setInstalled } from "../lightshow/environments/index.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * An installed light show environment package, as the server lists it.
 * @typedef {Object} EnvironmentInfo
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {number} api
 * @property {string} description
 * @property {string} author
 * @property {'stage'|'immersive'} layout
 * @property {string[]} requires
 * @property {Record<string, { name?: string, description?: string }>} i18n
 * @property {string} base      address its files are served under
 * @property {string} entry
 * @property {string[]} styles
 * @property {string|null} preview
 * @property {boolean} enabled
 * @property {boolean} dev      served from the development folder, not installed
 * @property {number} [size]            administrators only
 * @property {string} [installed_at]    administrators only
 */

/**
 * @typedef {Object} EnvironmentList
 * @property {EnvironmentInfo[]} environments
 * @property {boolean} can_manage
 * @property {number} max_bytes
 */

export class EnvironmentsService extends Service {
    constructor() {
        super('/api/environments');
        /** @type {EnvironmentList|null} */
        this.last = null;
    }

    /**
     * The environments installed on this server. Also puts them in the light
     * show's registry, so the show and the settings page see the same list.
     * @returns {Promise<Result<EnvironmentList, ErrorModel | ResponseError>>}
     */
    async refresh() {
        const res = await this.wrap(RequestHelper.request(this.url('')));
        if (!res.error && res.value && Array.isArray(res.value.environments)) {
            this.last = res.value;
            setInstalled(res.value.environments);
        }
        return res;
    }

    /**
     * Install a package, or update the installed one with the same id.
     * @param {File} file
     * @returns {Promise<Result<{ environment: EnvironmentInfo, updated: boolean, previous_version: string|null }, ErrorModel | ResponseError>>}
     */
    async install(file) {
        const body = new FormData();
        body.append('package', file, file.name);
        // (Sent with fetch itself: the browser has to set the multipart boundary.)
        try {
            const response = await fetch(this.url(''), { method: 'POST', body });
            const data = await response.json().catch(() => null);
            if (!response.ok) return Err(data && data.error ? data : { error: `${response.status} - ${response.statusText}` });
            return Ok(data);
        } catch (e) {
            return Err(new ResponseError(null, e.message));
        }
    }

    /**
     * @param {string} id
     * @param {boolean} enabled
     * @returns {Promise<Result<{ environment: EnvironmentInfo }, ErrorModel | ResponseError>>}
     */
    setEnabled(id, enabled) {
        return this.wrap(RequestHelper.request(this.url(`/${encodeURIComponent(id)}`), {
            method: 'PATCH',
            body: { enabled },
        }));
    }

    /**
     * @param {string} id
     * @returns {Promise<Result<{ success: boolean }, ErrorModel | ResponseError>>}
     */
    remove(id) {
        return this.wrap(RequestHelper.request(this.url(`/${encodeURIComponent(id)}`), {
            method: 'DELETE',
        }));
    }
}

const __singleton = new EnvironmentsService();

/**
 * @returns {EnvironmentsService}
 */
export function useEnvironmentsService() {
    return __singleton;
};
