import { RequestHelper } from "../helper/request.js";
import { Service } from "./index.js";

export class AchievementsService extends Service {
    constructor() {
        super('/api/achievements');
    }

    /** Get all achievements with progress and unlock status */
    getAchievements() {
        return this.wrap(RequestHelper.request(this.url('')));
    }

    /** Force a full re-evaluation of all achievements (e.g. after bulk import) */
    evaluate() {
        return this.wrap(RequestHelper.request(this.url('/evaluate'), {
            method: 'POST'
        }));
    }

    /** Quick summary: how many unlocked out of total */
    getSummary() {
        return this.wrap(RequestHelper.request(this.url('/summary')));
    }
}

const __singleton = new AchievementsService();

/** @returns {AchievementsService} */
export function useAchievementsService() {
    return __singleton;
}
