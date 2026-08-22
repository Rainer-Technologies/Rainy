import { RequestHelper, ResponseError } from "../helper/request.js";
import { Err, Ok, Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} SongModel
 * @property {number} id
 * @property {string} path
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {string} duration
 * @property {number} track
 * @property {string} year
 * @property {string} genre
 * @property {string} cover_path
 * @property {?number} tempo_bpm
 */

/**
 * @typedef {Object} SectionModel
 * @property {string} id
 * @property {string} title
 * @property {string} type
 * @property {Array<SongModel>} songs
 */

/**
 * @typedef {Object} LibraryModel
 * @property {boolean} success
 * @property {string?} message
 * @property {Array<SectionModel>} sections
 * @property {Array<SongModel>} all_songs
 * @property {number} total
 */

/**
 * @typedef {Object} FetchModel
 * @property {boolean} success
 * @property {SongModel} song
 */

/**
 * @typedef {Object} ImportModel
 * @property {boolean} success
 * @property {string} title
 * @property {string} artist
 */

export class MusicService extends Service {
    constructor() {
        super('/api/music');
    }

    /** @returns {Promise<Result<LibraryModel, ErrorModel | ResponseError>>} */
    library() {
        return this.wrap(RequestHelper.request(this.url('/library')));
    }

    /** @returns {Promise<Result<{ tempos: Array<{ song_id: number, tempo_bpm: number }> }, ErrorModel | ResponseError>>} */
    tempoMap() {
        return this.wrap(RequestHelper.request(this.url('/tempo')));
    }

    /**
     * @param {string} songId 
     * @returns {Promise<Result<{ 
     *  success: boolean, 
     *  message: string 
     * }, ErrorModel | ResponseError>>}
     */
    delete(songId) {
        return this.wrap(RequestHelper.request(this.url(`/song/${songId}`), {
            method: 'DELETE'
        }));
    }

    /**
     * @param {string} songId 
     * @returns {Promise<Result<FetchModel, ErrorModel | ResponseError>>}
     */
    fetch(songId) {
        return this.wrap(RequestHelper.request(this.url(`/info/${songId}`)));
    }

    YouTube = {
        /**
         * @param {string} url 
         * @returns {Promise<Result<ImportModel, ErrorModel | ResponseError>>}
         */
        import: (url) => {
            return this.wrap(RequestHelper.request(this.url('/youtube-import'), {
                method: 'POST',
                body: { url }
            }));
        },
        /**
         * @param {string} url 
         * @param {function(object): void} onProgress Callback for progress events
         * @returns {Promise<Result<{
         *  success: boolean;
         *  playlist_name: string;
         *  playlist_id: number;
         *  song_count: number;
         * }, ErrorModel | ResponseError>>}
         */
        importPlaylist: async (url, onProgress, conflictMode) => {
            try {
                const response = await fetch(this.url('/youtube-playlist-import'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    credentials: 'same-origin',
                    body: JSON.stringify({ url, conflict_mode: conflictMode })
                });

                if (!response.ok) {
                    const error = await response.json().catch(() => ({ error: 'Request failed' }));
                    return Err(error);
                }

                if (!response.body) {
                    return Err({ error: 'No response body' });
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let finalResult = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    
                    // Keep the last incomplete line in the buffer
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        
                        try {
                            const event = JSON.parse(line);
                            
                            if (event.type === 'progress') {
                                if (onProgress) {
                                    onProgress(event);
                                }
                            } else if (event.type === 'result') {
                                finalResult = event.data;
                            } else if (event.type === 'error') {
                                return Err({ error: event.error });
                            }
                        } catch (e) {
                            console.error('Error parsing stream:', e);
                        }
                    }
                }

                const remaining = buffer.trim();
                if (!finalResult && remaining) {
                    try {
                        const event = JSON.parse(remaining);
                        if (event?.type === 'result') {
                            finalResult = event.data;
                        } else if (event?.type === 'error') {
                            return Err({ error: event.error });
                        } else if (event?.success) {
                            finalResult = event;
                        }
                    } catch {
                        return Err({ error: 'Stream ended without valid result' });
                    }
                }

                if (finalResult) {
                    return Ok(finalResult);
                } else {
                    return Err({ error: 'Stream ended without result' });
                }

            } catch (e) {
                return Err({ error: e?.message ?? String(e) });
            }
        }
    }

    Spotify = {
        /**
         * @param {string} url 
         * @returns {Promise<Result<ImportModel, ErrorModel | ResponseError>>}
         */
        import: (url) => {
            return this.wrap(RequestHelper.request(this.url('/spotify-import'), {
                method: 'POST',
                body: { url }
            }));
        },
        /**
         * @param {string} url 
         * @param {function(object): void} onProgress Callback for progress events
         * @returns {Promise<Result<{
         *  success: boolean;
         *  playlist_name: string;
         *  playlist_id: number;
         *  song_count: number;
         *  failed_count: number;
         * }, ErrorModel | ResponseError>>}
         */
        importPlaylist: async (url, onProgress, conflictMode) => {
            try {
                const response = await fetch(this.url('/spotify-playlist-import'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    credentials: 'same-origin',
                    body: JSON.stringify({ url, conflict_mode: conflictMode })
                });

                if (!response.ok) {
                    const error = await response.json().catch(() => ({ error: 'Request failed' }));
                    return Err(error);
                }

                if (!response.body) {
                    return Err({ error: 'No response body' });
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let finalResult = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');

                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim()) continue;

                        try {
                            const event = JSON.parse(line);

                            if (event.type === 'progress') {
                                if (onProgress) {
                                    onProgress(event);
                                }
                            } else if (event.type === 'result') {
                                finalResult = event.data;
                            } else if (event.type === 'error') {
                                return Err({ error: event.error });
                            }
                        } catch (e) {
                            console.error('Error parsing stream:', e);
                        }
                    }
                }

                const remaining = buffer.trim();
                if (!finalResult && remaining) {
                    try {
                        const event = JSON.parse(remaining);
                        if (event?.type === 'result') {
                            finalResult = event.data;
                        } else if (event?.type === 'error') {
                            return Err({ error: event.error });
                        } else if (event?.success) {
                            finalResult = event;
                        }
                    } catch {
                        return Err({ error: 'Stream ended without valid result' });
                    }
                }

                if (finalResult) {
                    return Ok(finalResult);
                } else {
                    return Err({ error: 'Stream ended without result' });
                }

            } catch (e) {
                return Err({ error: e?.message ?? String(e) });
            }
        }
    };

    /**
     * Resolve an import's playlist name and check for a name collision before
     * downloading anything.
     * @param {'youtube'|'spotify'} source
     * @param {string} url
     */
    precheckImportPlaylist = async (source, url) => {
        return this.wrap(RequestHelper.request(this.url('/import-playlist-precheck'), {
            method: 'POST',
            body: { source, url }
        }));
    };

    discover = {
        /**
         * @param {string} query 
         * @returns {Promise<Result<Array<{
         *  videoId: string;
         *  title: string;
         *  artist: string;
         *  album: string;
         *  year: string;
         *  duration: number;
         *  duration_text: string;
         *  cover_url: string;
         * }>, ErrorModel | ResponseError>>}
         */
        search: (query) => {
            return this.wrap(RequestHelper.request(this.url(`/discover/search?q=${encodeURIComponent(query)}`)));
        },
        /**
         * @param {string} videoId 
         * @returns {Promise<Result<{
         *  success: boolean;
         *  stream_url: string;
         * }, ErrorModel | ResponseError>>}
         */
        preview: (videoId) => {
            return this.wrap(RequestHelper.request(this.url(`/discover/preview/${videoId}`)));
        }
    };
};

const __singleton = new MusicService();

/**
 * @returns {MusicService}
 */
export function useMusicService() {
    return __singleton;
};
