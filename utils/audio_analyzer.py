"""Local audio analysis with essentia — source-agnostic feature extraction.

Analyzes the actual audio file, so it works for any song regardless of where
it came from (YouTube import, Spotify import, local rip, etc.). No network
calls, no API keys. Extracts the numeric descriptors that power content-based
similarity and the future AI DJ.

essentia's pip build is signal-processing only (no bundled mood/genre SVM
classifiers), so mood/genre labels come from Last.fm tags instead — which is
more accurate anyway (human consensus vs. a small training set).
"""
import json

import numpy as np

# essentia is imported lazily inside analyze_file so a missing/broken install
# degrades gracefully (enrichment just skips the audio step) instead of
# crashing the whole app at import time.


def _mean(x):
    """essentia returns scalars for some algorithms and arrays for others."""
    if isinstance(x, np.ndarray):
        return float(x.mean())
    return float(x)


def analyze_file(file_path):
    """Analyze one audio file and return a feature dict.

    Keys match SongFeaturesModel.NUMERIC_COLUMNS plus `mfccs` (a list of 13
    floats — the mean MFCC timbre fingerprint). Returns None if the file
    can't be read or essentia is unavailable.
    """
    try:
        import essentia.standard as es
    except Exception as e:  # noqa: BLE001
        print(f"[audio-analyzer] essentia unavailable, skipping: {e}")
        return None

    try:
        mono = es.MonoLoader(filename=file_path, sampleRate=44100)()
        if mono is None or len(mono) == 0:
            return None

        features = {}

        # Tempo (BPM) + confidence
        try:
            bpm, _ticks, conf, _est, _ints = es.RhythmExtractor2013(
                method='multifeature')(mono)
            features['tempo_bpm'] = round(float(bpm), 1)
            features['tempo_confidence'] = round(float(conf), 3)
        except Exception:  # noqa: BLE001
            pass

        # Musical key + scale (major/minor) + strength
        try:
            key, scale, strength = es.KeyExtractor()(mono)
            features['key_name'] = str(key)
            features['scale_type'] = str(scale)
            features['key_strength'] = round(float(strength), 3)
        except Exception:  # noqa: BLE001
            pass

        # Danceability (rhythmic feel)
        try:
            d_val, _d_str = es.Danceability()(mono)
            features['danceability'] = round(float(d_val), 3)
        except Exception:  # noqa: BLE001
            pass

        # Loudness (RMS -> dB). EBU R128 needs a specific stereo format that
        # the pip build is fussy about; RMS dB is robust and good enough.
        try:
            rms = float(np.sqrt(np.mean(mono ** 2)))
            features['loudness_db'] = round(20 * np.log10(rms + 1e-10), 1)
        except Exception:  # noqa: BLE001
            pass

        # Energy (raw signal power)
        try:
            features['energy'] = round(_mean(es.Energy()(mono)), 3)
        except Exception:  # noqa: BLE001
            pass

        # Spectral centroid (brightness: low = warm, high = bright)
        try:
            features['spectral_centroid'] = round(
                _mean(es.SpectralCentroidTime()(mono)), 1)
        except Exception:  # noqa: BLE001
            pass

        # Spectral rolloff (how much high-frequency content)
        try:
            features['spectral_rolloff'] = round(
                _mean(es.SpectralRolloffTime()(mono)), 1)
        except Exception:  # noqa: BLE001
            pass

        # Spectral complexity (how busy/rich the texture is)
        try:
            features['spectral_complexity'] = round(
                _mean(es.SpectralComplexity()(mono)), 1)
        except Exception:  # noqa: BLE001
            pass

        # Zero-crossing rate (percussive vs tonal)
        try:
            features['zero_crossing_rate'] = round(
                _mean(es.ZeroCrossingRate()(mono)), 6)
        except Exception:  # noqa: BLE001
            pass

        # MFCC timbre fingerprint — proper frame-based extraction, averaged
        # across the track. Subsample frames to keep it fast on long songs.
        # Audio is scaled to 16-bit range so the spectrum has real magnitude;
        # MonoLoader normalises to [-1,1] which collapses the MFCC log step.
        try:
            window = es.Windowing(type='hann')
            spectrum = es.Spectrum()
            mfcc = es.MFCC(numberCoefficients=13)
            audio = mono * 32768.0
            frame_size = 2048
            hop = 2048
            step = 10  # analyse every 10th frame (~enough for a stable mean)
            coeffs_list = []
            n_frames = (len(audio) - frame_size) // hop
            for i in range(0, n_frames, step):
                start = i * hop
                frame = audio[start:start + frame_size]
                spec = spectrum(window(frame))
                c, _bands = mfcc(spec)
                coeffs_list.append(np.asarray(c))
            if coeffs_list:
                mean_coeffs = np.mean(coeffs_list, axis=0)
                features['mfccs'] = [round(float(c), 3) for c in mean_coeffs[:13]]
        except Exception:  # noqa: BLE001
            pass

        return features if features else None

    except Exception as e:  # noqa: BLE001
        print(f"[audio-analyzer] failed to analyze {file_path}: {e}")
        return None
