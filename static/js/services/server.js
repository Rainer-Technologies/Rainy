import { RequestHelper } from "../helper/request.js";
import { Service } from "./base.js";

/**
 * Server-level settings and info (Chromecast setup, About).
 */
export class ServerService extends Service {
    constructor() {
        super('/api/server');
    }

    /** @returns {Promise<import('../helper/result.js').Result<{ host: string, http_port: number, origin_url: string, chrome_flag_url: string, edge_flag_url: string }, any>>} */
    chromecastInfo() {
        return this.wrap(RequestHelper.request(this.url('/chromecast-info')));
    }

    /** @returns {Promise<import('../helper/result.js').Result<{ version: string, author: string, website: string, source: string, license: string, notices_url: string, components: Array<{ name: string, license: string, url: string, version: string|null }> }, any>>} */
    about() {
        return this.wrap(RequestHelper.request(this.url('/about')));
    }
}

const __singleton = new ServerService();

/** @returns {ServerService} */
export function useServerService() {
    return __singleton;
}
