"""Lyrics word-alignment logic, with Whisper replaced by a scripted fake."""
import sys
import types

import numpy as np
import pytest

from utils import lyrics_align as la


# ------------------------------------------------------------ pure helpers

def _mk_lines(times, texts=None):
    texts = texts or [f'line number {i} here' for i in range(len(times))]
    lines = []
    for i, (t, txt) in enumerate(zip(times, texts)):
        limit = times[i + 1] if i + 1 < len(times) else t + 6.0
        lines.append(la._Line(i, t, txt, limit))
    return lines


def test_tokens_match_frontend_whitespace_split():
    assert la._tokens_for_line("  hey   (you)  there ") == ['hey', '(you)', 'there']
    assert la._tokens_for_line('') == ['♪']


def test_is_sung():
    assert la._is_sung('hello') and la._is_sung('2003')
    assert not la._is_sung('') and not la._is_sung('♪') and not la._is_sung('...')


def test_group_chunks_overlap_by_one_line():
    sung = _mk_lines([0, 5, 10, 15, 20, 25, 30, 35, 40])
    groups = la._group(sung, span=18.0)
    assert groups[0][0] == 0
    for (_, prev_q), (nxt_p, _) in zip(groups, groups[1:]):
        assert nxt_p == prev_q                       # one line of context
    assert groups[-1][1] == len(sung) - 1            # every line is covered
    assert all(q > p for p, q in groups[1:])         # later chunks own at least one line


def test_group_handles_one_line_and_wide_gaps():
    assert la._group(_mk_lines([3.0])) == [(0, 0)]
    groups = la._group(_mk_lines([0, 60, 120]), span=18.0)
    assert groups[-1][1] == 2 and all(q >= p for p, q in groups)


def test_map_words_same_count():
    words = [(' a', 1.0, 1.2), (' b', 1.2, 1.5)]
    assert la._map_words_to_tokens(words, ['a', 'b']) == ([1.0, 1.2], [1.2, 1.5])


def test_map_words_by_characters_when_segmentation_differs():
    # the aligner split "あいう えお" into three pieces; we have two whitespace tokens
    words = [('あい', 0.0, 0.4), ('う', 0.4, 0.6), ('えお', 0.7, 1.0)]
    starts, ends = la._map_words_to_tokens(words, ['あいう', 'えお'])
    assert starts == [0.0, 0.7] and ends == [0.6, 1.0]


def test_map_words_rejects_mismatched_text():
    assert la._map_words_to_tokens([('abc', 0, 1)], ['abcd', 'e']) is None


def test_fix_clumps_spreads_stacked_words():
    tokens = ['now', 'i', 'face', 'out']
    starts = [1.0, 1.0, 1.0, 1.0]
    ends = [1.0, 1.0, 1.0, 1.6]
    la._fix_clumps(tokens, starts, ends, limit=3.0)
    assert starts == sorted(starts) and len(set(starts)) == 4
    assert all(e > s for s, e in zip(starts, ends))
    assert ends[-1] <= 3.0


def test_finalize_is_monotonic_and_matches_token_counts():
    lines = _mk_lines([1.0, 5.0, 9.0], ['a b c', '', 'd e'])
    lines[0].starts, lines[0].ends, lines[0].how = [1.0, 2.5, 2.0], [2.5, 4.0, 2.1], 'chunk'   # out of order
    lines[2].starts, lines[2].ends, lines[2].how = [9.0, 9.4], [9.4, 20.0], 'chunk'
    out = la._finalize(lines, duration=12.0)
    assert [len(o) for o in out] == [3, 1, 2]
    flat = [p for o in out for p in o]
    assert all(b[0] >= a[0] for a, b in zip(flat, flat[1:]))
    assert all(e >= s for s, e in flat)
    assert max(e for _, e in flat) <= 12.0


def test_detect_language_votes_and_prefers_latin_for_romanised_lyrics(monkeypatch):
    monkeypatch.setattr(la, '_LANG_OVERRIDE', None)

    class M:
        def detect_language(self, audio):
            return 'ja', 0.6, [('ja', 0.6), ('en', 0.3), ('fr', 0.1)]

    wf = np.zeros(la.SR * 60, dtype=np.float32)
    assert la._detect_language(M(), wf, 0, 60, latin_lyrics=False) == 'ja'
    assert la._detect_language(M(), wf, 0, 60, latin_lyrics=True) == 'en'


# ---------------------------------------------- full pipeline (fake Whisper)

class _Word:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


class _Seg:
    def __init__(self, words):
        self.words = words


class _Result:
    def __init__(self, segments):
        self.segments = segments


class FakeModel:
    """Places every line at its scripted absolute time. The audio it is handed
    is a ramp (sample value = time / 1000), which tells it the window start."""

    def __init__(self, truth, misplace=None, fail_single=()):
        self.truth = truth              # text -> true absolute start
        self.misplace = misplace or {}  # text -> offset added while aligned inside a chunk
        self.fail_single = set(fail_single)
        self.calls = []

    def align(self, audio, text, language=None, **kw):
        w0 = float(audio[0]) * 1000.0
        texts = text.split('\n')
        self.calls.append(len(texts))
        segs = []
        for k, line in enumerate(texts):
            if len(texts) == 1 and line in self.fail_single:
                return None
            t = self.truth[line]
            if len(texts) > 1:
                t += self.misplace.get(line, 0.0)
            rel = t - w0
            words = [_Word(' ' + tok, rel + 0.3 * j, rel + 0.3 * j + 0.25) for j, tok in enumerate(line.split())]
            if k == 0:
                words[0].start = 0.0               # Whisper snaps the window's first word to the edge
            segs.append(_Seg(words))
        return _Result(segs)

    def detect_language(self, audio):
        return 'en', 0.9, [('en', 0.9)]


@pytest.fixture
def song(tmp_path, monkeypatch):
    times = [10.0 + 4.0 * i for i in range(12)]
    synced = [{'time': t, 'text': f'la la line {i}'} for i, t in enumerate(times)]
    synced.append({'time': times[-1] + 4.0, 'text': ''})
    truth = {l['text']: l['time'] + 0.2 for l in synced if l['text']}    # audio is 0.2 s after LRC

    audio_file = tmp_path / 'a.mp3'
    audio_file.write_bytes(b'x')
    ramp = (np.arange(la.SR * 80, dtype=np.float32) / la.SR / 1000.0)
    monkeypatch.setattr(la, '_decode_waveform', lambda path: ramp)
    monkeypatch.setattr(la, '_LANG_OVERRIDE', None)

    def install(model):
        monkeypatch.setattr(la, '_get_model', lambda: model)
        return model
    return synced, truth, str(audio_file), install


def _starts(out):
    return [w[0][0] for w in out['words']]


def test_aligns_lines_at_their_true_times(song):
    synced, truth, path, install = song
    install(FakeModel(truth))
    out = la.align_synced_lyrics(path, synced)
    assert out['language'] == 'en'
    assert len(out['words']) == len(synced)
    for line, ws in zip(synced[:-1], out['words']):
        assert len(ws) == 4
    # internal lines come straight from the aligner; the first uses the LRC time
    for i in range(1, 12):
        assert _starts(out)[i] == pytest.approx(truth[synced[i]['text']], abs=0.01)
    assert _starts(out)[0] == pytest.approx(synced[0]['time'], abs=0.01)
    assert out['stats']['estimated'] == 0 and out['stats']['re_aligned'] == 0
    flat = [p for ws in out['words'] for p in ws]
    assert all(b[0] >= a[0] for a, b in zip(flat, flat[1:]))


def test_misplaced_line_is_realigned_on_its_own(song):
    synced, truth, path, install = song
    bad = synced[6]['text']
    model = install(FakeModel(truth, misplace={bad: 20.0}))
    out = la.align_synced_lyrics(path, synced)
    assert out['stats']['re_aligned'] == 1
    assert _starts(out)[6] == pytest.approx(synced[6]['time'], abs=0.35)   # anchored to its LRC slot
    assert 1 in model.calls                                                # a single-line retry happened


def test_unmatchable_lines_fall_back_to_an_estimate(song):
    synced, truth, path, install = song
    install(FakeModel(truth, misplace={synced[3]['text']: 30.0}, fail_single={synced[3]['text']}))
    out = la.align_synced_lyrics(path, synced)
    assert out['stats']['estimated'] == 1
    ws = out['words'][3]
    assert synced[3]['time'] <= ws[0][0] < synced[4]['time']
    assert ws[-1][1] <= synced[4]['time'] + 1e-6


def test_fails_when_most_lines_cannot_be_aligned(song):
    synced, truth, path, install = song
    everything = {l['text']: 40.0 for l in synced if l['text']}
    install(FakeModel(truth, misplace=everything, fail_single=set(everything)))
    with pytest.raises(la.AlignmentError):
        la.align_synced_lyrics(path, synced)


def test_rejects_missing_audio_or_unsorted_lyrics(song, tmp_path):
    synced, truth, path, install = song
    install(FakeModel(truth))
    with pytest.raises(la.AlignmentError):
        la.align_synced_lyrics(str(tmp_path / 'nope.mp3'), synced)
    with pytest.raises(la.AlignmentError):
        la.align_synced_lyrics(path, list(reversed(synced)))


# ------------------------------------------------------------ model loading

def test_broken_cuda_falls_straight_back_to_cpu(monkeypatch):
    loads = []

    def load_faster_whisper(name, device, compute_type):
        loads.append((device, compute_type))
        if device == 'cuda':
            raise RuntimeError('Library cublas64_12.dll is not found or cannot be loaded')
        return FakeModel({})

    fake = types.ModuleType('stable_whisper')
    fake.load_faster_whisper = load_faster_whisper
    monkeypatch.setitem(sys.modules, 'stable_whisper', fake)
    monkeypatch.setattr(la, '_detect_device', lambda: 'cuda')
    monkeypatch.setattr(la, '_register_cuda_dlls', lambda: None)

    model = la._load_model()
    assert isinstance(model, FakeModel)
    # one failed GPU attempt (retrying other GPU compute types can hang), then CPU
    assert loads == [('cuda', 'float16'), ('cpu', 'int8')]
