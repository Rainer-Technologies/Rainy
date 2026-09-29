"""Light show analyser on a synthetic, fully known track.

120 BPM, 4/4 (bar = 2 s):
  0-16 s   intro:  hats + soft pad only
  16-32 s  groove: kick on every beat, snare on 2 & 4, hats
  32-39.5  build:  kick + snare roll getting denser + noise riser
  39.5-40  silence (the pre-drop breath)
  40-64 s  drop:   loud kick/snare/sub bass + hats
  64-72 s  outro:  pad only
"""
import base64
import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

sf = pytest.importorskip('soundfile')
pytest.importorskip('librosa')

from utils import lightshow_analyzer as A  # noqa: E402

SR = 22050
BPM = 120.0
BEAT = 60.0 / BPM
DUR = 72.0
DROP_T = 40.0
STOP_T = 39.5


def _kick(n, amp):
    t = np.arange(n) / SR
    f = 50 + 90 * np.exp(-t * 30)
    return amp * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def _noise_hit(n, amp, decay, rng, hp=False):
    x = rng.standard_normal(n)
    if hp:
        x = np.diff(x, prepend=0.0)
    return amp * x * np.exp(-np.arange(n) / SR * decay)


def _add(buf, t, sig):
    i = int(t * SR)
    j = min(buf.size, i + sig.size)
    if 0 <= i < buf.size:
        buf[i:j] += sig[:j - i]


def _render():
    rng = np.random.default_rng(7)
    y = np.zeros(int(DUR * SR))
    tt = np.arange(y.size) / SR
    pad = 0.05 * (np.sin(2 * np.pi * 220 * tt) + 0.6 * np.sin(2 * np.pi * 277 * tt))
    y += pad * ((tt < 32) | (tt >= 64))
    nb = int(DUR / BEAT)
    for b in range(nb):
        t = b * BEAT
        in_groove = 16 <= t < 32
        in_build = 32 <= t < STOP_T
        in_drop = DROP_T <= t < 64
        # hats on 8ths everywhere except silence/outro
        if t < STOP_T or in_drop:
            for h in (0.0, 0.5):
                _add(y, t + h * BEAT, _noise_hit(1500, 0.12 if not in_drop else 0.2, 60, rng, hp=True))
        if in_groove or in_build or in_drop:
            _add(y, t, _kick(int(0.3 * SR), 0.6 if not in_drop else 0.95))
            if b % 2 == 1:
                _add(y, t, _noise_hit(4000, 0.35 if not in_drop else 0.55, 25, rng))
        if in_build:
            prog = (t - 32) / (STOP_T - 32)
            sub = 2 if prog < 0.5 else 4
            for k in range(1, sub):
                _add(y, t + k * BEAT / sub, _noise_hit(2500, 0.2 + 0.25 * prog, 30, rng))
        if in_drop:
            _add(y, t, 0.35 * np.sin(2 * np.pi * 55 * np.arange(int(BEAT * SR)) / SR))
    # riser noise in the build
    m = (tt >= 32) & (tt < STOP_T)
    y[m] += 0.08 * ((tt[m] - 32) / (STOP_T - 32)) * np.diff(rng.standard_normal(m.sum()), prepend=0)
    y[(tt >= STOP_T) & (tt < DROP_T)] = 0.0
    return (y / np.max(np.abs(y)) * 0.9).astype(np.float32)


@pytest.fixture(scope='module')
def score(tmp_path_factory):
    path = tmp_path_factory.mktemp('ls') / 'synthetic.wav'
    sf.write(str(path), _render(), SR)
    return A.analyze_file(str(path))


def test_format(score):
    assert score['v'] == A.ANALYZER_VERSION
    assert score['fps'] == 50
    assert abs(score['duration'] - DUR) < 0.1
    frames = int(score['duration'] * score['fps'])
    for key in ('sub', 'bass', 'mid', 'high', 'air', 'rms', 'harm'):
        raw = base64.b64decode(score['env'][key])
        assert abs(len(raw) - frames) <= 2, key
    assert set(score['onsets']) == {'k', 's', 'h'}
    assert all(s['label'] in A.SECTION_LABELS for s in score['sections'])
    assert len(json.dumps(score)) < 60_000  # ~72 s of audio


def test_tempo_and_beats(score):
    assert abs(score['tempo'] - BPM) < 2.0
    beats = np.array(score['beats'])
    groove = beats[(beats > 17) & (beats < 31)]
    assert groove.size >= 20
    err = np.abs(((groove + BEAT / 2) % BEAT) - BEAT / 2)
    assert np.median(err) < 0.03


def test_downbeats_on_bar_starts(score):
    bar = 4 * BEAT
    db = np.array(score['downbeats'])
    db = db[(db > 17) & (db < 63)]
    assert db.size >= 8
    err = np.abs(((db + bar / 2) % bar) - bar / 2)
    assert np.median(err) < 0.06


def test_drop_and_stop_detected(score):
    drops = [e['t'] for e in score['events'] if e['type'] == 'drop']
    stops = [e['t'] for e in score['events'] if e['type'] == 'stop']
    assert any(abs(t - DROP_T) <= 2.1 for t in drops), score['sections']
    assert any(abs(t - STOP_T) <= 0.3 for t in stops), score['events']


def test_kicks_follow_the_beat(score):
    kicks = np.array([k[0] for k in score['onsets']['k']])
    in_drop = kicks[(kicks > DROP_T + 0.5) & (kicks < 63.5)]
    assert in_drop.size >= 40
    err = np.abs(((in_drop + BEAT / 2) % BEAT) - BEAT / 2)
    assert np.median(err) < 0.03
