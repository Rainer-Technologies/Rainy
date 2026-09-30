"""Offline light show analysis — turns an audio file into a choreography score.

Runs server-side (librosa + numpy) so every song gets a score automatically
after import, with full lookahead: the renderer knows where the beats, bars,
sections, drops and silences are *before* they happen, and reads everything
from ``audio.currentTime`` (no WebAudio needed on the client).

Score format (``v`` = ANALYZER_VERSION)::

    { v, duration, fps, tempo, tempoConf,
      beats: [t...], downbeats: [t...],
      onsets: { k: [[t, s]...], s: [...], h: [...] },     # kick/snare/hat
      env: { sub, bass, mid, high, air, rms, harm },      # base64 uint8 @ fps
      sections: [{ t0, t1, label, energy, density, key, mode }],
      events: [{ t, type, dur? }],                        # drop/stop/impact/riser
      profile: { genre, intensity, source } }

All envelopes are normalised per song (5th..98th percentile -> 0..255) so a
quiet acoustic track still drives the rig across its full range; the absolute
loudness/percussiveness lives in ``profile.intensity`` instead.
"""
import base64

import numpy as np

from utils import lightshow_accel
from utils.audio_analyzer import _detect_key

ANALYZER_VERSION = 2

SR = 22050
HOP = 441            # 22050 / 441 = exactly 50 frames per second
N_FFT = 2048
FPS = SR // HOP

BANDS = {
    'sub': (30, 120),
    'bass': (120, 250),
    'mid': (250, 2000),
    'high': (2000, 6000),
    'air': (6000, 11000),
}

LAST_DEBUG = {}  # signal stats of the last analysis (for tuning/tests)

SECTION_LABELS = ('intro', 'verse', 'chorus', 'build', 'drop', 'breakdown', 'outro')

# Genre keywords -> light show profile. Checked against song_tags + songs.genre.
_GENRE_KEYWORDS = {
    'edm': ('edm', 'electronic', 'electronica', 'house', 'techno', 'trance', 'dubstep',
            'drum and bass', 'drum & bass', 'dnb', 'electro', 'dance', 'hardstyle',
            'future bass', 'eurodance', 'rave', 'phonk', 'synthwave', 'bass music',
            'big room', 'trap edm', 'hardcore', 'breakbeat', 'garage', 'club'),
    'rock': ('rock', 'metal', 'punk', 'grunge', 'alternative', 'emo', 'hardcore punk',
             'post-hardcore', 'shoegaze', 'britpop', 'garage rock'),
    'hiphop': ('hip hop', 'hip-hop', 'rap', 'trap', 'drill', 'grime', 'boom bap'),
    'latin': ('reggaeton', 'reggaetón', 'latin', 'bachata', 'salsa', 'dembow', 'cumbia',
              'urbano', 'merengue', 'dancehall', 'moombahton', 'latin pop'),
    'chill': ('ambient', 'chill', 'lo-fi', 'lofi', 'acoustic', 'folk', 'jazz', 'soul',
              'ballad', 'singer-songwriter', 'downtempo', 'bossa', 'blues', 'r&b',
              'rnb', 'new age', 'dream pop'),
    'orchestral': ('classical', 'orchestral', 'soundtrack', 'score', 'cinematic',
                   'piano', 'opera', 'symphonic', 'baroque', 'film'),
    'pop': ('pop', 'j-pop', 'k-pop', 'jpop', 'kpop', 'city pop', 'anime', 'idol'),
}
# When two profiles tie, the more specific one wins.
_GENRE_PRIORITY = ('latin', 'hiphop', 'edm', 'rock', 'orchestral', 'chill', 'pop')


# ---------------------------------------------------------------- helpers

def _norm01(x, lo_pct=5.0, hi_pct=98.0, floor=None):
    """Map an array to 0..1 using per-song percentiles (robust to outliers)."""
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return x
    lo = float(np.percentile(x, lo_pct))
    hi = float(np.percentile(x, hi_pct))
    if floor is not None:
        lo = max(lo, floor)
    if hi - lo < 1e-9:
        return np.zeros_like(x)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def _release(x, tau_frames):
    """Instant attack, exponential release — keeps hits punchy but readable."""
    if tau_frames <= 0:
        return x
    k = float(np.exp(-1.0 / tau_frames))
    out = np.empty_like(x)
    prev = 0.0
    for i, v in enumerate(x):
        prev = v if v > prev else prev * k + v * (1.0 - k)
        out[i] = prev
    return out


def _b64(x01):
    q = np.clip(np.round(np.asarray(x01) * 255.0), 0, 255).astype(np.uint8)
    return base64.b64encode(q.tobytes()).decode('ascii')


def _r3(v):
    return round(float(v), 3)


def _band_rows(freqs, lo, hi):
    rows = np.where((freqs >= lo) & (freqs < hi))[0]
    return rows if rows.size else np.array([int(np.argmin(np.abs(freqs - lo)))])


def _band_energy_db(S, rows):
    power = np.mean(S[rows, :] ** 2, axis=0)
    return 10.0 * np.log10(power + 1e-12)


def _flux(logS, rows):
    """Half-wave rectified spectral flux restricted to a band, 0..1."""
    d = np.diff(logS[rows, :], axis=1, prepend=logS[rows, :1])
    f = np.sum(np.maximum(d, 0.0), axis=0)
    top = float(np.percentile(f, 99.5)) if f.size else 0.0
    return np.clip(f / top, 0.0, 1.5) if top > 1e-9 else np.zeros_like(f)


def _pick_onsets(flux, wait_frames, delta, rel):
    """Peak-pick a band flux, then drop hits much weaker than their
    neighbourhood (±2 s) — bleed from other instruments sits well below the
    real hits of that band."""
    import librosa
    if flux.size < 8:
        return []
    peaks = librosa.util.peak_pick(
        flux, pre_max=3, post_max=3, pre_avg=12, post_avg=6,
        delta=delta, wait=wait_frames,
    )
    if peaks.size == 0:
        return []
    vals = flux[peaks]
    times = peaks / FPS
    out = []
    lo = hi = 0
    for i, t in enumerate(times):
        while times[lo] < t - 2.0:
            lo += 1
        while hi < times.size and times[hi] <= t + 2.0:
            hi += 1
        if vals[i] >= rel * float(np.max(vals[lo:hi])):
            out.append([_r3(t), round(float(min(vals[i], 1.0)), 2)])
    return out


# ------------------------------------------------------------------ beats

def _beat_grid(onset_env, kick_env):
    """Beat times (seconds), tempo and a 0..1 confidence."""
    import librosa
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=SR, hop_length=HOP, units='frames', tightness=120,
    )
    tempo = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 0.0
    beats = librosa.frames_to_time(beat_frames, sr=SR, hop_length=HOP)
    if beats.size < 8 or tempo <= 0:
        return np.array([]), 0.0, 0.0

    # Fold into a comfortable 72..185 BPM lighting range.
    if tempo < 72:
        mids = (beats[:-1] + beats[1:]) / 2.0
        beats = np.sort(np.concatenate([beats, mids]))
        tempo *= 2.0
    elif tempo > 185:
        f = np.clip(np.round(beats * FPS).astype(int), 0, kick_env.size - 1)
        a = float(np.sum(kick_env[f[0::2]]))
        b = float(np.sum(kick_env[f[1::2]]))
        beats = beats[0::2] if a >= b else beats[1::2]
        tempo /= 2.0

    ioi = np.diff(beats)
    med = float(np.median(ioi))
    cv = float(np.std(ioi) / med) if med > 0 else 1.0
    # Frame-quantised IOIs make the median jump in 20 ms steps; average the
    # well-behaved intervals for a precise tempo.
    good = ioi[np.abs(ioi - med) < 0.2 * med]
    period = float(np.mean(good)) if good.size else med
    frames = np.clip(np.round(beats * FPS).astype(int), 0, onset_env.size - 1)
    pulse = float(np.mean(onset_env[frames]) / (np.mean(onset_env) + 1e-9))
    stability = np.clip(1.0 - cv * 5.0, 0.0, 1.0)
    clarity = np.clip((pulse - 1.0) / 1.5, 0.0, 1.0)
    conf = float(np.clip(0.6 * stability + 0.4 * clarity, 0.0, 1.0))
    return beats, 60.0 / period if period > 0 else tempo, conf


def _downbeat_phase(beats, kick_env, low_env, chroma):
    """Pick which of the 4 beat phases carries the bar's '1'.

    Downbeats tend to have the strongest kick/bass and the chord changes.
    """
    if beats.size < 8:
        return 0
    frames = np.clip(np.round(beats * FPS).astype(int), 0, kick_env.size - 1)
    kick = kick_env[frames] + 0.6 * low_env[frames]
    # Chroma change between consecutive beats (harmonic rhythm).
    cf = np.clip(frames, 0, chroma.shape[1] - 1)
    c = chroma[:, cf]
    change = np.zeros(beats.size)
    change[1:] = np.linalg.norm(np.diff(c, axis=1), axis=0)

    def z(v):
        s = float(np.std(v))
        return (v - float(np.mean(v))) / s if s > 1e-9 else v * 0

    score = z(kick) + 0.8 * z(change)
    best, best_val = 0, -1e18
    for p in range(4):
        val = float(np.mean(score[p::4]))
        if val > best_val:
            best, best_val = p, val
    return best


# --------------------------------------------------------------- sections

def _checkerboard_novelty(feat, half):
    """Foote novelty on a cosine self-similarity matrix of bar features."""
    n = feat.shape[1]
    if n < 2 * half + 2:
        return np.zeros(n)
    X = feat / (np.linalg.norm(feat, axis=0, keepdims=True) + 1e-9)
    ssm = X.T @ X
    g = np.exp(-0.5 * (np.linspace(-2, 2, 2 * half) ** 2))
    kern = np.outer(g, g)
    sign = np.ones((2 * half, 2 * half))
    sign[:half, half:] = -1
    sign[half:, :half] = -1
    kern *= sign
    nov = np.zeros(n)
    pad = np.pad(ssm, half, mode='edge')
    for i in range(n):
        nov[i] = float(np.sum(pad[i:i + 2 * half, i:i + 2 * half] * kern))
    nov = np.maximum(nov, 0)
    top = float(np.max(nov))
    return nov / top if top > 1e-9 else nov


def _bar_bounds(downbeats, duration):
    if downbeats.size >= 2:
        bar = float(np.median(np.diff(downbeats)))
        pre = []
        t = downbeats[0] - bar
        while t > 0.5:
            pre.append(t)
            t -= bar
        post = []
        t = downbeats[-1] + bar
        while t < duration - 0.5:
            post.append(t)
            t += bar
        edges = np.concatenate([[0.0], pre[::-1], downbeats, post, [duration]])
    else:
        edges = np.arange(0.0, duration, 8.0)
        edges = np.append(edges, duration)
    edges = np.unique(np.clip(edges, 0.0, duration))
    return edges


def _segment(edges, feats, energy_curve, min_bars=4, target_len=14.0):
    """Section boundaries (indices into bar edges) from novelty + energy change."""
    nbars = len(edges) - 1
    if nbars < 2 * min_bars:
        return [0, nbars]
    nov = _checkerboard_novelty(feats, half=4)
    # Energy steps are what the audience *feels* — weight them in.
    e = np.array([
        float(np.mean(energy_curve[int(edges[i] * FPS):max(int(edges[i] * FPS) + 1, int(edges[i + 1] * FPS))]))
        for i in range(nbars)
    ])
    de = np.zeros(nbars)
    de[1:] = np.abs(np.diff(e))
    de_s = np.convolve(de, [0.25, 0.5, 0.25], mode='same')
    score = 0.65 * nov + 0.35 * (de_s / (np.max(de_s) + 1e-9))

    duration = edges[-1]
    max_sections = max(2, int(duration / target_len) + 1)
    order = np.argsort(-score)
    bounds = [0, nbars]
    for i in order:
        if len(bounds) - 1 >= max_sections:
            break
        if score[i] < 0.18:
            break
        if all(abs(i - b) >= min_bars for b in bounds):
            bounds.append(int(i))
    bounds.sort()
    # Prefer boundaries on 4-bar phrases when the novelty is almost a tie.
    snapped = [bounds[0]]
    for b in bounds[1:-1]:
        cand = [c for c in (b - 1, b, b + 1) if 0 < c < nbars]
        best = max(cand, key=lambda c: score[c] + (0.08 if c % 4 == 0 else 0.0))
        if best - snapped[-1] >= min_bars and nbars - best >= min_bars // 2:
            snapped.append(best)
    snapped.append(nbars)
    return snapped


def _slope(y):
    if y.size < 4:
        return 0.0
    x = np.linspace(0.0, 1.0, y.size)
    return float(np.polyfit(x, y, 1)[0])


def _label_sections(secs, duration, genre):
    """Assign intro/verse/chorus/build/drop/breakdown/outro labels in place.

    Everything is relative to the song itself: a 'drop' in a ballad is just
    its loudest chorus, so drops are reserved for punchy, bass-heavy jumps
    and never used for the chill/orchestral profiles.
    """
    n = len(secs)
    if n == 0:
        return
    energies = np.array([s['energy'] for s in secs])
    weights = np.array([s['t1'] - s['t0'] for s in secs])
    order = np.argsort(energies)
    cum = np.cumsum(weights[order]) / max(float(np.sum(weights)), 1e-9)
    hi_thr = float(energies[order][min(np.searchsorted(cum, 0.55), n - 1)]) if n > 2 else float(np.max(energies))
    peak = max(float(np.max(energies)), 1e-6)
    med_low = float(np.median([s['low'] for s in secs]))
    med_dens = float(np.median([s['density'] for s in secs]))
    allow_drop = genre not in ('chill', 'orchestral')

    for i, s in enumerate(secs):
        e = s['energy']
        r = e / peak
        prev_e = secs[i - 1]['energy'] if i > 0 else 0.0
        if e >= hi_thr and r >= 0.84:
            jump = e - prev_e
            punchy = s['low'] >= med_low * 0.95 and s['density'] >= med_dens * 0.9
            s['label'] = 'drop' if allow_drop and i > 0 and s['t0'] > 8 and punchy and (jump >= 0.18 or (i > 0 and prev_e / peak < 0.55)) else 'chorus'
        elif r < 0.62:
            s['label'] = 'breakdown'
        else:
            s['label'] = 'verse'

    # Intro / outro by position.
    if secs[0]['label'] not in ('drop', 'chorus') or secs[0]['t1'] < 16:
        secs[0]['label'] = 'intro'
    if n > 2 and secs[-1]['label'] in ('breakdown', 'verse') and duration - secs[-1]['t0'] < 60:
        secs[-1]['label'] = 'outro'

    # Builds: a rising section right before a high-energy one.
    for i in range(1, n):
        if secs[i]['label'] in ('drop', 'chorus') and secs[i - 1]['label'] in ('verse', 'breakdown'):
            p = secs[i - 1]
            if p['rise'] > 0.12 or p['densRise'] > 1.35:
                p['label'] = 'build'

    # Merge neighbours that ended up with the same label (keeps cues long).
    merged = [secs[0]]
    for s in secs[1:]:
        m = merged[-1]
        if s['label'] == m['label'] and s['label'] != 'drop':
            w0, w1 = m['t1'] - m['t0'], s['t1'] - s['t0']
            for k in ('energy', 'low', 'density'):
                m[k] = (m[k] * w0 + s[k] * w1) / max(w0 + w1, 1e-9)
            m['t1'] = s['t1']
        else:
            merged.append(s)
    secs[:] = merged


# ------------------------------------------------------------------ events

def _find_stops(rms, duration):
    """Gaps of near-silence inside energetic passages (the pre-drop 'breath')."""
    stops = []
    quiet = rms < 0.10
    n = rms.size
    i = int(3 * FPS)
    end = n - int(3 * FPS)
    while i < end:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            dur = (j - i) / FPS
            before = float(np.mean(rms[max(0, i - FPS):i])) if i > 0 else 0.0
            after = float(np.mean(rms[j:min(n, j + int(1.5 * FPS))])) if j < n else 0.0
            if 0.2 <= dur <= 4.0 and before > 0.35 and after > 0.4:
                stops.append({'t': _r3(i / FPS), 'type': 'stop', 'dur': round(dur, 2)})
            i = j
        else:
            i += 1
    return stops


def _find_impacts(flux_all, rms, exclude):
    """Isolated huge hits after a quieter moment (not already a drop)."""
    out = []
    if flux_all.size < FPS * 4:
        return out
    thr = float(np.percentile(flux_all, 99.3))
    i = FPS
    last = -1e9
    while i < flux_all.size - FPS:
        if flux_all[i] >= thr and flux_all[i] == np.max(flux_all[i - 3:i + 4]):
            t = i / FPS
            before = float(np.mean(rms[i - FPS // 2:i]))
            after = float(np.mean(rms[i:i + FPS // 2]))
            if after - before > 0.25 and t - last > 4.0 and all(abs(t - x) > 1.0 for x in exclude):
                out.append({'t': _r3(t), 'type': 'impact'})
                last = t
        i += 1
    return out


# ----------------------------------------------------------------- profile

def _profile_from_tags(tags):
    votes = {}
    for name, weight in tags or []:
        n = (name or '').strip().lower()
        if not n or n in ('music', 'other', 'unknown'):
            continue
        w = float(weight or 50)
        for prof, keys in _GENRE_KEYWORDS.items():
            if any(k == n or k in n for k in keys):
                votes[prof] = votes.get(prof, 0.0) + w
    if not votes:
        return None
    best = max(votes.values())
    for prof in _GENRE_PRIORITY:
        if votes.get(prof, 0.0) >= best * 0.85:
            return prof
    return max(votes, key=votes.get)


def _rhythm_stats(beats, downbeats, onsets):
    """How the drums sit on the grid: four-on-the-floor, backbeat, dembow."""
    out = {'fourfloor': 0.0, 'backbeat': 0.0, 'dembow': 0.0}
    if beats.size < 16:
        return out
    k = np.array([o[0] for o in onsets['k']])
    sn = np.array([o[0] for o in onsets['s']])

    def near(ts, t, tol=0.05):
        if ts.size == 0:
            return False
        i = np.searchsorted(ts, t)
        return any(0 <= j < ts.size and abs(ts[j] - t) <= tol for j in (i - 1, i))

    out['fourfloor'] = float(np.mean([near(k, t) for t in beats]))
    if downbeats.size:
        first = int(np.argmin(np.abs(beats - downbeats[0])))
        idx = (np.arange(beats.size) - first) % 4
        odd = beats[(idx == 1) | (idx == 3)]
        out['backbeat'] = float(np.mean([near(sn, t) for t in odd])) if odd.size else 0.0
    # Dembow: snare on the 4th and 7th sixteenth of every two-beat cell.
    hist = np.zeros(8)
    for i in range(0, beats.size - 2, 2):
        a, b = beats[i], beats[i + 2]
        cell = sn[(sn >= a - 0.03) & (sn < b - 0.03)]
        for t in cell:
            hist[int(np.clip(np.round((t - a) / (b - a) * 8), 0, 7))] += 1
    tot = float(np.sum(hist))
    out['dembow'] = float((hist[3] + hist[6]) / tot) if tot > 0 else 0.0
    return out


def _profile_heuristic(st):
    """Best-effort genre guess from signal stats when no tags are available.

    Deliberately conservative: 'pop' is the balanced default, other profiles
    need a clear signature.
    """
    if st['perc'] < 0.3 and (st['tempoConf'] < 0.5 or st['fourfloor'] < 0.3):
        return 'orchestral' if st['centroid'] < 2200 else 'chill'
    if st['perc'] < 0.33 and st['kick'] < 1.2:
        return 'chill'
    if st['dembow'] > 0.42 and st['sub'] > 0.5:
        return 'latin'
    if st['fourfloor'] > 0.6 and st['tempo'] >= 115 and st['sub'] > 0.55:
        return 'edm'
    if st['backbeat'] > 0.55 and st['centroid'] > 2300 and st['fourfloor'] < 0.75:
        return 'rock'
    if st['tempo'] < 105 and st['sub'] > 0.6 and st['fourfloor'] < 0.6:
        return 'hiphop'
    return 'pop'


# -------------------------------------------------------------------- main

def analyze_file(file_path, tags=None):
    """Analyse one audio file into a light show score dict (or None).

    ``tags`` is an optional list of ``(tag_name, weight)`` pairs (song_tags +
    songs.genre) used to pick the genre profile before falling back to a
    signal heuristic.
    """
    import librosa

    y, _ = librosa.load(file_path, sr=SR, mono=True)
    if y is None or y.size < SR * 5:
        return None
    duration = y.size / SR

    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP))
    n = S.shape[1]
    freqs = librosa.fft_frequencies(sr=SR, n_fft=N_FFT)
    H, P = lightshow_accel.hpss(S, kernel_size=(17, 31))  # GPU if usable, else threaded CPU

    # --- Band envelopes (what the rig "sees") ---
    env = {}
    for name, (lo, hi) in BANDS.items():
        db = _band_energy_db(S, _band_rows(freqs, lo, hi))
        env[name] = _release(_norm01(db, 8, 98.5), tau_frames=4)
    rms_raw = librosa.feature.rms(S=S, frame_length=N_FFT)[0][:n]
    rms_db = 20 * np.log10(rms_raw + 1e-9)
    rms = _norm01(rms_db, 5, 98, floor=float(np.max(rms_db)) - 50.0)
    harm_db = 10 * np.log10(np.mean(H ** 2, axis=0) + 1e-12)
    harm = _norm01(harm_db, 5, 98)
    env['rms'] = _release(rms, 6)
    env['harm'] = _release(harm, 12)

    # --- Onsets per instrument band, on the percussive layer ---
    logP = np.log1p(100.0 * P)
    kick_flux = _flux(logP, _band_rows(freqs, 30, 150))
    snare_flux = 0.45 * _flux(logP, _band_rows(freqs, 150, 400)) + 0.55 * _flux(logP, _band_rows(freqs, 1500, 6000))
    hat_flux = _flux(logP, _band_rows(freqs, 7000, 11000))
    onsets = {
        'k': _pick_onsets(kick_flux, wait_frames=int(0.11 * FPS), delta=0.25, rel=0.55),
        's': _pick_onsets(snare_flux, wait_frames=int(0.13 * FPS), delta=0.25, rel=0.55),
        'h': _pick_onsets(hat_flux, wait_frames=int(0.06 * FPS), delta=0.20, rel=0.3),
    }

    # --- Beat grid + downbeats ---
    onset_env = librosa.onset.onset_strength(
        S=librosa.power_to_db(P ** 2, ref=np.max), sr=SR, hop_length=HOP, aggregate=np.median,
    )[:n]
    beats, tempo, tempo_conf = _beat_grid(onset_env, kick_flux)
    chroma = librosa.feature.chroma_stft(S=H ** 2, sr=SR, n_fft=N_FFT, hop_length=HOP)
    if beats.size >= 8:
        phase = _downbeat_phase(beats, kick_flux, env['sub'], chroma)
        downbeats = beats[phase::4]
    else:
        downbeats = np.array([])

    # --- Sections (bar-level novelty + energy) ---
    edges = _bar_bounds(downbeats, duration)
    mel = librosa.feature.melspectrogram(S=S ** 2, sr=SR, n_mels=64)
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel), n_mfcc=13)
    mfcc = (mfcc - mfcc.mean(axis=1, keepdims=True)) / (mfcc.std(axis=1, keepdims=True) + 1e-9)
    edge_frames = np.clip((edges * FPS).astype(int), 0, n)
    bar_feats = []
    for i in range(len(edges) - 1):
        a, b = edge_frames[i], max(edge_frames[i] + 1, edge_frames[i + 1])
        bar_feats.append(np.concatenate([
            np.mean(mfcc[:, a:b], axis=1),
            1.5 * np.mean(chroma[:, a:b], axis=1),
            [2.0 * float(np.mean(rms[a:b]))],
        ]))
    bar_feats = np.array(bar_feats).T if bar_feats else np.zeros((26, 0))
    bounds = _segment(edges, bar_feats, rms)

    # --- Profile ---
    perc_ratio = float(np.sum(P) / (np.sum(P) + np.sum(H) + 1e-9))
    centroid = float(np.mean(librosa.feature.spectral_centroid(S=S, sr=SR)))
    kick_rate = len(onsets['k']) / duration
    snare_rate = len(onsets['s']) / duration
    hat_rate = len(onsets['h']) / duration
    sub_level = float(np.mean(env['sub'][rms > 0.3])) if np.any(rms > 0.3) else 0.0
    stats = {
        'perc': perc_ratio, 'centroid': centroid, 'tempo': tempo, 'tempoConf': tempo_conf,
        'kick': kick_rate, 'snare': snare_rate, 'hat': hat_rate, 'sub': sub_level,
        **_rhythm_stats(beats, downbeats, onsets),
    }
    LAST_DEBUG.clear()
    LAST_DEBUG.update({k: round(float(v), 2) for k, v in stats.items()})
    genre = _profile_from_tags(tags)
    source = 'tags'
    if genre is None:
        genre = _profile_heuristic(stats)
        source = 'signal'
    loud = float(np.clip((np.mean(rms_db) + 30.0) / 22.0, 0.0, 1.0))
    intensity = float(np.clip(
        0.3 * np.clip(perc_ratio / 0.5, 0, 1)
        + 0.3 * np.clip((kick_rate + snare_rate) / 4.5, 0, 1)
        + 0.2 * np.clip((tempo - 70) / 80.0, 0, 1)
        + 0.2 * loud, 0.0, 1.0))


    kick_t = np.array([o[0] for o in onsets['k']])
    snare_t = np.array([o[0] for o in onsets['s']])
    low_env = np.maximum(env['sub'], env['bass'])
    secs = []
    for bi in range(len(bounds) - 1):
        t0, t1 = float(edges[bounds[bi]]), float(edges[bounds[bi + 1]])
        a, b = int(t0 * FPS), max(int(t0 * FPS) + 1, int(t1 * FPS))
        span = max(t1 - t0, 1e-3)
        hits = int(np.sum((kick_t >= t0) & (kick_t < t1)) + np.sum((snare_t >= t0) & (snare_t < t1)))
        half = (t0 + t1) / 2.0
        d1 = np.sum((kick_t >= t0) & (kick_t < half)) + np.sum((snare_t >= t0) & (snare_t < half))
        d2 = np.sum((kick_t >= half) & (kick_t < t1)) + np.sum((snare_t >= half) & (snare_t < t1))
        secs.append({
            't0': t0, 't1': t1,
            'energy': float(np.mean(rms[a:b])),
            'low': float(np.mean(low_env[a:b])),
            'density': hits / span,
            'rise': _slope(rms[a:b]) + 0.5 * _slope(env['air'][a:b]),
            'densRise': (d2 + 1.0) / (d1 + 1.0),
        })
    _label_sections(secs, duration, genre)
    for s in secs:
        a, b = int(s['t0'] * FPS), max(int(s['t0'] * FPS) + 1, int(s['t1'] * FPS))
        s['key'], s['mode'], _ = _detect_key(chroma[:, a:b])

    # --- Events ---
    events = []
    for i, s in enumerate(secs):
        if s['label'] == 'drop':
            events.append({'t': _r3(s['t0']), 'type': 'drop'})
        if s['label'] == 'build':
            events.append({'t': _r3(s['t0']), 'type': 'riser', 'dur': round(s['t1'] - s['t0'], 2)})
    events.extend(_find_stops(rms, duration))
    full_flux = _flux(logP, np.arange(logP.shape[0]))
    events.extend(_find_impacts(full_flux, rms, [e['t'] for e in events if e['type'] == 'drop']))
    events.sort(key=lambda e: e['t'])

    return {
        'v': ANALYZER_VERSION,
        'duration': _r3(duration),
        'fps': FPS,
        'tempo': round(float(tempo), 2),
        'tempoConf': round(tempo_conf, 2),
        'beats': [_r3(t) for t in beats],
        'downbeats': [_r3(t) for t in downbeats],
        'onsets': onsets,
        'env': {k: _b64(v) for k, v in env.items()},
        'sections': [{
            't0': _r3(s['t0']), 't1': _r3(s['t1']), 'label': s['label'],
            'energy': round(s['energy'], 3), 'density': round(s['density'], 2),
            'key': s['key'], 'mode': s['mode'],
        } for s in secs],
        'events': events,
        'profile': {'genre': genre, 'intensity': round(intensity, 2), 'source': source},
    }
