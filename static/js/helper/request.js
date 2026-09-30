import { Err, Ok, Result } from "./result.js";

const CAN_CONTAIN_BODY = (method) => (
    method !== 'GET' && 
    method !== 'HEAD' && 
    method !== 'CONNECT' && 
    method !== 'OPTIONS' && 
    method !== 'TRACE'
);

export class ResponseError extends Error {
    /**
     * @param {Response | null} response 
     * @param {string} message 
     */
    constructor(response, message) { 
        super(message);

        this.response = response;
        // Same `{ error: string }` shape the server's JSON error bodies use,
        // so callers can read `.error` uniformly for 4xx/5xx/network failures.
        this.error = message;
    };
};

export class RequestHelper {
    /**
     * @param {boolean} status 
     * @returns {boolean}
     */
    static isClientError(status) {
        return status >= 400 && status <= 499;
    }

    /**
     * @param {boolean} status 
     * @returns {boolean}
     */
    static isServerError(status) {
        return status >= 500 && status <= 599;
    }

    /** @returns {Promise<Result<Response, ResponseError>>} */
    static async request(resource, init) {
        init ??= {};
        
        if(!init.method) {
            init.method = 'GET';
        }

        if(!init.headers) {
            init.headers = {};
        } else {
            init.headers = Object.entries(init.headers).reduce((prev, [key, value]) => {
                prev[key.toLowerCase()] = value;
                return prev;
            }, {});
        }

        if(CAN_CONTAIN_BODY(init.method) && init.body) {
            if(!init.headers['content-type']) {
                init.headers['content-type'] = 'application/json';
            }

            if(init.headers['content-type'] === 'application/json') {
                init.body = JSON.stringify(init.body);
            }
        }

        try {
            const response = await fetch(resource, init);

            if(
                this.isClientError(response.status) || 
                this.isServerError(response.status)
            ) {
                return new Err(new ResponseError(response, `${response.status} - ${response.statusText}`));
            }

            return Ok(response);
        } catch(err) {
            return Err(new ResponseError(null, err.message));
        }
    }
};