import { RequestHelper, ResponseError } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} AudioFeatures
 * @property {number} tempo_bpm
 * @property {number} tempo_confidence
 * @property {string} key_name
 * @property {string} scale_type
 * @property {number} key_strength
 * @property {number} danceability
 * @property {number} loudness_db
 * @property {number} energy
 * @property {number} spectral_centroid
 * @property {number} spectral_rolloff
 * @property {number} spectral_complexity
 * @property {number} zero_crossing_rate
 * @property {Array<number>} mfccs
 * @property {string} analyzed_at
 */

/**
 * @typedef {Object} SongTag
 * @property {string} tag_name
 * @property {number} weight
 * @property {string} source
 */

/**
 * @typedef {Object} SimilarArtist
 * @property {string} related_artist
 * @property {number} similarity
 */

/**
 * @typedef {Object} SongMetadata
 * @property {number} song_id
 * @property {string} title
 * @property {string} artist
 * @property {string} primary_artist
 * @property {?string} musicbrainz_id
 * @property {?AudioFeatures} features
 * @property {Array<SongTag>} tags
 * @property {Array<SimilarArtist>} similar_artists
 */

/**
 * @typedef {Object} EnrichmentJob
 * @property {number} id
 * @property {?number} song_id
 * @property {string} scope
 * @property {string} status
 * @property {number} progress
 * @property {?string} message
 * @property {?object} result
 * @property {?string} error
 */

export class EnrichmentService extends Service {
    constructor() {
        super('/api/music');
    }

    /**
     * @param {number} songId
     * @returns {Promise<Result<{ success: boolean, metadata: SongMetadata }, ErrorModel | ResponseError>>}
     */
    getMetadata(songId) {
        return this.wrap(RequestHelper.request(this.url(`/songs/${songId}/metadata`)));
    }

    /**
     * @param {number} songId
     * @returns {Promise<Result<{ success: boolean, job: EnrichmentJob }, ErrorModel | ResponseError>>}
     */
    enrichSong(songId) {
        return this.wrap(RequestHelper.request(this.url(`/songs/${songId}/enrich`), {
            method: 'POST'
        }));
    }

    /**
     * @returns {Promise<Result<{ success: boolean, running: boolean, job: ?EnrichmentJob }, ErrorModel | ResponseError>>}
     */
    status() {
        return this.wrap(RequestHelper.request(this.url('/enrich/status')));
    }

    /**
     * @returns {Promise<Result<{ success: boolean, job: EnrichmentJob }, ErrorModel | ResponseError>>}
     */
    backfill() {
        return this.wrap(RequestHelper.request(this.url('/enrich/backfill'), {
            method: 'POST'
        }));
    }
}

const __singleton = new EnrichmentService();

/**
 * @returns {EnrichmentService}
 */
export function useEnrichmentService() {
    return __singleton;
}
