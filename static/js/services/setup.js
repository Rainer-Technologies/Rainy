import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} SetupModel
 * @property {boolean} needs_setup
 * @property {string} message
 */

export class SetupService extends Service {
    constructor() {
        super('/api/setup');
    }

    /** @returns {Promise<Result<SetupModel, ErrorModel | ResponseError>>} */
    status() {
        return this.wrap(RequestHelper.request(this.url('/status')));
    }

    /** @returns {Promise<Result<boolean, ErrorModel | ResponseError>>} */
    async complete(username, email, password, musicPath) {
        /** @type {Result<{ success: boolean, message: string, user: import('./auth.js').UserModel }, ErrorModel | ResponseError>} */
        const data = await this.wrap(RequestHelper.request(this.url('/complete'), {
            method: 'POST',
            body: { username, email, password, music_path: musicPath }
        }));

        if(data.error) return data;
        return Ok(true);
    }
};