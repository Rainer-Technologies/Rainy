import { RequestHelper, ResponseError } from "../helper/request.js";
import { Ok, Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ManagedUserModel
 * @property {number} id
 * @property {string} username
 * @property {string} email
 * @property {string} role
 * @property {boolean?} full_library
 * @property {string?} created_at
 */

export class UsersService extends Service {
    constructor() {
        super('/api/users');
    }

    /** @returns {Promise<Result<ManagedUserModel[], import('./auth.js').ErrorModel | ResponseError>>} */
    async all() {
        /** @type {Result<{ users: ManagedUserModel[] }, import('./auth.js').ErrorModel | ResponseError>} */
        const data = await this.wrap(RequestHelper.request(this.url('')));

        if (data.error) return data;
        return Ok(data.value.users);
    }

    /** @returns {Promise<Result<ManagedUserModel, import('./auth.js').ErrorModel | ResponseError>>} */
    async create(username, email, password, role = 'user', fullLibrary = false) {
        /** @type {Result<{ user: ManagedUserModel }, import('./auth.js').ErrorModel | ResponseError>} */
        const data = await this.wrap(RequestHelper.request(this.url(''), {
            method: 'POST',
            body: { username, email, password, role, full_library: fullLibrary }
        }));

        if (data.error) return data;
        return Ok(data.value.user);
    }

    /** @returns {Promise<Result<any, import('./auth.js').ErrorModel | ResponseError>>} */
    async updateRole(userId, role) {
        return this.wrap(RequestHelper.request(this.url(`/${userId}/role`), {
            method: 'POST',
            body: { role }
        }));
    }

    /** @returns {Promise<Result<any, import('./auth.js').ErrorModel | ResponseError>>} */
    async updateFullLibrary(userId, fullLibrary) {
        return this.wrap(RequestHelper.request(this.url(`/${userId}/full-library`), {
            method: 'POST',
            body: { full_library: fullLibrary }
        }));
    }

    /** @returns {Promise<Result<any, import('./auth.js').ErrorModel | ResponseError>>} */
    async resetPassword(userId, password) {
        return this.wrap(RequestHelper.request(this.url(`/${userId}/reset-password`), {
            method: 'POST',
            body: { password }
        }));
    }

    /** @returns {Promise<Result<any, import('./auth.js').ErrorModel | ResponseError>>} */
    async remove(userId) {
        return this.wrap(RequestHelper.request(this.url(`/${userId}`), {
            method: 'DELETE'
        }));
    }
};

const __singleton = new UsersService();

/**
 * @returns {UsersService}
 */
export function useUsersService() {
    return __singleton;
};
