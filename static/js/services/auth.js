import { RequestHelper, ResponseError } from "../helper/request.js";
import { Ok, Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string?} error
 * @property {boolean?} authenticated
 */

/**
 * @typedef {Object} UserModel
 * @property {number} id
 * @property {string} username
 * @property {string} email
 * @property {string} role
 */

export class AuthService extends Service {
    constructor() {
        super('/api/auth');
    }

    /** @returns {Promise<Result<UserModel, ErrorModel | ResponseError>>} */
    async login(email, password) {
        /** @type {Result<{ user: UserModel }, ErrorModel | ResponseError>} */
        const data = await this.wrap(RequestHelper.request(this.url('/login'), {
            method: 'POST',
            body: { email, password }
        }));

        if(data.error) return data;
        return Ok(data.value.user);
    }

    /** @returns {Promise<Result<boolean, never>>} */
    async logout() {
        const result = await this.wrap(
            RequestHelper.request(this.url('/logout'), { method: 'POST' })
        );

        // A 4xx means the session was already gone (fine). Network/5xx
        // failures mean the server session may still be alive: report them.
        if (result.error instanceof ResponseError) return result;

        return Ok(true);
    }

    /** @returns {Promise<Result<any, ErrorModel | ResponseError>>} */
    async changePassword(currentPassword, newPassword) {
        return this.wrap(RequestHelper.request(this.url('/change-password'), {
            method: 'POST',
            body: { current_password: currentPassword, new_password: newPassword }
        }));
    }

    /** @returns {Promise<Result<any, ErrorModel | ResponseError>>} */
    async updatePreferences(preferences) {
        return this.wrap(RequestHelper.request(this.url('/preferences'), {
            method: 'POST',
            body: { preferences }
        }));
    }

    /** @returns {Promise<Result<UserModel, ErrorModel | ResponseError>>} */
    async me() {
        /** @type {Result<{ user: UserModel }, ErrorModel | ResponseError>} */
        const data = await this.wrap(RequestHelper.request(this.url('/me')));

        if(data.error) return data;
        return Ok(data.value.user);
    }
};

const __singleton = new AuthService();

/**
 * @returns {AuthService}
 */
export function useAuthService() {
    return __singleton;
};