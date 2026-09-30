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
            if(status === 401) {
                // Session expired/revoked mid-use; the app tears down and
                // shows the login screen (ignored while signed out).
                window.dispatchEvent(new CustomEvent('rainy:unauthorized'));
            }
            if(isClientError) {
                // Server JSON error body wins; never throw on a malformed
                // body — a silent rejection is worse than a generic message.
                try {
                    const data = await response.error.response.json();
                    return Err(data);
                } catch (_) {
                    return Err({ error: response.error.message });
                }
            }

            return response;
        }

        try {
            const data = await response.value.json();
            return Ok(data);
        } catch (_) {
            return Err(new ResponseError(response.value, 'Invalid response from server'));
        }
    }
}
