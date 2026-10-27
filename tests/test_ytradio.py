"""Tests for the song radio engine (utils/ytradio.py).

Pure logic only: matching, filtering, ranking and queue weaving run on
hand-made tracks, so nothing here touches YouTube Music or the database.
"""
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from utils import ytradio
from utils.ytradio import (core_title, expansion_pool, filter_candidates, match_score,
                           match_song, norm, parse_length, rerank, song_key, versions)

ATV = 'MUSIC_VIDEO_TYPE_ATV'


def _track(vid, title, artist, duration=200, kind=ATV):
    return {'videoId': vid, 'title': title, 'artist': artist, 'album': '',
            'duration': duration, 'cover_url': None, 'type': kind}


# ── Text helpers ────────────────────────────────────────────────────────

def test_norm_folds_accents_and_punctuation():
    assert norm('Maria También!') == 'maria tambien'
    assert norm('  P#TAS — (Remix) ') == 'p tas remix'


@pytest.mark.parametrize('text, expected', [
    ('きみが死ぬまで恋をしたい', 'きみが死ぬまで恋をしたい'),
    ('が ガ ぱ パ', 'が ガ ぱ パ'),
    ('か\u3099', 'が'),
    ('ｶﾞ', 'ガ'),
    ('夜に駆ける', '夜に駆ける'),
    ('Любовь', 'любовь'),
    ('사랑해', '사랑해'),
    ('حُبّ', 'حُبّ'),
    ('También TAMBIE\u0301N', 'tambien tambien'),
    ('İstanbul', 'istanbul'),
    ('Ｆｕｌｌ １２３ 🎵', 'full 123'),
])
def test_norm_preserves_unicode_words(text, expected):
    assert norm(text) == expected


def test_japanese_song_keys_do_not_collapse_or_alias_an_owned_song():
    title = 'きみが死ぬまで恋をしたい'
    other = 'キスの魔力'
    artist = 'Yukari Hashimoto'
    assert song_key(title, artist) != song_key(other, artist)
    out = filter_candidates([_track('fhwrwHwzZmg', title, artist)],
                            library_by_key={song_key(other, artist): 99})
    assert len(out) == 1
    assert 'song_id' not in out[0]


def test_non_latin_artist_does_not_match_an_unrelated_latin_artist():
    song = {'title': 'Same title', 'artist': '喜多修平', 'duration': 200}
    result = {'title': 'Same title', 'artists': ['Someone Else'], 'duration': 200}
    total, parts = match_score(song, result)
    assert not ytradio.is_confident(total, parts)


def test_match_japanese_seed_from_real_youtube_music_result():
    song = {'title': 'きみが死ぬまで恋をしたい', 'artist': 'Yukari Hashimoto', 'duration': 114}
    results = [
        {'videoId': 'ColX1C6hJ2Y', 'title': 'キスの魔力 - Kiss no Maryoku',
         'artists': ['Yukari Hashimoto'], 'duration': 150},
        {'videoId': 'fhwrwHwzZmg',
         'title': 'きみが死ぬまで恋をしたい - Kimiga Shinumade Koiwoshitai',
         'artists': ['Yukari Hashimoto'], 'duration': 115},
    ]
    found = match_song(song, search=lambda query, kind: results)
    assert found is not None
    assert found['videoId'] == 'fhwrwHwzZmg'


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


def test_unicode_negative_match_is_retried_after_matcher_upgrade(monkeypatch):
    song = {'id': 1210, 'title': 'きみが死ぬまで恋をしたい',
            'artist': 'Yukari Hashimoto', 'duration': 114, 'youtube_id': None,
            'youtube_matched_at': '2026-10-18 21:28:27', 'youtube_match_version': 0}
    result = {'videoId': 'fhwrwHwzZmg', 'title': song['title'],
              'artists': [song['artist']], 'duration': 115}
    monkeypatch.setattr(ytradio, '_yt_search', lambda query, kind: [result])
    writes = []
    monkeypatch.setattr(ytradio.Database, 'execute_query',
                        lambda sql, params: writes.append((sql, params)))
    assert ytradio.ensure_video_id(song) == 'fhwrwHwzZmg'
    assert len(writes) == 1
    assert 'youtube_match_version' in writes[0][0]


def test_current_negative_match_is_not_retried(monkeypatch):
    song = {'id': 1210, 'youtube_id': None, 'youtube_matched_at': '2026-10-18',
            'youtube_match_version': ytradio.MATCH_VERSION}

    def unexpected(*args, **kwargs):
        pytest.fail('A current negative match must not search or write again')

    monkeypatch.setattr(ytradio, 'match_song', unexpected)
    monkeypatch.setattr(ytradio.Database, 'execute_query', unexpected)
    assert ytradio.ensure_video_id(song) is None


def test_known_video_id_is_preserved_after_matcher_upgrade(monkeypatch):
    song = {'youtube_id': 'fhwrwHwzZmg', 'youtube_match_version': 0}
    monkeypatch.setattr(ytradio, 'match_song', lambda song: pytest.fail('Already identified'))
    assert ytradio.ensure_video_id(song) == 'fhwrwHwzZmg'


# ── Filtering ───────────────────────────────────────────────────────────

def test_filter_keeps_owned_songs_as_library_songs_and_vets_new_ones():
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
        library_by_video={'owned000002': 12},
        library_by_key={song_key('La Graciosa', 'Quevedo'): 34},
        exclude_videos={'excl0000007'},
        blocked_keys={song_key('No Me Gusta', 'Artista F')})
    assert [(t['videoId'], t.get('song_id')) for t in out] == [
        ('keep0000001', None), ('owned000002', 12), ('other000003', 34)]
    assert [t['pos'] for t in out] == [0, 1, 2]


def test_filter_uses_the_library_copy_whatever_the_radio_version_is():
    # The radio suggests a live take / a user upload of a song the listener
    # owns: their own copy plays instead of the track being thrown away.
    tracks = [
        _track('live0000001', 'Mía (Live)', 'Artista A'),
        _track('ugc00000002', 'Subida', 'Canal', kind='MUSIC_VIDEO_TYPE_UGC'),
    ]
    out = filter_candidates(
        tracks, seed_title='Semilla',
        library_by_video={'ugc00000002': 8},
        library_by_key={song_key('Mía', 'Artista A'): 7})
    assert [t['song_id'] for t in out] == [7, 8]


def test_filter_skips_owned_songs_already_queued_or_repeated():
    tracks = [
        _track('owned000001', 'Una', 'Artista A'),
        _track('other000002', 'Una (Remastered)', 'Artista A'),   # same library song again
        _track('owned000003', 'Dos', 'Artista B'),
    ]
    out = filter_candidates(
        tracks, library_by_video={'owned000001': 1, 'owned000003': 2},
        library_by_key={song_key('Una', 'Artista A'): 1}, exclude_songs={2})
    assert [t['song_id'] for t in out] == [1]


def test_filter_keeps_versions_the_seed_also_is():
    tracks = [_track('rmx00000001', 'Otra (Remix)', 'A'), _track('live0000002', 'Otra (Live)', 'B')]
    out = filter_candidates(tracks, seed_title='De Lejitos (Remix)')
    assert [t['videoId'] for t in out] == ['rmx00000001']


# ── Ranking ─────────────────────────────────────────────────────────────

def _candidates(n):
    return [{**_track(f'v{i:010d}', f'Song {i}', f'Artist {i}'), 'pos': i} for i in range(n)]


def test_rerank_variation_changes_picks_without_losing_strong_taste_matches():
    cands = _candidates(40)
    weights = {cands[30]['videoId']: 8.0}
    first = rerank(cands, cooccurrence=weights, limit=12, variation=0.3, rng=random.Random(1))
    second = rerank(cands, cooccurrence=weights, limit=12, variation=0.3, rng=random.Random(2))
    assert cands[30] in first and cands[30] in second
    assert {t['videoId'] for t in first} != {t['videoId'] for t in second}
    assert len(first) == len(second) == 12


def test_refresh_radio_requests_fresh_candidates_without_overwriting_deep_cache(monkeypatch):
    old = [_track('oldvideo001', 'Old', 'Artist')]
    fresh = [_track('newvideo001', 'New', 'Artist')]
    writes = []
    monkeypatch.setattr(ytradio.RadioCacheModel, 'get', lambda *args: {'deep': True, 'tracks': old})
    monkeypatch.setattr(ytradio.RadioCacheModel, 'put', lambda *args: writes.append(args))
    monkeypatch.setattr(ytradio, '_yt_radio', lambda video_id, limit: fresh)
    assert ytradio.fetch_radio('seedvideo01', refresh=True) == fresh
    assert writes == []


@pytest.mark.parametrize('outcome', ['empty', 'error'])
def test_refresh_radio_falls_back_to_cached_results_if_youtube_fails(monkeypatch, outcome):
    cached = [_track('oldvideo001', 'Old', 'Artist')]
    monkeypatch.setattr(ytradio.RadioCacheModel, 'get', lambda *args: {'deep': True, 'tracks': cached})
    def youtube(video_id, limit):
        if outcome == 'error':
            raise RuntimeError('offline')
        return []
    monkeypatch.setattr(ytradio, '_yt_radio', youtube)
    assert ytradio.fetch_radio('seedvideo01', refresh=True) == cached


def test_refresh_radio_uses_cache_populated_during_failed_request(monkeypatch):
    cached = [_track('newcached01', 'Newly Cached', 'Artist')]
    reads = iter([None, {'deep': True, 'tracks': cached}])
    monkeypatch.setattr(ytradio.RadioCacheModel, 'get', lambda *args: next(reads))
    def offline(video_id, limit):
        raise RuntimeError('offline')
    monkeypatch.setattr(ytradio, '_yt_radio', offline)
    assert ytradio.fetch_radio('seedvideo01', refresh=True) == cached


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


def _owned(i, pos):
    return {**_track(f'o{i:010d}', f'Mine {i}', f'Owned {i}'), 'pos': pos, 'song_id': i}


def test_rerank_caps_songs_the_listener_owns_per_batch():
    owned = [_owned(i, i) for i in range(6)]
    new = [{**_track(f'n{i:010d}', f'New {i}', f'New {i}'), 'pos': 6 + i} for i in range(10)]
    out = rerank(owned + new, limit=8, owned_cap=2)
    assert len(out) == 8
    assert [t['song_id'] for t in out if 'song_id' in t] == [0, 1]
    assert sum('song_id' not in t for t in out) == 6


def test_rerank_fills_batch_with_owned_songs_when_nothing_else_is_left():
    owned = [_owned(i, i) for i in range(5)]
    out = rerank(owned, limit=4, owned_cap=2)
    assert [t['pos'] for t in out] == [0, 1, 2, 3]


def test_cooccurrence_bonus_is_capped_so_a_tail_track_cannot_pass_the_head():
    cands = _candidates(150)
    out = rerank(cands, cooccurrence={cands[149]['videoId']: 1_000_000.0}, limit=1)
    assert out[0]['pos'] == 0


# ── Widening ────────────────────────────────────────────────────────────

def test_expansion_needs_two_neighbours_to_agree():
    a = [_track('shared00001', 'Shared', 'X'), _track('onlyA000002', 'Only A', 'Y'),
         _track('known000003', 'Known', 'Z')]
    b = [_track('shared00001', 'Shared', 'X'), _track('known000003', 'Known', 'Z')]
    out = expansion_pool([a, b], known_videos={'known000003'})
    assert [t['videoId'] for t in out] == ['shared00001']
