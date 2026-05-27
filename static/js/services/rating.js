import { RequestHelper, ResponseError } from "../helper/request.js";
import { Ok, Result } from "../helper/result.js";
import { Service } from "./index.js";

export class RatingService extends Service {
    constructor() {
        super('/api/ratings');
    }

    /**
     * Set or update a rating for a song
     * @param {number} songId - The song ID
     * @param {string|null} rating - 'like', 'dislike', or null to remove
     * @returns {Promise<Result<{success, action, rating, song_id}, ErrorModel | ResponseError>>}
     */
    setRating(songId, rating) {
        return this.wrap(RequestHelper.request(this.url('/'), {
            method: 'POST',
            body: { song_id: songId, rating }
        }));
    }

    /**
     * Remove a rating for a song
     * @param {number} songId - The song ID
     * @returns {Promise<Result<{success, action}, ErrorModel | ResponseError>>}
     */
    removeRating(songId) {
        return this.wrap(RequestHelper.request(this.url(`/${songId}`), {
            method: 'DELETE'
        }));
    }

    /**
     * Get all liked songs for the current user
     * @param {number} limit - Optional limit
     * @param {number} offset - Optional offset
     * @returns {Promise<Result<{songs: Array}, ErrorModel | ResponseError>>}
     */
    getLikedSongs(limit = 100, offset = 0) {
        const params = new URLSearchParams();
        if (limit) params.set('limit', limit.toString());
        if (offset) params.set('offset', offset.toString());
        const query = params.toString() ? `?${params.toString()}` : '';
        return this.wrap(RequestHelper.request(this.url('/liked' + query)));
    }

    /**
     * Get all disliked songs for the current user
     * @param {number} limit - Optional limit
     * @param {number} offset - Optional offset
     * @returns {Promise<Result<{songs: Array}, ErrorModel | ResponseError>>}
     */
    getDislikedSongs(limit = 100, offset = 0) {
        const params = new URLSearchParams();
        if (limit) params.set('limit', limit.toString());
        if (offset) params.set('offset', offset.toString());
        const query = params.toString() ? `?${params.toString()}` : '';
        return this.wrap(RequestHelper.request(this.url('/disliked' + query)));
    }

    /**
     * Get ratings for a batch of songs
     * @param {Array<number>} songIds - Array of song IDs
     * @returns {Promise<Result<{ratings: Object}, ErrorModel | ResponseError>>}
     */
    getSongRatings(songIds) {
        if (!songIds || songIds.length === 0) {
            return Promise.resolve(Ok({ ratings: {} }));
        }
        return this.wrap(RequestHelper.request(this.url('/batch'), {
            method: 'POST',
            body: { song_ids: songIds }
        }));
    }

    /**
     * Get just the list of liked song IDs (for quick loading)
     * @returns {Promise<Result<{song_ids: Array}, ErrorModel | ResponseError>>}
     */
    getLikedIds() {
        return this.wrap(RequestHelper.request(this.url('/ids/liked')));
    }

    /**
     * Get just the list of disliked song IDs (for quick loading)
     * @returns {Promise<Result<{song_ids: Array}, ErrorModel | ResponseError>>}
     */
    getDislikedIds() {
        return this.wrap(RequestHelper.request(this.url('/ids/disliked')));
    }

    /**
     * Migrate likes from Liked Music playlist to song_ratings table
     * @returns {Promise<Result<{success, migrated, playlist_id}, ErrorModel | ResponseError>>}
     */
    migrateLikes() {
        return this.wrap(RequestHelper.request(this.url('/migration'), {
            method: 'POST'
        }));
    }

    /**
     * Remove duplicate entries from Liked Music playlist and sync ratings
     * @returns {Promise<Result<{success, message, removed, synced}, ErrorModel | ResponseError>>}
     */
    cleanupDuplicates() {
        return this.wrap(RequestHelper.request(this.url('/cleanup'), {
            method: 'POST'
        }));
    }
}

const __singleton = new RatingService();

/**
 * @returns {RatingService}
 */
export function useRatingService() {
    return __singleton;
};
