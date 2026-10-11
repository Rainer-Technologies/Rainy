/**
 * Light show environments.
 *
 * An environment is a kind of show: one way of staging the music. They all
 * run on the same core (clock, score, sources, conductor, lyrics timeline)
 * and differ only in what they draw and how the lyrics are set.
 *
 * The engine hosts one at a time and talks to it through this contract:
 *
 *   mount({ container, canvas, backdrop, lyrics, onFatal })   may be async
 *   leave()                 start fading out, another environment is taking over
 *   unmount()               release everything (DOM, GPU)
 *   setScore(score | null)  the song's score arrived or went away
 *   setTrack(track | null)  { id, title, artist, cover } of the song on stage
 *   onTrackChange()
 *   resize(cssW, cssH, { tier, lowPower, scale })
 *   update(S)               read the show state, fire cues (S.flash/blind/burst), move the lyrics
 *   render(S)               draw the frame
 *   lyricsOn                the lyrics are on stage right now
 *   dropLyrics()            take them off stage now (a new queue started)
 *   hudAxis(now)            where the HUD sits: null = top centre, number = px, undefined = not yet
 *
 * `S` is the conductor (see conductor.js): the musical frame `F`, media time,
 * intensity, hit pulses, phrase, palette, dimmer and the flash limiter.
 *
 * Modules are loaded on demand, so an environment's code (and its libraries)
 * costs nothing until it is picked.
 */

export const DEFAULT_ENVIRONMENT = 'classic';

export const ENVIRONMENTS = {
    classic: {
        id: 'classic',
        name: 'Classic',
        supported: () => true,
        load: () => import('./classic/index.js').then((m) => m.ClassicEnvironment),
    },
};

export const ENVIRONMENT_IDS = Object.keys(ENVIRONMENTS);

/** A known environment id, whatever was stored in the preferences. */
export function normalizeEnvironment(id) {
    return Object.prototype.hasOwnProperty.call(ENVIRONMENTS, id) ? id : DEFAULT_ENVIRONMENT;
}

/**
 * The environment to actually run for a wanted id: itself when this device
 * can run it and it has not already failed here, the default otherwise.
 * @param {string} id
 * @param {Set<string>} [failed] environments that broke on this device this session
 */
export function resolveEnvironment(id, failed) {
    id = normalizeEnvironment(id);
    if ((failed && failed.has(id)) || !ENVIRONMENTS[id].supported()) return DEFAULT_ENVIRONMENT;
    return id;
}

/** The environment after `id` in the list (for the in-show switcher). */
export function nextEnvironment(id) {
    const i = ENVIRONMENT_IDS.indexOf(normalizeEnvironment(id));
    return ENVIRONMENT_IDS[(i + 1) % ENVIRONMENT_IDS.length];
}
