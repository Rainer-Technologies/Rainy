"""
Word-level timing for synced (LRC) lyrics, anchored to the LRC line times.

Whisper (via stable-ts) is used as a *forced aligner*: it is handed the known
lyric text and only decides where each word falls in the audio. Aligning a
whole song in one go drifts badly on music (words pile up early and every
later line inherits the error), so instead:

  1. Lines are grouped into short windows (~18 s of lyrics) cut out of the
     audio using the LRC timestamps as anchors. Neighbouring windows overlap
     by one line, so every line start is an *internal* boundary of some window
     (Whisper cannot place the very first word of a window — it just snaps to
     the window edge).
  2. Every line is validated against its LRC time. A line that landed
     somewhere implausible is re-aligned on its own in a tight window, and if
     that fails too its words are spread over the line by length.
  3. Lines whose first word Whisper could not place (the first line of the
     song, re-aligned lines) start at their LRC time.

The result keeps the existing storage format: a list (one entry per LRC line)
of ``[start, end]`` pairs (seconds), one per whitespace-separated token —
exactly how the frontend tokenizes a line.
"""
import contextlib
import io
import os
import re
import threading
import time

import numpy as np

# Bump when the algorithm changes in a way that should re-align stored songs.
ALIGN_VERSION = 2

SR = 16000
_MODEL_NAME = os.environ.get('RAINY_WHISPER_MODEL', 'base')
_LANG_OVERRIDE = os.environ.get('RAINY_LYRICS_LANG', '').strip().lower() or None
_LOG_PREFIX = '[lyrics-align]'

CHUNK_SPAN = 18.0        # seconds of lyrics per alignment window
PAD_BEFORE = 0.8         # audio kept before the first line of a window
PAD_AFTER = 1.0          # ...and after the last one
MAX_LINE_SPAN = 12.0     # longest a single line is assumed to be sung
MAX_START_DEV = 1.5      # a line starting further than this from its LRC time is suspect
MAX_OVERRUN = 1.5        # ...and so is one that runs this far into the next line
MIN_WORD = 0.06          # shortest word we keep
FAIL_RATIO = 0.5         # give up when this share of sung lines can't be aligned

# Scripts Whisper commonly reports for songs whose lyrics are romanised.
_NON_LATIN = {
    'ja', 'zh', 'yue', 'ko', 'ar', 'fa', 'ur', 'he', 'yi', 'ru', 'uk', 'be', 'bg',
    'sr', 'mk', 'mn', 'kk', 'ky', 'tg', 'th', 'lo', 'km', 'my', 'hi', 'mr', 'ne',
    'bn', 'pa', 'gu', 'ta', 'te', 'kn', 'ml', 'si', 'el', 'hy', 'ka', 'am',
}


class AlignmentError(Exception):
    """The audio/lyrics pair could not be aligned reliably."""


def _log(msg):
    print(f'{_LOG_PREFIX} {msg}', flush=True)


# --------------------------------------------------------------------- model

_model = None
_model_lock = threading.Lock()
_infer_lock = threading.Lock()


def _register_cuda_dlls():
    """Make pip-installed CUDA libs (nvidia-cublas-cu12, nvidia-cudnn-cu12, ...)
    visible to CTranslate2 on Windows, where they are not on PATH by default."""
    if os.name != 'nt':
        return
    import sys
    for base in {p for p in sys.path if p.endswith('site-packages')}:
        nv = os.path.join(base, 'nvidia')
        if not os.path.isdir(nv):
            continue
        for pkg in os.listdir(nv):
            bindir = os.path.join(nv, pkg, 'bin')
            if os.path.isdir(bindir):
                try:
                    os.add_dll_directory(bindir)
                except (OSError, AttributeError):
                    pass
                os.environ['PATH'] = bindir + os.pathsep + os.environ.get('PATH', '')


def _detect_device():
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return 'cuda'
    except Exception:  # noqa: BLE001
        pass
    return 'cpu'


def _compute_candidates(device):
    """Ordered compute types to try; GPUs differ in what they support."""
    if device == 'cuda':
        return ['float16', 'int8_float16', 'float32']
    return ['int8']


def _smoke_test(model):
    """Run one tiny inference. Loading a model succeeds even when CUDA's
    runtime libraries are missing — it only blows up on the first real call."""
    model.detect_language(audio=np.zeros(SR * 3, dtype=np.float32))


def _load_model():
    import stable_whisper
    _register_cuda_dlls()
    device = _detect_device()
    attempts = [(device, c) for c in _compute_candidates(device)]
    if device != 'cpu':
        attempts.append(('cpu', 'int8'))
    last_err = None
    gpu_broken = False
    for dev, compute in attempts:
        if dev == 'cuda' and gpu_broken:
            continue
        try:
            _log(f'loading whisper model "{_MODEL_NAME}" (device={dev}, compute={compute}) '
                 f'— downloads the model on first use')
            t0 = time.time()
            model = stable_whisper.load_faster_whisper(_MODEL_NAME, device=dev, compute_type=compute)
            _smoke_test(model)
            _log(f'whisper model ready in {time.time() - t0:.1f}s ({dev}/{compute})')
            return model
        except Exception as e:  # noqa: BLE001
            last_err = e
            _log(f'{dev}/{compute} unusable ({e})')
            msg = str(e).lower()
            if dev == 'cuda' and any(k in msg for k in ('cublas', 'cudnn', 'cuda', 'dll', '.so')):
                # Missing runtime libraries: retrying other GPU compute types
                # can hang instead of failing, so go straight to CPU.
                gpu_broken = True
                _log('hint: pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 for GPU alignment '
                     '— using CPU instead')
    raise AlignmentError(f'could not load a whisper model: {last_err}')


def _get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                _model = _load_model()
    return _model


# --------------------------------------------------------------------- audio

def _decode_waveform(audio_path):
    """Decode to a 16 kHz mono float32 array, or None."""
    try:
        import stable_whisper.alignment as al
        t0 = time.time()
        wf = al.prep_audio(audio_path)
        if hasattr(wf, 'detach'):
            wf = wf.detach().cpu().numpy()
        wf = np.asarray(wf, dtype=np.float32)
        if wf.ndim > 1:
            wf = wf.mean(axis=0)
        _log(f'decoded audio in {time.time() - t0:.1f}s ({len(wf) / SR:.1f}s)')
        return wf
    except Exception as e:  # noqa: BLE001
        _log(f'audio decode failed: {e}')
        return None


# ------------------------------------------------------------------ language

def _detect_language(model, wf, lyric_start, lyric_end, latin_lyrics):
    """Vote over three 30 s probes spread across the sung part of the song
    (probing only the start would hit an instrumental intro)."""
    if _LANG_OVERRIDE:
        return _LANG_OVERRIDE
    total = len(wf) / SR
    span = max(0.0, lyric_end - lyric_start)
    scores, probes = {}, 0
    for frac in (0.0, 0.4, 0.75):
        a = min(max(0.0, lyric_start + frac * span), max(0.0, total - 30))
        seg = wf[int(a * SR):int((a + 30) * SR)]
        if len(seg) < SR * 5:
            continue
        try:
            _lang, _p, probs = model.detect_language(audio=seg)
        except Exception as e:  # noqa: BLE001
            _log(f'language probe failed: {e}')
            continue
        probes += 1
        for lang, p in probs:
            scores[lang] = scores.get(lang, 0.0) + float(p)
    if not scores:
        raise AlignmentError('language detection failed')
    ranked = sorted(scores, key=scores.get, reverse=True)
    lang = ranked[0]
    if latin_lyrics and lang in _NON_LATIN:
        # Romanised lyrics (e.g. Japanese in Latin letters): pick the best Latin-script language.
        lang = next((l for l in ranked if l not in _NON_LATIN), 'en')
    _log(f'language={lang!r} ({scores[ranked[0]] / max(probes, 1):.2f} avg confidence)')
    return lang


# ------------------------------------------------------------- text helpers

def _tokens_for_line(text):
    """Tokenize a lyric line exactly like the frontend (whitespace split)."""
    words = [t for t in re.split(r'\s+', (text or '').strip()) if t]
    return words if words else ['♪']


def _is_sung(text):
    """A line worth aligning: has at least one letter/digit."""
    return bool(re.search(r'\w', text or ''))


def _is_latin(lines):
    letters = [c for ln in lines for c in ln if c.isalpha()]
    return bool(letters) and sum(c.isascii() or ('À' <= c <= 'ɏ') for c in letters) / len(letters) > 0.9


def _map_words_to_tokens(words, tokens):
    """Map aligner words [(text, start, end)] onto our whitespace tokens.

    Returns ([start], [end]) per token, or None if they cannot be reconciled.
    """
    if len(words) == len(tokens):
        return [w[1] for w in words], [w[2] for w in words]
    # Different segmentation (no-space scripts, hyphenation...): map by character offset.
    wlens = [len(re.sub(r'\s+', '', w[0])) for w in words]
    tlens = [len(t) for t in tokens]
    if not words or sum(wlens) != sum(tlens):
        return None
    w_bounds, pos = [], 0
    for n in wlens:
        w_bounds.append((pos, pos + n))
        pos += n
    starts, ends, pos = [], [], 0
    for n in tlens:
        a, b = pos, pos + n
        pos = b
        hit = [w for w, (wa, wb) in zip(words, w_bounds) if wa < b and wb > a and wb > wa]
        if not hit:
            return None
        starts.append(min(w[1] for w in hit))
        ends.append(max(w[2] for w in hit))
    return starts, ends


def _estimate_span(tokens, t0, limit):
    """Where a line is probably sung, judging by its length alone."""
    chars = sum(len(t) for t in tokens)
    dur = min(max(0.6, 0.9 + chars * 0.075), max(0.6, (limit - t0) * 0.88), MAX_LINE_SPAN)
    return t0, t0 + dur


def _spread(tokens, a, b):
    """Spread tokens over [a, b] weighted by length."""
    weights = [1.0 + len(t) * 0.35 for t in tokens]
    total = sum(weights)
    starts, ends, acc = [], [], a
    for w in weights:
        d = (b - a) * w / total
        starts.append(acc)
        ends.append(acc + d * 0.92)
        acc += d
    return starts, ends


def _fix_clumps(tokens, starts, ends, limit):
    """Whisper sometimes stacks several words on one instant; spread each such
    run over the time it had available."""
    n = len(tokens)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and abs(starts[j + 1] - starts[i]) < 0.02:
            j += 1
        if j > i:
            nxt = starts[j + 1] if j + 1 < n else limit
            end = max(ends[j], min(nxt, starts[i] + 0.5 * (j - i + 1)))
            end = max(end, starts[i] + 0.12 * (j - i + 1))
            s, e = _spread(tokens[i:j + 1], starts[i], end)
            starts[i:j + 1], ends[i:j + 1] = s, e
        i = j + 1


# ------------------------------------------------------------------ aligning

class _Line:
    __slots__ = ('i', 'time', 'text', 'tokens', 'limit', 'sung', 'starts', 'ends', 'how')

    def __init__(self, i, time_, text, limit):
        self.i = i
        self.time = time_
        self.text = (text or '').strip()
        self.tokens = _tokens_for_line(self.text)
        self.limit = limit          # next LRC time (end of this line's slot)
        self.sung = _is_sung(self.text)
        self.starts = None
        self.ends = None
        self.how = None             # 'chunk' | 'line' | 'estimate' | 'blank'


def _run_align(model, wf, w0, w1, text, language):
    """One stable-ts align() call on wf[w0:w1]; returns segments or None."""
    audio = wf[max(0, int(w0 * SR)):int(w1 * SR)]
    if len(audio) < SR * 0.5:
        return None
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            res = model.align(audio, text, language=language, original_split=True, verbose=None)
    except Exception as e:  # noqa: BLE001
        _log(f'align() failed on {w0:.1f}-{w1:.1f}s: {e}')
        return None
    return list(res.segments) if res and getattr(res, 'segments', None) else None


def _seg_words(seg, offset):
    out = []
    for w in getattr(seg, 'words', None) or []:
        st, en = getattr(w, 'start', None), getattr(w, 'end', None)
        if st is None:
            continue
        out.append((getattr(w, 'word', '') or '', offset + float(st),
                    offset + float(en if en is not None else st)))
    return out


def _accept(line, words, offset_unreliable_start):
    """Store aligner output on the line if it is plausible. Returns True/False."""
    mapped = _map_words_to_tokens(words, line.tokens)
    if mapped is None:
        return False
    starts, ends = list(mapped[0]), list(mapped[1])
    if any(b < a - 1e-3 for a, b in zip(starts, starts[1:])):
        return False
    if not offset_unreliable_start and abs(starts[0] - line.time) > MAX_START_DEV:
        return False
    if starts[0] < line.time - 3.0 or starts[0] > line.limit + MAX_OVERRUN:
        return False
    if ends[-1] > line.limit + MAX_OVERRUN:
        return False
    line.starts, line.ends = starts, ends
    return True


def _group(sung, span=CHUNK_SPAN):
    """Chunk indices into (start, end) ranges over ``sung``; consecutive chunks
    overlap by one line."""
    groups, p, n = [], 0, len(sung)
    while p < n:
        q = p
        while q + 1 < n and sung[q + 1].time - sung[p].time < span:
            q += 1
        if q == p and q + 1 < n:
            q += 1
        groups.append((p, q))
        if q >= n - 1:
            break
        p = q
    return groups


def _align_lines(model, wf, lines, language, progress=None):
    sung = [ln for ln in lines if ln.sung]
    total_sec = len(wf) / SR
    unreliable = set()      # lines whose first-word start must be re-estimated
    done = 0

    for p, q in _group(sung):
        grp = sung[p:q + 1]
        w0 = max(0.0, grp[0].time - PAD_BEFORE)
        w1 = min(total_sec, min(grp[-1].limit, grp[-1].time + MAX_LINE_SPAN) + PAD_AFTER)
        segs = _run_align(model, wf, w0, w1, '\n'.join(g.text for g in grp), language)
        ok = segs is not None and len(segs) == len(grp)
        for k, (line, seg) in enumerate(zip(grp, segs if ok else [None] * len(grp))):
            if k == 0 and p > 0:
                continue                      # context only; the previous chunk owns this line
            if seg is not None and _accept(line, _seg_words(seg, w0), k == 0):
                line.how = 'chunk'
                if k == 0:
                    unreliable.add(line.i)    # window-edge start
        done = max(done, q + 1)
        if progress:
            progress(done, len(sung))

    # Anything the chunks could not place: align that line alone in its LRC slot.
    redone = 0
    for line in sung:
        if line.how is not None:
            continue
        w0 = max(0.0, line.time - 0.4)
        w1 = min(total_sec, min(line.limit, line.time + MAX_LINE_SPAN) + 0.6)
        segs = _run_align(model, wf, w0, w1, line.text, language)
        if segs and len(segs) == 1 and _accept(line, _seg_words(segs[0], w0), True):
            line.how = 'line'
            unreliable.add(line.i)
            redone += 1
        else:
            a, b = _estimate_span(line.tokens, line.time, line.limit)
            line.starts, line.ends = _spread(line.tokens, a, b)
            line.how = 'estimate'
    return unreliable, redone


def _anchor_starts(lines, unreliable):
    """Whisper cannot place the first word of a window (it snaps to the window
    edge), so for those lines use the LRC time — measured against Whisper's own
    internal line starts it is within ~0.15 s on average — kept before word two."""
    for line in lines:
        if line.i not in unreliable or not line.starts:
            continue
        second = line.starts[1] if len(line.starts) > 1 else line.ends[0]
        line.starts[0] = min(line.time, max(second - MIN_WORD, 0.0))


def _finalize(lines, duration):
    """Clean clumps, enforce monotonic non-overlapping times, build output pairs."""
    for line in lines:
        if not line.sung:
            line.starts = [line.time]
            line.ends = [min(line.limit, line.time + 4.0)]
            line.how = 'blank'
        elif line.how != 'estimate':
            _fix_clumps(line.tokens, line.starts, line.ends, line.limit)

    flat = [(ln, k) for ln in lines for k in range(len(ln.tokens))]
    s = [max(0.0, ln.starts[k]) for ln, k in flat]
    e = [max(0.0, ln.ends[k]) for ln, k in flat]
    for i in range(1, len(s)):
        s[i] = max(s[i], s[i - 1])
    for i in range(len(s)):
        e[i] = max(e[i], s[i] + MIN_WORD)
        if i + 1 < len(s) and e[i] > s[i + 1]:
            e[i] = s[i + 1]
        if duration:
            s[i], e[i] = min(s[i], duration), min(e[i], duration)

    out, idx = [], 0
    for ln in lines:
        n = len(ln.tokens)
        out.append([[round(s[idx + k], 3), round(e[idx + k], 3)] for k in range(n)])
        idx += n
    return out


def align_synced_lyrics(audio_path, synced, progress=None):
    """Align synced lyrics ([{time, text}, ...]) to an audio file.

    Returns ``{'words': [[[start, end], ...] per line], 'language': str,
    'stats': {...}}`` — one entry in ``words`` per input line. Raises
    AlignmentError when the result would not be trustworthy.
    """
    if not synced or not audio_path or not os.path.isfile(audio_path):
        raise AlignmentError('audio file or synced lyrics missing')

    times = [float(l.get('time') or 0.0) for l in synced]
    if any(b < a for a, b in zip(times, times[1:])):
        order = sorted(range(len(synced)), key=lambda i: times[i])
        raise AlignmentError(f'lyric timestamps are out of order (line {order[0]})')

    lines = []
    for i, l in enumerate(synced):
        limit = times[i + 1] if i + 1 < len(synced) else times[i] + 6.0
        lines.append(_Line(i, times[i], l.get('text'), max(limit, times[i] + 0.3)))
    sung = [ln for ln in lines if ln.sung]
    if not sung:
        raise AlignmentError('no sung lyric lines')

    _log(f'start: {len(sung)} sung lines, file={os.path.basename(audio_path)}')
    model = _get_model()
    with _infer_lock:
        wf = _decode_waveform(audio_path)
        if wf is None or len(wf) < SR * 3:
            raise AlignmentError('audio could not be decoded')
        t0 = time.time()
        language = _detect_language(
            model, wf, sung[0].time, sung[-1].time, _is_latin([ln.text for ln in sung]))
        unreliable, redone = _align_lines(model, wf, lines, language, progress)
        _log(f'aligned in {time.time() - t0:.1f}s')

    estimated = sum(1 for ln in sung if ln.how == 'estimate')
    if estimated / len(sung) > FAIL_RATIO:
        raise AlignmentError(
            f'{estimated} of {len(sung)} lines could not be matched to the audio '
            f'(wrong lyrics/version, or no vocals?)')

    _anchor_starts(lines, unreliable)
    words = _finalize(lines, len(wf) / SR)

    devs = [abs(ln.starts[0] - ln.time) for ln in sung if ln.how == 'chunk' and ln.i not in unreliable]
    stats = {
        'lines': len(sung),
        're_aligned': redone,
        'estimated': estimated,
        'anchored_starts': len(unreliable),
        'median_line_offset': round(float(np.median(devs)), 3) if devs else None,
    }
    _log(f'done: {stats}')
    return {'words': words, 'language': language, 'stats': stats}
