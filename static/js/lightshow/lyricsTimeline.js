/**
 * Lyrics timeline — what is sung when, shared by every environment.
 *
 * Synced lyrics become stage lines of timed words (Whisper word timings when
 * the song has been aligned, a character-weighted estimate otherwise). Two
 * things are handled apart from the main line:
 *  - Words in (parentheses) are backing vocals / ad-libs. They are pulled out
 *    of the sentence into `adlibs`.
 *  - A ♪ line, or a long gap with no vocals, is an instrumental break
 *    (`breakAt`).
 *
 * How any of it looks is up to the environment: this module only answers
 * questions about media time, so every environment shows the same words at
 * the same moment.
 */
import { useLyricsService } from '../services/lyrics.js';

export const LEAD = 0.28;          // lines enter slightly before they are sung
export const HOLD_MAX = 0.6;       // a line whose last word overruns stays up at most this long past the next line's time
export const REST_AFTER = 1.2;     // seconds after a line's last word before it rests
export const HELD = 0.8;           // words at least this long are 'held' notes

/**
 * Split a line into words. Words inside (parentheses) are flagged `back`
 * (backing vocals); the parentheses themselves are dropped from the text.
 */
export const tokenize = (text) => {
    const raw = (text || '').trim().split(/\s+/).filter(Boolean);
    if (!raw.length) return [{ text: '♪', back: false }];
    let depth = 0;
    return raw.map((tok) => {
        depth += (tok.match(/\(/g) || []).length;
        const back = depth > 0;
        depth = Math.max(0, depth - (tok.match(/\)/g) || []).length);
        return { text: tok.replace(/[()]/g, ''), back };
    });
};

/**
 * Turn synced lyrics into stage lines. Parenthesised words are lifted out
 * into `adlibs` (unless that would leave no main lines at all).
 * @param {Array<{time:number, text:string}>} synced
 * @param {Array|null} aligned  per-line word timings ([start, end] pairs), when the song has them
 * @returns {{ lines: object[], adlibs: object[] }}
 *   lines:  [{ t0, t1, on, end, blank, words: [{ text, s, e }] }]
 *   adlibs: [{ s, e, k, words: [{ text, s, e }] }]
 */
export function buildLines(synced, aligned, extract = true) {
    const lines = [];
    const adlibs = [];
    for (let i = 0; i < synced.length; i++) {
        const t0 = +synced[i].time || 0;
        const next = i + 1 < synced.length ? +synced[i + 1].time : t0 + 6;
        const tokens = tokenize(synced[i].text);
        const pairs = aligned && aligned[i];
        let words;
        if (Array.isArray(pairs) && pairs.length === tokens.length) {
            words = tokens.map((tok, k) => {
                const p = pairs[k];
                const s = Array.isArray(p) ? +p[0] : +p;
                const e = Array.isArray(p) && Number.isFinite(+p[1]) ? +p[1] : s + 0.3;
                return { text: tok.text, back: tok.back, s, e: Math.max(e, s + 0.08) };
            });
        } else {
            // Estimate: spread words over the sung part of the line,
            // weighted by length (long words take longer to sing).
            const span = Math.max(0.6, Math.min(next - t0, 0.9 + tokens.map((k) => k.text).join('').length * 0.075) * 0.88);
            const weights = tokens.map((tok) => 1 + tok.text.length * 0.35);
            const total = weights.reduce((x, y) => x + y, 0);
            let acc = t0;
            words = tokens.map((tok, k) => {
                const d = (weights[k] / total) * span;
                const w = { text: tok.text, back: tok.back, s: acc, e: acc + d * 0.92 };
                acc += d;
                return w;
            });
        }
        const blank = tokens.length === 1 && tokens[0].text === '♪';
        const main = [];
        let group = null;
        for (const w of words) {
            if (!w.text) continue;
            if (extract && w.back) {
                if (!group) {
                    group = { s: w.s, e: w.e, words: [], k: adlibs.length };
                    adlibs.push(group);
                }
                group.words.push({ text: w.text, s: w.s, e: w.e });
                group.e = w.e;
            } else {
                group = null;
                main.push({ text: w.text, s: w.s, e: w.e });
            }
        }
        if (!main.length) continue;
        lines.push({ t0, t1: next, words: main, blank, end: main[main.length - 1].e });
    }
    if (extract && !lines.length) return buildLines(synced, aligned, false);
    // When each line goes live: a little before it is sung (LEAD) — but not while the
    // previous line's last word is still being sung (LRC times run ahead of the voice).
    for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        let on = L.t0 - LEAD;
        if (i > 0) {
            const prev = lines[i - 1];
            if (!prev.blank) on = Math.max(on, Math.min(prev.end, L.t0 + HOLD_MAX));
            on = Math.max(on, prev.on + 0.01);
        }
        L.on = on;
    }
    return { lines, adlibs };
}

/**
 * How the line that just finished hands over to the next. Deterministic
 * per line (so seeking is stable), picked from what the music is doing,
 * and never the same twice in a row (`last` is the previous pick).
 * @returns {'slam'|'fall'|'flicker'|'sweep'|'collapse'|'lift'}
 */
export function pickTransition(F, idx, last) {
    const sec = (F.section && F.section.label) || 'verse';
    const genre = (F.profile && F.profile.genre) || 'pop';
    let pool;
    if (sec === 'chorus' || sec === 'drop') pool = ['slam', 'fall', 'flicker'];
    else if (sec === 'build') pool = ['sweep'];
    else if (sec === 'intro' || sec === 'outro' || sec === 'breakdown' || genre === 'chill' || genre === 'orchestral') pool = ['collapse', 'lift'];
    else if (genre === 'edm' || genre === 'rock') pool = ['lift', 'sweep', 'flicker'];
    else pool = ['lift', 'sweep', 'fall'];
    let pick = pool[idx % pool.length];
    if (pick === last && pool.length > 1) pick = pool[(idx + 1) % pool.length];
    return pick;
}

export class LyricsTimeline {
    constructor() {
        this.songId = 0;
        this.lines = null;       // see buildLines
        this.adlibs = [];
        this.aligned = false;
        this.version = 0;        // bumped whenever the lines are replaced, so views can start over
        this._token = 0;
        this._loading = null;
    }

    get ready() {
        return !!(this.lines && this.lines.length);
    }

    /**
     * Fetch synced lyrics (+ cached word alignment) for a song.
     * @returns {Promise<void>} settles once the song's lines are in (or it has none)
     */
    load(songId) {
        if (!songId) return Promise.resolve();
        if (songId !== this.songId) this._loading = this._load(songId);
        return this._loading || Promise.resolve();
    }

    async _load(songId) {
        const token = ++this._token;
        this.songId = songId;
        this._set(null, [], false);
        try {
            const res = await useLyricsService().get(songId);
            if (token !== this._token) return;
            const synced = !res.error && res.value && res.value.lyrics && res.value.lyrics.synced;
            if (!Array.isArray(synced) || !synced.length) return;

            const { words, pending } = await this._fetchWords(songId, synced.length);
            if (token !== this._token) return;
            const built = buildLines(synced, words);
            this._set(built.lines, built.adlibs, !!words);
            if (pending) this._awaitWords(songId, synced, token, 0);
        } catch (e) {
            if (token === this._token) this._set(null, [], false);
        }
    }

    clear() {
        this._token++;
        this._loading = null;
        this.songId = 0;
        this._set(null, [], false);
    }

    _set(lines, adlibs, aligned) {
        this.lines = lines;
        this.adlibs = adlibs;
        this.aligned = aligned;
        this.version++;
    }

    /** Cached word alignment for a song; `pending` while the server is still computing it. */
    async _fetchWords(songId, lineCount) {
        try {
            const r = await fetch(`/api/music/song/${songId}/lyrics-words`);
            if (r.ok) {
                const body = await r.json();
                if (Array.isArray(body.words) && body.words.length === lineCount) return { words: body.words, pending: false };
                return { words: null, pending: !!body.pending };
            }
        } catch (e) { /* word timings are optional */ }
        return { words: null, pending: false };
    }

    /** Re-check while the server aligns the song, then swap the exact times in. */
    _awaitWords(songId, synced, token, attempt) {
        if (attempt >= 60) return;
        setTimeout(async () => {
            if (token !== this._token) return;
            const { words, pending } = await this._fetchWords(songId, synced.length);
            if (token !== this._token) return;
            if (words) {
                const built = buildLines(synced, words);
                this._set(built.lines, built.adlibs, true);
            } else if (pending) {
                this._awaitWords(songId, synced, token, attempt + 1);
            }
        }, attempt < 5 ? 3000 : 6000);
    }

    /** Index of the line on stage at t (-1 before the first one). */
    lineIndex(t) {
        const L = this.lines;
        let lo = 0, hi = L.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (L[mid].on <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return ans;
    }

    /** No one is singing line `idx` at t: it is blank, over, or there is none yet. */
    resting(t, idx) {
        const line = idx >= 0 ? this.lines[idx] : null;
        return !line || line.blank || t > line.end + REST_AFTER;
    }

    /**
     * The instrumental break running at t, if any: a ♪ line, the run-in before
     * the first line, or a long gap between lines.
     * @returns {{a:number, b:number}|null} its span in media time (b may be Infinity)
     */
    breakAt(t, idx) {
        const L = this.lines;
        const line = idx >= 0 ? L[idx] : null;
        const next = L[idx + 1] || null;
        const resting = this.resting(t, idx);
        if (line && line.blank) return { a: line.t0, b: next ? next.t0 : Infinity };
        if (!line && idx === -1 && L[0].t0 > 4.5 && t > 0.5) return { a: 0, b: L[0].t0 };
        if (line && resting && next && t > line.end + REST_AFTER && next.t0 - line.end > 6) return { a: line.end + REST_AFTER, b: next.t0 };
        if (line && resting && !next && t > line.end + 6) return { a: line.end + REST_AFTER, b: Infinity };
        return null;
    }
}
