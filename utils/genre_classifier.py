"""Local genre classification using the pre-trained Discogs-EffNet model.

Runs entirely on this machine — no API keys, no cloud calls. The model
(discogs-effnet-bsdynamic-1.onnx, 18 MB) classifies a song's audio into the
400 Discogs music-style labels (e.g. "Rock---Power Metal", "Hip Hop---Pop
Rap", "Electronic---Latin").

Pipeline (mirrors essentia's own TensorflowPredictEffnetDiscogs, but built
on librosa so it runs on Windows too — essentia has no Windows wheels):
  1. Load at 16 kHz mono (the model was trained on 16 kHz mono).
  2. musicnn-style mel-spectrogram: 512-sample frames, 256-sample hop,
     96 mel bands — a re-implementation of essentia's
     TensorflowInputMusiCNN (Hann window, power spectrum, Slaney mel
     bands with unit-area triangles, log10(1 + 10000·x)).
  3. Slide 128-frame patches (patch hop 512) over the whole track and
     mean-pool the sigmoid activations so the verdict covers the song's
     full length, not just its first 2 seconds.
  4. Map activations -> top labels via the bundled classes list.

Model files live in classifier/ (gitignored). If missing, they are
downloaded from essentia.upf.edu on first use.
"""
import json
import os
import threading
import urllib.request

import numpy as np

_MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'classifier')
_MODEL_URL = ('https://essentia.upf.edu/models/legacy/music-style-classification/'
              'discogs-effnet/discogs-effnet-bsdynamic-1.onnx')
_LABELS_URL = ('https://essentia.upf.edu/models/legacy/music-style-classification/'
               'discogs-effnet/discogs-effnet-bsdynamic-1.json')

MODEL_PATH = os.path.join(_MODEL_DIR, 'discogs-effnet.onnx')
LABELS_PATH = os.path.join(_MODEL_DIR, 'discogs-effnet.json')

# Musicnn-style mel-spectrogram parameters (hardcoded in essentia's
# TensorflowPredictEffnetDiscogs — "we used MusiCNN style mel-spectrograms").
SAMPLE_RATE = 16000
FRAME_SIZE = 512
HOP_SIZE = 256
N_MEL_BANDS = 96
PATCH_SIZE = 128      # frames per patch -> [1, 128, 96] model input
PATCH_HOP = 512       # frames between patches (~4 s of audio)

_TOP_GENRES = 3       # how many labels to store as tags
_GENRE_MIN_WEIGHT = 5  # ignore activations below ~5%

_lock = threading.Lock()
_session = None
_classes = None
_mel_basis = None
_window = None


def _download(url, dest):
    """Fetch a model file into classifier/ (atomic-ish, one-time)."""
    tmp = dest + '.tmp'
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, dest)


def _ensure_files():
    if not os.path.isfile(MODEL_PATH):
        os.makedirs(_MODEL_DIR, exist_ok=True)
        _download(_MODEL_URL, MODEL_PATH)
    if not os.path.isfile(LABELS_PATH):
        os.makedirs(_MODEL_DIR, exist_ok=True)
        _download(_LABELS_URL, LABELS_PATH)


def _load():
    """Lazily initialise the ONNX session, labels and mel filterbank."""
    global _session, _classes, _mel_basis, _window
    with _lock:
        if _session is not None:
            return
        _ensure_files()
        import onnxruntime as ort
        import librosa
        from scipy.signal import get_window
        # essentia's MelBands(warpingFormula='slaneyMel', normalize='unit_tri',
        # 0-8000 Hz) == librosa's Slaney filterbank.
        _mel_basis = librosa.filters.mel(
            sr=SAMPLE_RATE, n_fft=FRAME_SIZE, n_mels=N_MEL_BANDS,
            fmin=0.0, fmax=SAMPLE_RATE / 2, htk=False, norm='slaney',
        ).astype(np.float32)
        # essentia's Windowing('hann', normalized=False) is the symmetric form.
        _window = get_window('hann', FRAME_SIZE, fftbins=False)
        with open(LABELS_PATH, encoding='utf-8') as f:
            _classes = json.load(f)['classes']
        _session = ort.InferenceSession(
            MODEL_PATH, providers=['CPUExecutionProvider'])


def _mel_bands(audio):
    """Compute the [n_frames, 96] mel-band matrix for a 16 kHz mono signal."""
    import librosa
    if len(audio) < FRAME_SIZE:
        return None
    # Power spectrum, like musicnn's original librosa front end — a
    # magnitude spectrum skews every track towards 'Electronic'.
    spec = np.abs(librosa.stft(
        audio, n_fft=FRAME_SIZE, hop_length=HOP_SIZE,
        window=_window, center=False)) ** 2
    mel = _mel_basis @ spec
    return np.log10(1.0 + 10000.0 * mel).T.astype(np.float32)


def classify_file(path, top_n=_TOP_GENRES):
    """Classify an audio file, returning [(label, weight0-100), ...].

    Labels are Discogs style: "Genre---Subgenre" (or just "Genre").
    Returns [] on any failure (missing file, decode error, too short).
    """
    try:
        _load()
        import librosa
        audio, _sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    except Exception as e:  # noqa: BLE001
        print(f"[genre-classifier] load failed for {os.path.basename(path)}: {e}")
        return []

    bands = _mel_bands(audio)
    if bands is None or bands.shape[0] < PATCH_SIZE:
        return []

    patches = [
        bands[i:i + PATCH_SIZE][None, ...]
        for i in range(0, bands.shape[0] - PATCH_SIZE + 1, PATCH_HOP)
    ]
    try:
        act_sum = np.zeros(len(_classes), dtype=np.float32)
        for p in patches:
            act_sum += _session.run(['activations'], {'melspectrogram': p})[0][0]
        acts = act_sum / len(patches)
    except Exception as e:  # noqa: BLE001
        print(f"[genre-classifier] inference failed for {os.path.basename(path)}: {e}")
        return []

    order = np.argsort(acts)[::-1]
    out = []
    for i in order:
        w = int(round(float(acts[i]) * 100))
        if w < _GENRE_MIN_WEIGHT or len(out) >= top_n:
            break
        out.append((_classes[i], w))
    return out


def top_level_genre(results):
    """Return the coarse genre ('Rock' from 'Rock---Power Metal'), or None."""
    for label, _w in results:
        genre = label.split('---')[0].strip()
        if genre:
            return genre
    return None
