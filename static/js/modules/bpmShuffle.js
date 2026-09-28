/**
 * Pick a shuffle candidate near the current song's tempo without making
 * shuffle deterministic. Songs with no usable BPM stay eligible as a
 * fallback, but are not preferred when analysed songs are available.
 */

const MIN_BPM_WINDOW = 12;
const BPM_WINDOW_RATIO = 0.10;
const SPARSE_POOL_SIZE = 5;

function readBpm(song, tempoBySongId) {
    const direct = Number(song?.tempo_bpm ?? song?.bpm);
    if (Number.isFinite(direct) && direct > 0) return direct;

    const songId = song?.id;
    if (songId == null || !tempoBySongId) return null;

    const cached = tempoBySongId instanceof Map
        ? tempoBySongId.get(String(songId))
        : tempoBySongId[songId];
    const bpm = Number(cached);
    return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

function randomIndex(candidates, random) {
    if (!candidates.length) return -1;
    const roll = Math.max(0, Math.min(0.999999, Number(random()) || 0));
    return candidates[Math.floor(roll * candidates.length)];
}

/**
 * @param {Array<object>} playlist
 * @param {number} currentIndex
 * @param {Map<string, number>|Object} tempoBySongId
 * @param {() => number} random injectable for deterministic tests
 * @param {Set<number>} exclude indices that must not be picked (songs
 *        already played this shuffle cycle) — keeps a cycle repeat-free
 * @returns {number} the next playlist index, or -1 when no candidate exists
 */
export function pickBpmAwareShuffleIndex(playlist, currentIndex, tempoBySongId, random = Math.random, exclude = null) {
    if (!Array.isArray(playlist) || playlist.length < 2) return -1;

    const candidates = playlist
        .map((_song, index) => index)
        .filter(index => index !== currentIndex && !(exclude && exclude.has(index)));
    if (!candidates.length) return -1;

    const currentBpm = readBpm(playlist[currentIndex], tempoBySongId);
    if (currentBpm == null) return randomIndex(candidates, random);

    const analysed = candidates
        .map(index => ({
            index,
            bpm: readBpm(playlist[index], tempoBySongId)
        }))
        .filter(candidate => candidate.bpm != null)
        .map(candidate => ({
            ...candidate,
            distance: Math.abs(candidate.bpm - currentBpm)
        }));

    if (!analysed.length) return randomIndex(candidates, random);

    const window = Math.max(MIN_BPM_WINDOW, currentBpm * BPM_WINDOW_RATIO);
    const inRange = analysed.filter(candidate => candidate.distance <= window);
    const pool = (inRange.length ? inRange : analysed
        .slice()
        .sort((left, right) => left.distance - right.distance)
        .slice(0, SPARSE_POOL_SIZE));

    // Keep the choice varied, while making a large tempo jump increasingly
    // unlikely when several nearby songs are available.
    const weights = pool.map(candidate => Math.exp(-candidate.distance / window));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const roll = (Number(random()) || 0) * totalWeight;
    let cursor = 0;
    for (let index = 0; index < pool.length; index += 1) {
        cursor += weights[index];
        if (roll < cursor) return pool[index].index;
    }

    return pool[pool.length - 1].index;
}
