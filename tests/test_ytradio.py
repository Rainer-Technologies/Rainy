"""Tests for the song radio engine (utils/ytradio.py).

Pure logic only: matching, filtering, ranking and queue weaving run on
hand-made tracks, so nothing here touches YouTube Music or the database.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from utils import ytradio
from utils.ytradio import (core_title, expansion_pool, filter_candidates, interleave,
                           match_score, match_song, norm, parse_length, rerank,
                           song_key, versions)

ATV = 'MUSIC_VIDEO_TYPE_ATV'


def _track(vid, title, artist, duration=200, kind=ATV):
    return {'videoId': vid, 'title': title, 'artist': artist, 'album': '',
            'duration': duration, 'cover_url': None, 'type': kind}


# ── Text helpers ────────────────────────────────────────────────────────

def test_norm_folds_accents_and_punctuation():
    assert norm('Maria También!') == 'maria tambien'
    assert norm('  P#TAS — (Remix) ') == 'p tas remix'


def test_core_title_drops_features_and_suffixes():
    assert core_title('Get Lucky (feat. Pharrell Williams)') == 'get lucky'
    assert core_title('Dreams - Live, 1978') == 'dreams'
    assert core_title('Bohemian Rhapsody [Remastered 2011]') == 'bohemian rhapsody'
    # 'con' is a word in Spanish titles, not a feature marker.
    assert core_title('Bailando con el diablo') == 'bailando con el diablo'


def test_versions_and_song_key():
    assert versions('Dreams - Live, 1978') == {'live'}
    assert versions('De Lejitos (Remix)') == {'remix'}
    assert versions('One More Time (Radio Edit)') == set()
    assert song_key('MONACO', 'Bad Bunny, Someone Else') == song_key('Monaco (Official)', 'Bad Bunny')


def test_parse_length():
    assert parse_length('3:37') == 217
    assert parse_length('1:02:03') == 3723
    assert parse_length(None) == 0


# ── Matching ────────────────────────────────────────────────────────────

KHRUANGBIN = {'title': 'Maria También', 'artist': 'Khruangbin', 'duration': 190}
# What YouTube Music really answers for "Khruangbin Maria También".
KHRUANGBIN_RESULTS = [
    {'videoId': 'wrong000001', 'title': 'Nasri', 'artists': ['Maria Tambun'], 'duration': 240},
    {'videoId': 'wrong000002', 'title': 'Mariella', 'artists': ['Khruangbin', 'Leon Bridges'],
     'duration': 215},
    {'videoId': 'live0000003', 'title': 'Maria Tambien (Live at Sydney Opera House)',
     'artists': ['Khruangbin'], 'duration': 310},
    {'videoId': 'right000004', 'title': 'Maria También', 'artists': ['Khruangbin'], 'duration': 195},
]


def test_match_picks_the_right_track_not_the_first_result():
    found = match_song(KHRUANGBIN, search=lambda q, kind: KHRUANGBIN_RESULTS)
    assert found['videoId'] == 'right000004'


def test_match_refuses_when_nothing_is_close():
    found = match_song(KHRUANGBIN, search=lambda q, kind: KHRUANGBIN_RESULTS[:2])
    assert found is None


def test_match_uses_first_artist_of_a_credits_list():
    song = {'title': 'Las mas bonitas son p#tas',
            'artist': 'Anuel AA, Emmanuel Gazmey Santiago', 'duration': 159}
    result = {'videoId': 'x', 'title': 'Las mas bonitas son p#tas', 'artists': ['Anuel AA'],
              'duration': 160}
    total, parts = match_score(song, result)
    assert parts[1] == 1.0 and ytradio.is_confident(total, parts)


def test_match_penalises_a_different_version():
    song = {'title': 'Dreams', 'artist': 'Fleetwood Mac', 'duration': 257}
    studio = {'title': 'Dreams', 'artists': ['Fleetwood Mac'], 'duration': 257}
    live = {'title': 'Dreams (Live)', 'artists': ['Fleetwood Mac'], 'duration': 257}
    assert match_score(song, studio)[0] > match_score(song, live)[0]


def test_match_survives_a_failing_search():
    def search(query, kind):
        if kind == 'songs':
            raise RuntimeError('network down')
        return [KHRUANGBIN_RESULTS[3]]
    assert match_song(KHRUANGBIN, search=search)['videoId'] == 'right000004'


# ── Filtering ───────────────────────────────────────────────────────────

def test_filter_drops_library_versions_uploads_and_odd_lengths():
    tracks = [
        _track('keep0000001', 'Nueva', 'Artista A'),
        _track('owned000002', 'Tengo Esta', 'Artista B'),              # same video in library
        _track('other000003', 'LA GRACIOSA', 'Quevedo, Elvis Crespo'),  # same song, other video
        _track('live0000004', 'Otra (Live)', 'Artista C'),
        _track('ugc00000005', 'Subida', 'Canal', kind='MUSIC_VIDEO_TYPE_UGC'),
        _track('short000006', 'Intro', 'Artista D', duration=40),
        _track('excl0000007', 'Ya En Cola', 'Artista E'),
        _track('hate0000008', 'No Me Gusta', 'Artista F'),
        _track('keep0000009', 'Nueva', 'Artista A'),                   # duplicate of the first
    ]
    out = filter_candidates(
        tracks, seed_title='Semilla',
        library_videos={'owned000002'},
        library_keys={song_key('La Graciosa', 'Quevedo')},
        exclude_videos={'excl0000007'},
        blocked_keys={song_key('No Me Gusta', 'Artista F')})
    assert [t['videoId'] for t in out] == ['keep0000001']
    assert out[0]['pos'] == 0


def test_filter_keeps_versions_the_seed_also_is():
    tracks = [_track('rmx00000001', 'Otra (Remix)', 'A'), _track('live0000002', 'Otra (Live)', 'B')]
    out = filter_candidates(tracks, seed_title='De Lejitos (Remix)')
    assert [t['videoId'] for t in out] == ['rmx00000001']


# ── Ranking ─────────────────────────────────────────────────────────────

def _candidates(n):
    return [{**_track(f'v{i:010d}', f'Song {i}', f'Artist {i}'), 'pos': i} for i in range(n)]


def test_rerank_keeps_radio_order_without_taste_data():
    out = rerank(_candidates(8), limit=5)
    assert [t['pos'] for t in out] == [0, 1, 2, 3, 4]


def test_rerank_lifts_songs_that_cooccur_with_the_library():
    cands = _candidates(20)
    out = rerank(cands, cooccurrence={cands[15]['videoId']: 6.0}, limit=5)
    assert out[0]['videoId'] == cands[15]['videoId']


def test_rerank_caps_songs_per_artist():
    cands = [{**_track(f'v{i:010d}', f'Song {i}', 'Same Artist'), 'pos': i} for i in range(6)]
    cands.append({**_track('other000000', 'Other', 'Someone'), 'pos': 6})
    out = rerank(cands, limit=5)
    assert [t['artist'] for t in out].count('Same Artist') == 2
    assert out[-1]['artist'] == 'Someone'


def test_rerank_pushes_skipped_artists_down():
    cands = _candidates(6)
    out = rerank(cands, skipped_artists=['Artist 0'], limit=6)
    assert out[0]['artist'] == 'Artist 1'
    assert out[-1]['artist'] == 'Artist 0'


# ── Weaving ─────────────────────────────────────────────────────────────

def test_interleave_two_local_then_one_new():
    local = [f'L{i}' for i in range(8)]
    new = [f'N{i}' for i in range(4)]
    assert interleave(local, new, 9) == ['L0', 'L1', 'N0', 'L2', 'L3', 'N1', 'L4', 'L5', 'N2']


def test_interleave_fills_from_the_other_side_when_one_runs_out():
    assert interleave(['L0'], ['N0', 'N1', 'N2'], 4) == ['L0', 'N0', 'N1', 'N2']
    assert interleave(['L0', 'L1', 'L2'], [], 5) == ['L0', 'L1', 'L2']


def test_expansion_needs_two_neighbours_to_agree():
    a = [_track('shared00001', 'Shared', 'X'), _track('onlyA000002', 'Only A', 'Y'),
         _track('known000003', 'Known', 'Z')]
    b = [_track('shared00001', 'Shared', 'X'), _track('known000003', 'Known', 'Z')]
    out = expansion_pool([a, b], known_videos={'known000003'})
    assert [t['videoId'] for t in out] == ['shared00001']
