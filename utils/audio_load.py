"""Decode an audio file to a mono float32 waveform for the analysers.

librosa reads through libsndfile, which has no AAC decoder: .m4a files (the
song radio downloads YouTube's native AAC) fail with "Format not recognised".
Its own fallback for those, audioread, is deprecated and goes away in librosa
1.0, so anything libsndfile can't open is decoded with the ffmpeg CLI — the
same binary yt-dlp and the lyrics aligner already need.
"""
import os
import subprocess

import numpy as np

# Containers libsndfile has no decoder for; these skip straight to ffmpeg.
_FFMPEG_ONLY = {'.m4a', '.mp4', '.aac', '.wma', '.mkv', '.webm'}


def _ffmpeg_load(file_path, sr):
    proc = subprocess.run(
        ['ffmpeg', '-nostdin', '-v', 'error', '-i', file_path, '-vn',
         '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '1', '-ar', str(sr), '-'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode('utf-8', 'replace').strip().splitlines()
        raise RuntimeError(f"ffmpeg could not decode {os.path.basename(file_path)}: "
                           f"{detail[-1] if detail else 'no audio'}")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def load_audio(file_path, sr):
    """(samples, sr): the file as mono float32 at `sr` Hz. Raises if it
    can't be decoded."""
    if os.path.splitext(file_path)[1].lower() in _FFMPEG_ONLY:
        return _ffmpeg_load(file_path, sr), sr
    import soundfile
    import librosa
    try:
        data, native = soundfile.read(file_path, dtype='float32', always_2d=True)
    except Exception as e:  # noqa: BLE001
        try:
            return _ffmpeg_load(file_path, sr), sr
        except Exception:  # noqa: BLE001
            raise e
    y = np.ascontiguousarray(data.mean(axis=1))
    if native != sr:
        y = librosa.resample(y, orig_sr=native, target_sr=sr)
    return y, sr
