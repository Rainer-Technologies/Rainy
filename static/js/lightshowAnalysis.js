/**
 * Offline light show analysis: turns a song's PCM into a choreographed
 * "score" (beat grid, onsets, energy curve, section map) with full lookahead.
 *
 * Pure DSP with no browser APIs, so it also runs in Node for headless tests.
 * The FFT band math mirrors the live engine's WebAudio analyser (2048-point
 * Blackman-windowed FFT, dB mapped to -100..-30), so the score matches what
 * the live pipeline perceives.
 */

const FFT_SIZE = 2048;
const HOP = 1024;
const NORM_DT = 0.2; // energy curve sampling period (5 Hz)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round3 = (v) => Math.round(v * 1000) / 1000;
const follow = (env, target, dt, tauUp, tauDown) => {
    const tau = target > env ? tauUp : tauDown;
    return env + (target - env) * (1 - Math.exp(-dt / tau));
};

export function cancelError() {
    const e = new Error('Light show generation cancelled');
    e.name = 'AbortError';
    return e;
}

export function isLightshowCancel(e) {
    return !!e && e.name === 'AbortError';
}

// --------------------------------------------------------------------- FFT

/** Radix-2 in-place FFT returning magnitude spectra for real input. */
function createFft(size) {
    const levels = Math.round(Math.log2(size));
    if ((1 << levels) !== size) throw new Error('FFT size must be a power of two');

    const rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
        let r = 0;
        for (let j = 0; j < levels; j++) r = (r << 1) | ((i >> j) & 1);
        rev[i] = r;
    }
    const cosT = new Float32Array(size / 2);
    const sinT = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
        cosT[i] = Math.cos((-2 * Math.PI * i) / size);
        sinT[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    const re = new Float32Array(size);
    const im = new Float32Array(size);

    return function fftMagnitudes(out, input, offset, window) {
        for (let i = 0; i < size; i++) {
            re[i] = input[offset + rev[i]] * window[rev[i]];
            im[i] = 0;
        }
        for (let block = 2; block <= size; block <<= 1) {
            const half = block >> 1;
            const step = size / block;
            for (let base = 0; base < size; base += block) {
                for (let j = 0; j < half; j++) {
                    const k = j * step;
                    const c = cosT[k];
                    const s = sinT[k];
                    const xr = re[base + j + half];
                    const xi = im[base + j + half];
                    const tr = xr * c - xi * s;
                    const ti = xr * s + xi * c;
                    const ur = re[base + j];
                    const ui = im[base + j];
                    re[base + j] = ur + tr;
                    im[base + j] = ui + ti;
                    re[base + j + half] = ur - tr;
                    im[base + j + half] = ui - ti;
                }
            }
        }
        const bins = size >> 1;
        for (let i = 0; i < bins; i++) out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    };
}

function makeBlackman(size) {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        w[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (size - 1));
    }
    return w;
}

// ------------------------------------------------------------------ Onsets

/**
 * Onset detector mirroring the live engine's adaptive-threshold rules, but
 * with whole-song statistics for the noise floor: local mean over a ~1 s
 * causal window, global mean as the adaptive floor. Two passes: threshold
 * candidates first, then cluster candidates within the refractory window and
 * keep the strongest — offline lookahead means every onset lands on the true
 * transient peak instead of the FFT window's edge-catch.
 * @returns {{ times: number[], strengths: number[] }}
 */
function detectOnsets(band, hopDt, mult, refractory) {
    const n = band.length;
    let globalAvg = 0;
    for (let t = 0; t < n; t++) globalAvg += band[t];
    globalAvg /= Math.max(1, n);

    const minLevel = Math.max(0.045, globalAvg * 0.9);
    const W = Math.max(4, Math.round(1.0 / hopDt)); // ~1 s window

    // Pass 1: threshold candidates
    const cand = [];
    let runningSum = 0;
    for (let t = 0; t < n; t++) {
        runningSum += band[t];
        if (t > W) runningSum -= band[t - W - 1];
        const localAvg = runningSum / Math.min(t + 1, W + 1);
        const delta = t > 0 ? band[t] - band[t - 1] : 0;
        const minDelta = Math.min(0.03, Math.max(0.015, localAvg * 0.3));

        if (band[t] > localAvg * mult && band[t] > minLevel && delta > minDelta) {
            cand.push(t);
        }
    }

    // Pass 2: cluster candidates (chain gaps <= 1.5x refractory), keep strongest.
    // Timestamps point at the FFT window center (= 1 hop with 2048/1024),
    // which is where the detected energy actually lives.
    const times = [];
    const strengths = [];
    const maxGap = refractory * 1.5;
    let i = 0;
    while (i < cand.length) {
        let j = i;
        let best = cand[i];
        while (j + 1 < cand.length && (cand[j + 1] - cand[j]) * hopDt <= maxGap) {
            j++;
            if (band[cand[j]] > band[best]) best = cand[j];
        }
        times.push((best + 1) * hopDt);
        strengths.push(band[best]);
        i = j + 1;
    }
    return { times, strengths };
}

// ------------------------------------------------------------------- Tempo

/**
 * Whole-song tempo + phase: IOI histogram with octave folding (60–200 BPM)
 * for the interval, comb-filter alignment of kick onsets for the phase.
 */
function estimateBeatGrid(kickTimes, kickStrengths, duration) {
    if (kickTimes.length < 8) return null;

    const hist = new Map(); // 10 ms bins of folded IOIs
    for (let i = 1; i < kickTimes.length; i++) {
        let ioi = kickTimes[i] - kickTimes[i - 1];
        while (ioi < 0.3) ioi *= 2;
        while (ioi > 1.0) ioi /= 2;
        if (ioi < 0.28 || ioi > 1.02) continue;
        const bin = Math.round(ioi / 0.01);
        hist.set(bin, (hist.get(bin) || 0) + kickStrengths[i]);
    }
    if (!hist.size) return null;

    let bestBin = -1, bestW = 0;
    for (const [bin, w] of hist) {
        if (w > bestW) { bestW = w; bestBin = bin; }
    }
    // Refine: strength-weighted mean of folded IOIs near the winning bin
    // (wide enough to absorb hop-quantization jitter)
    let sum = 0, wsum = 0;
    for (let i = 1; i < kickTimes.length; i++) {
        let ioi = kickTimes[i] - kickTimes[i - 1];
        while (ioi < 0.3) ioi *= 2;
        while (ioi > 1.0) ioi /= 2;
        if (Math.abs(ioi - bestBin * 0.01) <= 0.03) {
            sum += ioi * kickStrengths[i];
            wsum += kickStrengths[i];
        }
    }
    const interval = wsum > 0 ? sum / wsum : bestBin * 0.01;

    // Phase via comb filter: maximize onset strength near grid points
    const P = 120;
    const sigma = 0.07 * interval;
    let bestPhase = 0, bestScore = -Infinity;
    for (let p = 0; p < P; p++) {
        const phase = (p / P) * interval;
        let score = 0;
        for (let i = 0; i < kickTimes.length; i++) {
            let d = (kickTimes[i] - phase) % interval;
            if (d < 0) d += interval;
            const err = Math.min(d, interval - d);
            score += kickStrengths[i] * Math.exp(-(err * err) / (2 * sigma * sigma));
        }
        if (score > bestScore) { bestScore = score; bestPhase = phase; }
    }

    const beats = [];
    let start = bestPhase % interval;
    for (let t = start; t <= duration + 0.001; t += interval) beats.push(round3(t));
    if (beats.length < 2) return null;
    return { interval, beats };
}

function fallbackGrid(duration) {
    const interval = 0.5; // 120 BPM
    const beats = [];
    for (let t = 0; t <= duration + 0.001; t += interval) beats.push(round3(t));
    return { interval, beats };
}

// ---------------------------------------------------------------- Sections

/**
 * Segment the normalized energy curve into musical sections using hysteresis
 * + minimum run lengths (no guessing — the whole curve is known):
 *  high (>= 0.62)  → drop
 *  mid  (>= 0.45)  → verse
 *  low             → intro (song start) / breakdown
 * A sustained rise immediately before a drop becomes a 'build'.
 * Thresholds match the live engine's section gates.
 */
function buildSections(norm, dt, duration) {
    const n = norm.length;
    if (n === 0) return [{ t0: 0, t1: round3(duration), y: 'verse' }];

    // Centered ~3 s smoothing
    const half = Math.max(1, Math.round(1.5 / dt));
    const ps = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + norm[i];
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
        sm[i] = (ps[b] - ps[a]) / (b - a);
    }

    // Hysteresis level walk (2 = high, 1 = mid, 0 = low)
    const HI = 0.62, MID = 0.42, HYS = 0.05;
    const lvl = new Uint8Array(n);
    let cur = sm[0] >= HI ? 2 : sm[0] >= MID ? 1 : 0;
    for (let i = 0; i < n; i++) {
        const v = sm[i];
        if (cur === 2) { if (v < HI - HYS) cur = v >= MID ? 1 : 0; }
        else if (cur === 1) { if (v >= HI) cur = 2; else if (v < MID - HYS) cur = 0; }
        else { if (v >= MID + HYS) cur = v >= HI ? 2 : 1; }
        lvl[i] = cur;
    }

    // Runs
    const runs = [];
    let start = 0;
    for (let i = 1; i <= n; i++) {
        if (i === n || lvl[i] !== lvl[start]) {
            runs.push({ i0: start, i1: i - 1, lvl: lvl[start] });
            start = i;
        }
    }

    // Merge runs shorter than ~8 s into neighbors
    const minLen = Math.max(1, Math.round(8 / dt));
    for (let merged = true; merged && runs.length > 1;) {
        merged = false;
        for (let i = 0; i < runs.length; i++) {
            if (runs[i].i1 - runs[i].i0 + 1 < minLen) {
                if (i === 0) runs[1].i0 = runs[0].i0;
                else runs[i - 1].i1 = runs[i].i1;
                runs.splice(i, 1);
                merged = true;
                break;
            }
        }
    }

    // Labels
    const sections = runs.map((r, i) => ({
        i0: r.i0,
        i1: r.i1,
        y: r.lvl === 2 ? 'drop' : r.lvl === 1 ? 'verse' : (i === 0 ? 'intro' : 'breakdown'),
    }));

    // Build detection: sustained rise (2–8 s) immediately before a drop
    for (let i = 1; i < sections.length; i++) {
        if (sections[i].y !== 'drop') continue;
        const prev = sections[i - 1];
        if (prev.y !== 'verse') continue;
        const dropStart = sections[i].i0;
        const minB = Math.max(prev.i0, dropStart - Math.round(8 / dt));
        let b = dropStart - 1;
        while (b > minB && sm[b - 1] <= sm[b] + 0.02) b--;
        if (b <= prev.i0) {
            prev.y = 'build';
        } else if (dropStart - b >= Math.round(2 / dt)) {
            sections.splice(i, 0, { i0: b, i1: dropStart - 1, y: 'build' });
            prev.i1 = b - 1;
            i++;
        }
    }

    return sections.map(s => ({
        t0: round3(s.i0 * dt),
        t1: round3(Math.min(duration, (s.i1 + 1) * dt)),
        y: s.y,
    }));
}

// ------------------------------------------------------------------ Driver

/**
 * Analyze a mono PCM buffer into a light show score.
 * @param {Float32Array} mono        Samples at sampleRate
 * @param {number} sampleRate
 * @param {object} [settings]        { bias?: 'chill' | 'balanced' | 'hype' }
 * @param {(fraction: number) => void} [onProgress]
 * @param {() => boolean} [isCancelled]
 * @returns {Promise<object>} Serializable score JSON
 */
export async function analyzePcm(mono, sampleRate, settings = {}, onProgress = null, isCancelled = null) {
    const duration = mono.length / sampleRate;
    const hopDt = HOP / sampleRate;
    const hopCount = Math.floor((mono.length - FFT_SIZE) / HOP);
    if (hopCount < 128) throw new Error('Song is too short to analyze');

    const fft = createFft(FFT_SIZE);
    const window = makeBlackman(FFT_SIZE);
    const mags = new Float32Array(FFT_SIZE / 2);
    const binHz = sampleRate / FFT_SIZE;
    let windowSum = 0;
    for (let i = 0; i < FFT_SIZE; i++) windowSum += window[i];
    const ampScale = 2 / windowSum; // sine-amplitude estimate (0 dBFS ≈ full scale)

    const bandAvg = (loHz, hiHz) => {
        const lo = Math.max(0, Math.floor(loHz / binHz));
        const hi = Math.min(mags.length - 1, Math.ceil(hiHz / binHz));
        if (hi <= lo) return 0;
        let sum = 0;
        for (let i = lo; i <= hi; i++) {
            const db = 20 * Math.log10(mags[i] * ampScale + 1e-10);
            sum += clamp((db + 100) / 70, 0, 1); // analyser min/maxDecibels -100..-30
        }
        return sum / (hi - lo + 1);
    };

    const kick = new Float32Array(hopCount);
    const bass = new Float32Array(hopCount);
    const mid = new Float32Array(hopCount);
    const highMid = new Float32Array(hopCount);
    const treble = new Float32Array(hopCount);
    const energy = new Float32Array(hopCount);

    let envBass = 0, envMid = 0, envTreble = 0;
    for (let t = 0; t < hopCount; t++) {
        if ((t & 255) === 0) {
            if (isCancelled && isCancelled()) throw cancelError();
            if (onProgress) onProgress((t / hopCount) * 0.8);
            await new Promise(r => setTimeout(r, 0)); // keep the UI alive
        }
        fft(mags, mono, t * HOP, window);
        kick[t] = bandAvg(40, 130);
        bass[t] = bandAvg(30, 250);
        mid[t] = bandAvg(250, 2000);
        highMid[t] = bandAvg(1200, 4000);
        treble[t] = bandAvg(5000, 12000);
        envBass = follow(envBass, bass[t], hopDt, 0.015, 0.20);
        envMid = follow(envMid, mid[t], hopDt, 0.020, 0.25);
        envTreble = follow(envTreble, treble[t], hopDt, 0.012, 0.12);
        energy[t] = envBass * 0.5 + envMid * 0.35 + envTreble * 0.15;
    }

    // Onsets (kick uses a slightly higher ratio than the live engine: the log
    // byte scale makes gate splatter from hats/snares disproportionately
    // visible, and a real kick dominates its band by far more than 1.5x)
    const kickOn = detectOnsets(kick, hopDt, 1.50, 0.120);
    const snareOn = detectOnsets(highMid, hopDt, 1.45, 0.120);
    const hatOn = detectOnsets(treble, hopDt, 1.50, 0.060);
    if (onProgress) onProgress(0.85);

    // Beat grid from the kick pattern (fallback to a 120 BPM clock)
    const grid = estimateBeatGrid(kickOn.times, kickOn.strengths, duration) || fallbackGrid(duration);
    if (onProgress) onProgress(0.9);

    // Normalized energy curve: whole-song mean/deviation (no adaptation lag)
    let mean = 0;
    for (let t = 0; t < hopCount; t++) mean += energy[t];
    mean /= hopCount;
    let dev = 0;
    for (let t = 0; t < hopCount; t++) dev += Math.abs(energy[t] - mean);
    dev /= hopCount;
    const spread = Math.max(dev * 2.5, 0.08);

    const bias = settings.bias === 'chill' || settings.bias === 'hype' ? settings.bias : 'balanced';
    const normHop = new Float32Array(hopCount);
    for (let t = 0; t < hopCount; t++) {
        let v = clamp(0.5 + (energy[t] - mean) / (spread * 2), 0, 1);
        if (bias === 'chill') v = clamp(v * 0.85, 0, 1);
        else if (bias === 'hype') v = clamp(v * 1.15 + 0.03, 0, 1);
        normHop[t] = v;
    }

    // Downsample to the score curve (average pooling, quantized 0..255).
    // The effective period differs slightly from NORM_DT — use it everywhere
    // or the curve drifts out of sync with the audio over the song's length.
    const per = Math.max(1, Math.round(NORM_DT / hopDt));
    const effDt = per * hopDt;
    const normCount = Math.ceil(hopCount / per);
    const normQ = new Array(normCount);
    const norm5 = new Float32Array(normCount);
    for (let i = 0; i < normCount; i++) {
        let sum = 0, cnt = 0;
        for (let j = i * per; j < Math.min(hopCount, (i + 1) * per); j++) { sum += normHop[j]; cnt++; }
        const v = sum / cnt;
        norm5[i] = v;
        normQ[i] = Math.round(clamp(v, 0, 1) * 255);
    }
    if (onProgress) onProgress(0.95);

    const sections = buildSections(norm5, effDt, duration);

    return {
        v: 1,
        duration: round3(duration),
        bpm: Math.round((60 / grid.interval) * 100) / 100,
        beats: grid.beats,
        onsets: {
            k: kickOn.times.map(round3),
            s: snareOn.times.map(round3),
            h: hatOn.times.map(round3),
        },
        normDt: effDt,
        norm: normQ,
        sections,
        settings: { bias },
    };
}
