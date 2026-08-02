"""Local audio analysis with librosa — source-agnostic feature extraction.

Analyzes the actual audio file, so it works for any song regardless of where
it came from (YouTube import, Spotify import, local rip, etc.). No network
calls, no API keys. Extracts the numeric descriptors that power content-based
similarity and the future AI DJ.

librosa is pure Python with binary wheels for Windows/macOS/Linux, so this
runs everywhere (unlike essentia, which has no Windows build). Mood/genre
labels still come from Last.fm tags — human consensus beats a small classifier
training set.
"""
import numpy as np

# librosa is imported lazily inside analyze_file so a missing/broken install
# degrades gracefully (enrichment just skips the audio step) instead of
# crashing the whole app at import time.
_librosa_checked = False
_librosa_missing_reason = None

# Krumhansl-Schmuckler key profiles (major / minor) for key detection.
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def _detect_key(chroma):
    """Krumhansl-Schmuckler key finding from a chroma matrix.

    Returns (key_name, scale_type, strength); strength is the best profile
    correlation normalised to roughly 0..1.
    """
    mean_chroma = np.mean(chroma, axis=1)
    if not np.any(mean_chroma):
        return None, None, None
    best_corr, best_key, best_scale = -2.0, None, None
    for shift in range(12):
        rotated = np.roll(mean_chroma, -shift)
        for profile, scale in ((_MAJOR_PROFILE, 'major'), (_MINOR_PROFILE, 'minor')):
            corr = float(np.corrcoef(rotated, profile)[0, 1])
            if corr > best_corr:
                best_corr, best_key, best_scale = corr, _PITCH_CLASSES[shift], scale
    strength = max(0.0, min(1.0, (best_corr + 1.0) / 2.0))
    return best_key, best_scale, round(strength, 3)


def analyze_file(file_path):
    """Analyze one audio file and return a feature dict.

    Keys match SongFeaturesModel.NUMERIC_COLUMNS plus `mfccs` (a list of 13
    floats — the mean MFCC timbre fingerprint). Returns None if the file
    can't be read or librosa is unavailable.
    """
    global _librosa_checked, _librosa_missing_reason
    try:
        import librosa
    except Exception as e:  # noqa: BLE001
        # Warn once instead of spamming the log for every song in a backfill.
        if not _librosa_checked:
            print(f"[audio-analyzer] librosa unavailable, audio analysis "
                  f"disabled for this session: {e}")
        _librosa_checked = True
        _librosa_missing_reason = str(e)
        return None

    try:
        y, sr = librosa.load(file_path, sr=44100, mono=True)
        if y is None or len(y) == 0:
            return None

        features = {}
        beats = None

        # Tempo (BPM) + a confidence proxy from the tempogram's peak clarity.
        try:
            tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
            features['tempo_bpm'] = round(float(np.atleast_1d(tempo)[0]), 1)
            # Confidence proxy: how much the dominant tempo peak stands out
            # above the average tempogram bin, squashed into 0..1.
            tempogram = np.mean(librosa.feature.tempogram(y=y, sr=sr), axis=1)
            mean = float(np.mean(tempogram))
            if mean > 0:
                clarity = float(np.max(tempogram)) / (mean + 1e-10)
                features['tempo_confidence'] = round(clarity / (1.0 + clarity), 3)
        except Exception:  # noqa: BLE001
            pass

        # Musical key + scale (major/minor) via Krumhansl-Schmuckler.
        try:
            chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
            key_name, scale_type, key_strength = _detect_key(chroma)
            features['key_name'] = key_name
            features['scale_type'] = scale_type
            features['key_strength'] = key_strength
        except Exception:  # noqa: BLE001
            pass

        # Danceability proxy — regularity of the beat spacing (0..1).
        try:
            if beats is not None and len(beats) > 3:
                intervals = np.diff(librosa.frames_to_time(beats, sr=sr))
                mean_i = float(np.mean(intervals))
                if mean_i > 0:
                    cv = float(np.std(intervals) / mean_i)
                    features['danceability'] = round(float(np.clip(1.0 - cv, 0.0, 1.0)), 3)
        except Exception:  # noqa: BLE001
            pass

        # Loudness (RMS -> dB).
        try:
            rms = float(np.mean(librosa.feature.rms(y=y)[0]))
            features['loudness_db'] = round(20 * np.log10(rms + 1e-10), 1)
        except Exception:  # noqa: BLE001
            pass

        # Energy (raw signal power).
        try:
            features['energy'] = round(float(np.sum(y ** 2)), 3)
        except Exception:  # noqa: BLE001
            pass

        # Spectral centroid (brightness: low = warm, high = bright).
        try:
            features['spectral_centroid'] = round(
                float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)[0])), 1)
        except Exception:  # noqa: BLE001
            pass

        # Spectral rolloff (how much high-frequency content).
        try:
            features['spectral_rolloff'] = round(
                float(np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr)[0])), 1)
        except Exception:  # noqa: BLE001
            pass

        # Spectral complexity proxy — spectral bandwidth (spread of energy).
        try:
            features['spectral_complexity'] = round(
                float(np.mean(librosa.feature.spectral_bandwidth(y=y, sr=sr)[0])), 1)
        except Exception:  # noqa: BLE001
            pass

        # Zero-crossing rate (percussive vs tonal).
        try:
            features['zero_crossing_rate'] = round(
                float(np.mean(librosa.feature.zero_crossing_rate(y)[0])), 6)
        except Exception:  # noqa: BLE001
            pass

        # MFCC timbre fingerprint — averaged across the track.
        try:
            mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
            mean_coeffs = np.mean(mfcc, axis=1)
            features['mfccs'] = [round(float(c), 3) for c in mean_coeffs[:13]]
        except Exception:  # noqa: BLE001
            pass

        return features if features else None

    except Exception as e:  # noqa: BLE001
        print(f"[audio-analyzer] failed to analyze {file_path}: {e}")
        return None
