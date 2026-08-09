#!/usr/bin/env python
"""Portable Kokoro TTS daemon for Rainy DJ — cross-platform.

Protocol (compatible with hermes docker's /opt/data/.tts/kokoro_daemon.py):
  - On start, load the TTS model, then print "READY" to stdout.
  - Loop: read one JSON line from stdin: {"text": "...", "out": "/path.wav", "voice": "af_heart", "speed": 1.0}
  - Synthesize to the given wav path, print "OK" on success or "ERROR: ..." on failure.
  - Runs forever until stdin closes.

Tries backends in order:
  1. `kokoro` (hexgrad) + misaki — best quality, needs espeak-ng
  2. `kokoro-onnx` — lighter, ONNX runtime, no espeak needed for some builds
  3. If neither is installed, prints an error and exits (dj.py will degrade to text-only).

Desktop usage:
  pip install kokoro          # or: pip install kokoro-onnx
  python utils/kokoro_daemon.py   # should print READY

Hermes docker keeps using /opt/data/.tts/kokoro_daemon.py if present; this
file is the fallback for Windows / plain installs.
"""

import json
import os
import sys
import traceback

# --- backend detection ---

_BACKEND = None
_PIPELINE = None
_KOKORO_ONNX = None
_SAMPLE_RATE = 24000

# Voice normalization: hermes uses am_fenrir (male) etc. Both backends use
# af_/am_ voices; we pass through unknown voices and let the backend error.
DEFAULT_VOICE = os.environ.get("DJ_VOICE", "af_heart")


def _init_backend():
    global _BACKEND, _PIPELINE, _KOKORO_ONNX, _SAMPLE_RATE

    # Try `kokoro` (hexgrad) first — preferred on hermes
    try:
        from kokoro import KPipeline  # type: ignore

        # KPipeline language code: 'a' = American English, 'b' = British
        # Voices like am_fenrir / af_heart are American.
        try:
            _PIPELINE = KPipeline(lang_code="a")
            # Quick smoke test — don't synthesize yet, just confirm import works
            _BACKEND = "kokoro"
            print("[kokoro-daemon] backend=kokoro (KPipeline)", file=sys.stderr, flush=True)
            return True
        except Exception as e:
            print(f"[kokoro-daemon] kokoro KPipeline init failed: {e}", file=sys.stderr, flush=True)
            _PIPELINE = None
    except ImportError:
        pass
    except Exception as e:
        print(f"[kokoro-daemon] kokoro import failed: {e}", file=sys.stderr, flush=True)

    # Try kokoro-onnx
    try:
        from kokoro_onnx import Kokoro  # type: ignore

        # Model files are auto-downloaded to huggingface cache on first use
        # if not present. Try default locations.
        model_path = os.environ.get("KOKORO_ONNX_MODEL", "")
        voices_path = os.environ.get("KOKORO_ONNX_VOICES", "")

        # If no explicit paths, let Kokoro use its default (downloads from HF)
        try:
            if model_path and voices_path:
                _KOKORO_ONNX = Kokoro(model_path, voices_path)
            else:
                # Kokoro() with no args tries to find/download default model
                _KOKORO_ONNX = Kokoro()
            _BACKEND = "kokoro-onnx"
            print("[kokoro-daemon] backend=kokoro-onnx", file=sys.stderr, flush=True)
            return True
        except TypeError:
            # Older API may require explicit paths — try alternative init
            try:
                _KOKORO_ONNX = Kokoro(model_path or "kokoro-v1.0.onnx", voices_path or "voices.json")
                _BACKEND = "kokoro-onnx"
                print("[kokoro-daemon] backend=kokoro-onnx (explicit paths)", file=sys.stderr, flush=True)
                return True
            except Exception as e2:
                print(f"[kokoro-daemon] kokoro-onnx init failed: {e2}", file=sys.stderr, flush=True)
                _KOKORO_ONNX = None
        except Exception as e:
            print(f"[kokoro-daemon] kokoro-onnx init failed: {e}", file=sys.stderr, flush=True)
            _KOKORO_ONNX = None
    except ImportError:
        pass
    except Exception as e:
        print(f"[kokoro-daemon] kokoro-onnx import failed: {e}", file=sys.stderr, flush=True)

    return False


def _synthesize_kokoro(text, voice, speed, out_path):
    """Synthesize via `kokoro` KPipeline."""
    import soundfile as sf
    import numpy as np

    # KPipeline yields (graphemes, phonemes, audio) tuples
    # Voice selection is per-chunk; we just use the requested voice.
    # Normalize voice: some callers send am_fenrir, KPipeline expects same.
    voice = (voice or DEFAULT_VOICE).strip() or DEFAULT_VOICE

    chunks = list(_PIPELINE(text, voice=voice))
    if not chunks:
        raise RuntimeError("KPipeline produced no audio")

    # Concatenate all chunk audios
    audios = []
    for _, _, audio in chunks:
        if audio is not None:
            audios.append(audio)
    if not audios:
        raise RuntimeError("KPipeline chunks had no audio data")

    # Handle torch tensors vs numpy arrays
    combined = []
    for a in audios:
        if hasattr(a, "detach"):
            a = a.detach().cpu().numpy()
        combined.append(a)

    import numpy as np

    wav = np.concatenate(combined, axis=0)
    # Ensure float32
    wav = wav.astype("float32")

    # Speed adjustment via simple resampling if speed != 1.0
    if speed and abs(speed - 1.0) > 0.01:
        try:
            import librosa

            wav = librosa.effects.time_stretch(wav, rate=float(speed))
        except Exception:
            # If librosa not available or fails, ignore speed
            pass

    sf.write(out_path, wav, _SAMPLE_RATE)
    return out_path


def _synthesize_onnx(text, voice, speed, out_path):
    """Synthesize via `kokoro-onnx`."""
    import soundfile as sf

    voice = (voice or DEFAULT_VOICE).strip() or DEFAULT_VOICE
    # kokoro-onnx create() returns (audio, sample_rate) or just audio
    result = _KOKORO_ONNX.create(text, voice=voice, speed=float(speed or 1.0))
    if isinstance(result, tuple):
        audio, sr = result
    else:
        audio, sr = result, _SAMPLE_RATE

    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()

    import numpy as np

    audio = np.asarray(audio, dtype=np.float32)
    sf.write(out_path, audio, int(sr))
    return out_path


def _synthesize(text, voice, speed, out_path):
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")

    # Ensure output directory exists
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    if _BACKEND == "kokoro":
        return _synthesize_kokoro(text, voice, speed, out_path)
    elif _BACKEND == "kokoro-onnx":
        return _synthesize_onnx(text, voice, speed, out_path)
    else:
        raise RuntimeError(f"no TTS backend available (tried kokoro, kokoro-onnx)")


def main():
    ok = _init_backend()
    if not ok:
        # Tell parent we failed — dj.py will degrade to text-only
        print("ERROR: no TTS backend installed (pip install kokoro or kokoro-onnx)", flush=True)
        sys.exit(1)

    # Signal readiness — dj.py blocks until it sees this
    print("READY", flush=True)

    # Main loop: one JSON object per line
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req.get("text", "")
            out = req.get("out", "")
            voice = req.get("voice", DEFAULT_VOICE)
            speed = req.get("speed", 1.0)

            if not out:
                print("ERROR: missing 'out' path", flush=True)
                continue

            _synthesize(text, voice, speed, out)

            if os.path.isfile(out):
                print("OK", flush=True)
            else:
                print(f"ERROR: output not created: {out}", flush=True)

        except Exception as e:
            # Never crash the daemon on a bad request — log and continue
            err = str(e).replace("\n", " ")[:500]
            print(f"ERROR: {err}", flush=True)
            traceback.print_exc(file=sys.stderr)

    # stdin closed — parent died
    sys.exit(0)


if __name__ == "__main__":
    main()
