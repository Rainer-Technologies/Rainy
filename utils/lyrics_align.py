"""
Server-side forced alignment of known lyric lines to song audio.

Uses faster-whisper (via stable-ts) to get word-level timestamps, then maps
those timestamps onto the app's own lyric tokens so the frontend can light
words up in time. Model is a lazy singleton and inference is serialized with
a lock so concurrent requests don't stomp on the CPU/GPU.
"""
import os
import re
import threading
import time

_MODEL_NAME = os.environ.get('RAINY_WHISPER_MODEL', 'base')
_LOG_PREFIX = '[lyrics-align]'


def _log(msg):
    print(f'{_LOG_PREFIX} {msg}', flush=True)

_model = None
_model_lock = threading.Lock()
_infer_lock = threading.Lock()


def _device_and_compute():
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return 'cuda', 'float16'
    except Exception:
        pass
    return 'cpu', 'int8'


def _get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                import stable_whisper
                device, compute = _device_and_compute()
                _log(f'loading whisper model "{_MODEL_NAME}" '
                     f'(device={device}, compute={compute}) — first request only, '
                     f'downloads model if not cached…')
                t0 = time.time()
                _model = stable_whisper.load_faster_whisper(
                    _MODEL_NAME, device=device, compute_type=compute)
                _log(f'whisper model ready in {time.time() - t0:.1f}s')
    return _model


def _decode_waveform(audio_path):
    """Decode the audio file to a 16kHz mono float32 numpy array (once)."""
    try:
        import numpy as np
        import stable_whisper.alignment as al
        t0 = time.time()
        wf = al.prep_audio(audio_path)
        if hasattr(wf, 'detach'):
            wf = wf.detach().cpu().numpy()
        wf = np.asarray(wf, dtype=np.float32)
        if wf.ndim > 1:
            wf = wf.mean(axis=0)
        _log(f'decoded audio in {time.time() - t0:.1f}s '
             f'({len(wf) / 16000:.1f}s, {len(wf)} samples)')
        return wf
    except Exception as e:
        _log(f'audio decode failed: {e}')
        return None


def _detect_language(model, waveform):
    """Cheap language detection from the first 30s of the waveform."""
    try:
        seg = waveform[:30 * 16000]
        lang, prob, _all = model.detect_language(audio=seg)
        _log(f'detected language={lang!r} (confidence={float(prob):.2f})')
        return lang or None
    except Exception as e:
        _log(f'language detection failed: {e}')
        return None


def _norm(token):
    """Lowercase alphanumeric normalization for fuzzy word matching."""
    return re.sub(r"[^\w'’\-]+", '', (token or '').lower())


def _tokens_for_line(text):
    """Tokenize a lyric line exactly like the frontend (_lineWords)."""
    words = [t for t in re.split(r'\s+', (text or '').strip()) if t]
    return words if words else ['♪']


def _fill_gaps(times):
    """Interpolate None entries, then enforce a non-decreasing sequence."""
    n = len(times)
    # Forward/backward fill indices of known values
    known = [i for i, t in enumerate(times) if t is not None]
    if not known:
        return None
    first, last = known[0], known[-1]
    for i in range(first):
        times[i] = times[first]
    for i in range(last + 1, n):
        times[i] = times[last]
    # Interpolate interior gaps
    prev = first
    for i in range(first + 1, last + 1):
        if times[i] is not None:
            prev = i
            continue
        # find next known
        nxt = prev + 1
        while nxt <= last and times[nxt] is None:
            nxt += 1
        if nxt > last:
            times[i] = times[prev]
        else:
            frac = (i - prev) / (nxt - prev)
            times[i] = times[prev] + frac * (times[nxt] - times[prev])
    # Enforce monotonic non-decreasing
    for i in range(1, n):
        if times[i] < times[i - 1]:
            times[i] = times[i - 1]
    return times


def _proportional_map(flat_tokens, aligned_words, field=1):
    n = len(flat_tokens)
    m = len(aligned_words)
    if m == 0:
        return None
    times = []
    for i in range(n):
        j = round(i * (m - 1) / (n - 1)) if n > 1 else 0
        times.append(aligned_words[j][field])
    # Enforce monotonic
    for i in range(1, n):
        if times[i] < times[i - 1]:
            times[i] = times[i - 1]
    return times


def align_lyrics_words(audio_path, lines):
    """Align lyric lines to the audio file.

    Args:
        audio_path: absolute path to the audio file.
        lines: list of lyric line strings, in order.

    Returns:
        A list (same length as `lines`) of lists of [start, end] pairs
        (seconds), one per token in that line, or None if alignment produced
        nothing.
    """
    if not lines or not audio_path or not os.path.exists(audio_path):
        _log(f'abort: bad input (lines={len(lines) if lines else 0}, '
             f'audio_exists={bool(audio_path and os.path.exists(audio_path))})')
        return None

    _log(f'start: {len(lines)} lyric lines, file={os.path.basename(audio_path)}')
    model = _get_model()
    with _infer_lock:
        waveform = _decode_waveform(audio_path)
        if waveform is None:
            _log('abort: decode returned no waveform')
            return None
        language = _detect_language(model, waveform)
        if not language:
            _log('abort: no language detected')
            return None
        t0 = time.time()
        result = model.align(waveform, '\n'.join(lines), language=language)
        _log(f'align() finished in {time.time() - t0:.1f}s')

    if result is None or not getattr(result, 'segments', None):
        _log('abort: align returned no segments')
        return None

    aligned_words = []
    for seg in result.segments:
        for w in (getattr(seg, 'words', None) or []):
            st = getattr(w, 'start', None)
            if st is None:
                continue
            en = getattr(w, 'end', None)
            aligned_words.append((
                getattr(w, 'word', '') or '',
                float(st),
                float(en) if en is not None else float(st)))
    if not aligned_words:
        _log('abort: align produced no word timestamps')
        return None
    _log(f'whisper gave {len(result.segments)} segment(s), '
         f'{len(aligned_words)} word timestamp(s)')

    tokens_per_line = [_tokens_for_line(ln) for ln in lines]
    flat = [t for toks in tokens_per_line for t in toks]
    n = len(flat)
    m = len(aligned_words)
    if n == 0:
        _log('abort: no lyric tokens')
        return None

    times = [None] * n
    ends = [None] * n
    strategy = 'proportional'

    # Order-preserving fuzzy text match, when we have enough words to be useful.
    if m >= max(3, n // 2):
        ti = 0
        window = 8
        for wtext, st, en in aligned_words:
            nt = _norm(wtext)
            if not nt:
                continue
            found = -1
            for j in range(ti, min(n, ti + window)):
                if times[j] is None and _norm(flat[j]) == nt:
                    found = j
                    break
            if found >= 0:
                times[found] = st
                ends[found] = en
                ti = found + 1

    matched = sum(1 for t in times if t is not None)
    if matched < max(1, n // 3):
        # Too few text matches — fall back to order-based proportional mapping.
        times = _proportional_map(flat, aligned_words, 1)
        ends = _proportional_map(flat, aligned_words, 2)
        strategy = 'proportional'
    else:
        times = _fill_gaps(times)
        ends = _fill_gaps(ends)
        strategy = 'greedy'

    if times is None or any(t is None for t in times):
        times = _proportional_map(flat, aligned_words, 1)
        ends = _proportional_map(flat, aligned_words, 2)
        strategy = 'proportional (gap-fill fallback)'
    if times is None:
        _log('abort: mapping produced no times')
        return None
    if ends is None or any(e is None for e in ends):
        ends = list(times)

    _log(f'mapping: {n} tokens vs {m} whisper words -> '
         f'{matched} text matches, strategy={strategy}')

    # Clamp to >= 0
    times = [max(0.0, float(t)) for t in times]
    ends = [max(0.0, float(e)) for e in ends]

    out = []
    idx = 0
    for toks in tokens_per_line:
        cnt = len(toks)
        line_pairs = []
        for k in range(cnt):
            s = times[idx + k]
            e = ends[idx + k]
            if e < s:
                e = s
            if k + 1 < cnt:
                nxt = times[idx + k + 1]
                if e > nxt:
                    e = nxt
            elif e <= s:
                e = s + 0.5
            line_pairs.append([round(s, 3), round(e, 3)])
        out.append(line_pairs)
        idx += cnt
    _log(f'done: word times for {len(out)} lines '
         f'(first line {len(out[0])} words, '
         f'range {times[0]:.2f}s–{ends[-1]:.2f}s)')
    return out
