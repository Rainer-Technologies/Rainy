import { RequestHelper, ResponseError } from "../helper/request.js";
import { Err, Ok, Result } from "../helper/result.js";
import { setInstalled } from "../theme/index.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * An installed UI theme package, as the server lists it.
 * @typedef {Object} ThemeInfo
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {number} api
 * @property {string} rev       changes with the package's contents
 * @property {string} description
 * @property {string} author
 * @property {'dark'|'light'} colorScheme
 * @property {Record<string, string>} tokens
 * @property {Record<string, { name?: string, description?: string }>} i18n
 * @property {string} base      address its files are served under
 * @property {string[]} styles
 * @property {string|null} entry
 * @property {string|null} preview
 * @property {boolean} enabled
 * @property {boolean} dev      served from the development folder, not installed
 * @property {number} [size]            administrators only
 * @property {string} [installed_at]    administrators only
 */

/**
 * @typedef {Object} ThemeList
 * @property {ThemeInfo[]} themes
 * @property {string|null} default   the theme of users who have not picked one
 * @property {boolean} can_manage
 * @property {number} max_bytes
 */

export class ThemesService extends Service {
    constructor() {
        super('/api/themes');
        /** @type {ThemeList|null} */
        this.last = null;
    }

    /**
     * The themes installed on this server, also put in the theme registry.
     * @returns {Promise<Result<ThemeList, ErrorModel | ResponseError>>}
     */
    async refresh() {
        const res = await this.wrap(RequestHelper.request(this.url('')));
        if (!res.error && res.value && Array.isArray(res.value.themes)) {
            this.last = res.value;
            setInstalled(res.value.themes, res.value.default);
        }
        return res;
    }

    /**
     * Install a package, or update the installed one with the same id.
     * @param {File} file
     * @returns {Promise<Result<{ theme: ThemeInfo, updated: boolean, previous_version: string|null, warnings: string[] }, ErrorModel | ResponseError>>}
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
     * @returns {Promise<Result<{ theme: ThemeInfo }, ErrorModel | ResponseError>>}
     */
    setEnabled(id, enabled) {
        return this.wrap(RequestHelper.request(this.url(`/${encodeURIComponent(id)}`), {
            method: 'PATCH',
            body: { enabled },
        }));
    }

    /**
     * The theme of users who have not picked one (null: Rainy's own).
     * @param {string|null} id
     * @returns {Promise<Result<{ default: string|null }, ErrorModel | ResponseError>>}
     */
    setDefault(id) {
        return this.wrap(RequestHelper.request(this.url('/default'), {
            method: 'PUT',
            body: { id },
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

const __singleton = new ThemesService();

/**
 * @returns {ThemesService}
 */
export function useThemesService() {
    return __singleton;
};
