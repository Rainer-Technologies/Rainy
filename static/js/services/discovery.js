import { RequestHelper } from "../helper/request.js";
import { Ok } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} DiscoveredPlaylist
 * @property {'youtube'|'spotify'} source
 * @property {string} name
 * @property {string} url
 * @property {string?} channel
 * @property {string?} cover
 * @property {number?} track_count
 */

/**
 * @typedef {Object} PreviewTrack
 * @property {string} title
 * @property {string} artist
 * @property {number} duration
 * @property {string?} url
 */

/**
 * @typedef {Object} PlaylistPreview
 * @property {boolean} success
 * @property {'youtube'|'spotify'} source
 * @property {string} name
 * @property {string?} cover
 * @property {number} total
 * @property {PreviewTrack[]} tracks
 * @property {string?} note
 */

export class DiscoveryService extends Service {
    constructor() {
        super('/api/discovery');
        /** @type {Map<string, PlaylistPreview>} last previews, keyed by url */
        this._previewCache = new Map();
    }

    /**
     * Search YouTube/Spotify playlists by name.
     * @param {string} query
     * @param {'all'|'youtube'|'spotify'} source
     * @param {number} limit
     * @returns {Promise<Result<{
     *   success: boolean;
     *   query: string;
     *   source: string;
     *   results: DiscoveredPlaylist[];
     *   notices: string[];
     * }, any>>}
     */
    searchPlaylists(query, source = 'all', limit = 8) {
        const url = this.url(`/playlists?${new URLSearchParams({ q: query, source, limit })}`);
        return this.wrap(RequestHelper.request(url));
    }

    /**
     * Inspect a playlist's tracks without downloading anything.
     * @param {string} url
     * @returns {Promise<Result<PlaylistPreview, any>>}
     */
    previewPlaylist(url) {
        const cached = this._previewCache.get(url);
        if (cached) {
            return Promise.resolve(Ok(cached));
        }
        return this.wrap(RequestHelper.request(
            this.url(`/preview?url=${encodeURIComponent(url)}`))
        ).then((result) => {
            if (result.value?.success) {
                if (this._previewCache.size > 12) this._previewCache.clear();
                this._previewCache.set(url, result.value);
            }
            return result;
        });
    }
};

const __singleton = new DiscoveryService();

/**
 * @returns {DiscoveryService}
 */
export function useDiscoveryService() {
    return __singleton;
};
