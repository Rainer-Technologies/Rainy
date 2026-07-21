import { RequestHelper, ResponseError } from "../helper/request.js";
import { Ok, Result } from "../helper/result.js";
import { Service } from "./index.js";

export class PlaybackService extends Service {
    constructor() {
        super('/api/playback');
    }

    /** Record a song play event */
    recordPlay(songId, position = 0, duration = 0) {
        return this.wrap(RequestHelper.request(this.url('/history'), {
            method: 'POST',
            body: { song_id: songId, position, duration }
        }));
    }

    /** Get recently played songs */
    getRecentlyPlayed(limit = 50, offset = 0) {
        const params = new URLSearchParams();
        if (limit) params.set('limit', limit.toString());
        if (offset) params.set('offset', offset.toString());
        const query = params.toString() ? `?${params.toString()}` : '';
        return this.wrap(RequestHelper.request(this.url('/history' + query)));
    }

    /** Get most played songs */
    getTopSongs(limit = 50) {
        return this.wrap(RequestHelper.request(this.url(`/history/top?limit=${limit}`)));
    }

    /** Get top artists by play count */
    getTopArtists(limit = 20) {
        return this.wrap(RequestHelper.request(this.url(`/history/artists?limit=${limit}`)));
    }

    /** Get top genres by play count */
    getTopGenres(limit = 10) {
        return this.wrap(RequestHelper.request(this.url(`/history/genres?limit=${limit}`)));
    }

    /** Get aggregate listening stats */
    getStats() {
        return this.wrap(RequestHelper.request(this.url('/stats')));
    }

    /** Clear all play history */
    clearHistory() {
        return this.wrap(RequestHelper.request(this.url('/history'), {
            method: 'DELETE'
        }));
    }

    // --- Cross-device state ---

    /** Save playback state */
    saveState(songId, position, queue, queueIndex, isPlaying) {
        return this.wrap(RequestHelper.request(this.url('/state'), {
            method: 'POST',
            body: {
                song_id: songId,
                position,
                queue: queue.map(s => s.id || s),
                queue_index: queueIndex,
                is_playing: isPlaying
            }
        }));
    }

    /** Get saved playback state */
    getState() {
        return this.wrap(RequestHelper.request(this.url('/state')));
    }

    /** Clear saved playback state */
    clearState() {
        return this.wrap(RequestHelper.request(this.url('/state'), {
            method: 'DELETE'
        }));
    }
}

const __singleton = new PlaybackService();

/** @returns {PlaybackService} */
export function usePlaybackService() {
    return __singleton;
}
