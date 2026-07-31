import { RequestHelper, ResponseError } from "../helper/request.js";
import { Err, Ok, Result } from "../helper/result.js";

export class Service {
    constructor(baseUrl = '/') {
        this._baseUrl = baseUrl;
    }

    url(path, query) {
        const stringified = Object.entries(query ?? {}).map(([key, value]) => 
            `${key}=${encodeURIComponent(value)}`).join('&');

        return `${this._baseUrl}${path}${stringified}`;
    }

    /**
     * @template T
     * @template E
     * @param {Promise<Result<Response, ResponseError>>} requestPromise 
     * @returns {Promise<Result<T, E | ResponseError>>}
     */
    async wrap(requestPromise) {
        const response = await requestPromise;

        if(response.error) {
            const status = response.error.response?.status ?? -1;
            const isClientError = RequestHelper.isClientError(status);
            if(isClientError) {
                const data = await response.error.response.json();
                return Err(data);
            }

            return response;
        }

        const data = await response.value.json();
        return Ok(data);
    }
}
