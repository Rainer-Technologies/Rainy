import { RequestHelper, ResponseError } from "../helper/request.js";
import { Ok, Result } from "../helper/result.js";
import { Service } from "./index.js";

export class AlbumService extends Service {
    constructor() {
        super('/api/albums');
    }

    /** Get all albums */
    getAll(search = '', sort = 'name') {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (sort) params.set('sort', sort);
        const query = params.toString() ? `?${params.toString()}` : '';
        return this.wrap(RequestHelper.request(this.url('/' + query)));
    }

    /** Get album detail with songs */
    getDetail(album, artist = '') {
        const params = new URLSearchParams();
        params.set('album', album);
        if (artist) params.set('artist', artist);
        return this.wrap(RequestHelper.request(this.url(`/detail?${params.toString()}`)));
    }
}

const __singleton = new AlbumService();

/** @returns {AlbumService} */
export function useAlbumService() {
    return __singleton;
}
