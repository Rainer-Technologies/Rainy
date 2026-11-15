import { RequestHelper } from "../helper/request.js";
import { Service } from "./index.js";

export class InsightsService extends Service {
    constructor() {
        super('/api/insights');
    }

    /** Insights payload. `dates` (array of YYYY-MM-DD) filters stats to those days. */
    getSummary(dates) {
        const q = (dates && dates.length) ? `?dates=${encodeURIComponent(dates.join(','))}` : '';
        return this.wrap(RequestHelper.request(this.url('/summary' + q)));
    }

    /** Year-in-review "Wrapped" card. */
    getWrapped(year) {
        const q = year ? `?year=${year}` : '';
        return this.wrap(RequestHelper.request(this.url('/wrapped' + q)));
    }

    /** One day's listening detail (hourly clock, totals, tops, listens). */
    getDay(dateIso) {
        return this.wrap(RequestHelper.request(this.url(`/day?date=${encodeURIComponent(dateIso)}`)));
    }
}

const __singleton = new InsightsService();

/** @returns {InsightsService} */
export function useInsightsService() {
    return __singleton;
}