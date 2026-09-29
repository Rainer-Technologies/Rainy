"""Tests for the personalised-mix engine (utils/mixes.py).

Pure logic only: a synthetic library with three audio "clusters" (chill
acoustic, hard rock, dance) stands in for the database, so nothing here
touches MySQL.
"""
import os
import sys
from datetime import datetime, timedelta

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from utils import mixes
from utils.mixes import Ctx, FeatureIndex, _DIM_W

NOW = datetime(2026, 9, 29, 12, 0)
CLUSTERS = {  # name -> (genre, energy, tempo, dance)
    'chill': ('Folk', 0.15, 70, 0.2),
    'rock': ('Rock', 0.9, 150, 0.4),
    'dance': ('Electronic', 0.8, 125, 0.95),
}


def _library(per_cluster=36, seed=7):
    """songs, feature data (recommender format) and song_features rows."""
    rng = np.random.default_rng(seed)
    songs, ids, vecs, masks, rows = {}, [], [], [], []
    sid = 0
    for ci, (name, (genre, energy, tempo, dance)) in enumerate(CLUSTERS.items()):
        base = np.zeros(23)
        base[ci * 4:(ci * 4) + 4] = 3.0        # separable timbre fingerprint
        for i in range(per_cluster):
            sid += 1
            songs[sid] = {
                'id': sid, 'file_path': f'/m/{sid}.mp3', 'title': f'{name} {i}',
                'artist': f'{name.title()} Artist {i % 18}', 'album': f'{name} album',
                'duration': 200, 'track_number': i, 'year': '2020', 'genre': genre,
                'cover_path': f'c{sid}.jpg',
                'scanned_at': NOW - timedelta(days=200 if sid % 5 else 3),
                'primary_artist': f'{name.title()} Artist {i % 18}',
            }
            ids.append(sid)
            vecs.append(base + rng.normal(0, 0.15, 23))
            masks.append(np.ones(23, dtype=bool))
            rows.append({'song_id': sid, 'tempo_bpm': tempo + rng.normal(0, 4),
                         'danceability': dance + rng.normal(0, 0.03),
                         'energy': energy + rng.normal(0, 0.03),
                         'loudness_db': -20 + energy * 12 + rng.normal(0, 0.5)})
    data = {'ids': ids, 'vecs': np.stack(vecs), 'masks': np.stack(masks)}
    return songs, data, rows


def _ctx(listens=True, liked_n=6):
    songs, data, rows = _library()
    fi = FeatureIndex.build(data, set(songs))
    plays, liked = {}, []
    if listens:
        # the listener plays chill and rock, never the dance cluster
        for sid, s in songs.items():
            if s['genre'] in ('Folk', 'Rock') and sid % 2 == 0:
                last = NOW - timedelta(days=5 if sid % 4 == 0 else 120)
                plays[sid] = {'c': 4 + sid % 5, 'last': last,
                              'c60': 3 if sid % 4 == 0 else 0}
        liked = [s for s in songs if songs[s]['genre'] == 'Folk'][:liked_n]
    hour_plays = {s: 3 for s in list(plays)[:12]}
    return Ctx(songs, liked, [], plays, hour_plays, 9, fi,
               mixes.build_mood_percentiles(rows), now=NOW)


def _by_id(ms):
    return {m['id']: m for m in ms}


# ---------------------------------------------------------------- builders

def test_full_shelf_for_a_listener():
    ctx = _ctx()
    ms = _by_id(mixes.build_mixes(ctx, seed=1))
    assert 'supermix' in ms
    assert any(k.startswith('my-') for k in ms), 'taste clusters -> My Mix'
    for expected in ('discover', 'replay', 'now', 'rediscover', 'new', 'liked'):
        assert expected in ms, expected
    assert sum(k.startswith('artist-') for k in ms) >= 1
    assert sum(k.startswith('mood-') for k in ms) == len(mixes.MOODS)
    for m in ms.values():
        floor = 1 if m['id'] == 'liked' else 8   # liked = however many you liked
        assert floor <= len(m['song_ids']) <= mixes.MIX_SIZE
        assert len(set(m['song_ids'])) == len(m['song_ids']), 'no duplicates'


def test_new_listener_still_gets_something():
    ms = _by_id(mixes.build_mixes(_ctx(listens=False, liked_n=0), seed=2))
    assert 'supermix' in ms and 'new' in ms
    assert not any(k.startswith('my-') for k in ms)
    assert 'discover' not in ms and 'replay' not in ms and 'liked' not in ms
    assert any(k.startswith('mood-') for k in ms)


def test_empty_library_builds_nothing():
    assert mixes.build_mixes(Ctx({}), seed=1) == []


def test_discover_only_unplayed_songs_and_disliked_excluded():
    ctx = _ctx()
    ctx.disliked = {s for s in ctx.songs if s % 7 == 0}
    ms = mixes.build_mixes(ctx, seed=3)
    disc = _by_id(ms)['discover']['song_ids']
    assert all(not ctx.played(s) and s not in ctx.liked for s in disc)
    for m in ms:
        assert not (set(m['song_ids']) & ctx.disliked), m['id']


def test_artist_cap_respected():
    ctx = _ctx()
    for m in mixes.build_mixes(ctx, seed=4):
        if m['kind'] in ('artist', 'replay', 'new', 'liked'):
            continue  # these intentionally allow a bigger share
        counts = {}
        for s in m['song_ids']:
            counts[ctx.artist(s)] = counts.get(ctx.artist(s), 0) + 1
        assert max(counts.values()) <= mixes._ARTIST_CAP, (m['id'], counts)


def test_my_mixes_are_distinct_taste_clusters():
    ctx = _ctx()
    my = [m for m in mixes.build_mixes(ctx, seed=5) if m['kind'] == 'my']
    assert len(my) >= 2
    dominant = []
    for m in my:
        genres = [ctx.songs[s]['genre'] for s in m['song_ids']]
        dominant.append(max(set(genres), key=genres.count))
    assert len(set(dominant)) >= 2, dominant


def test_moods_pick_matching_songs():
    ctx = _ctx()
    ms = _by_id(mixes.build_mixes(ctx, seed=6))

    def share(mix_id, genre):
        ids = ms[mix_id]['song_ids']
        return sum(ctx.songs[s]['genre'] == genre for s in ids) / len(ids)

    assert share('mood-chill', 'Folk') > 0.8
    assert share('mood-sleep', 'Folk') > 0.8
    assert share('mood-energize', 'Folk') < 0.1
    assert share('mood-party', 'Electronic') > 0.6
    assert share('mood-workout', 'Folk') < 0.1


def test_replay_only_recent_plays_sorted_by_plays():
    ctx = _ctx()
    replay = _by_id(mixes.build_mixes(ctx, seed=7))['replay']['song_ids']
    assert all(ctx.plays[s]['c60'] > 0 for s in replay)


def test_right_now_title_follows_hour():
    ctx = _ctx()
    titles = {}
    for hour, expect in ((7, 'Morning'), (13, 'Afternoon'), (19, 'Evening'), (2, 'Late Night')):
        ctx.hour = hour
        titles[hour] = _by_id(mixes.build_mixes(ctx, seed=8))['now']['title']
        assert titles[hour].startswith(expect)


def test_seed_is_deterministic_and_refresh_changes_picks():
    ctx = _ctx()
    a = mixes.build_mixes(ctx, seed=11)
    b = mixes.build_mixes(_ctx(), seed=11)
    assert [m['song_ids'] for m in a] == [m['song_ids'] for m in b]
    c = _by_id(mixes.build_mixes(ctx, seed=12))
    assert c['supermix']['song_ids'] != _by_id(a)['supermix']['song_ids']


# ------------------------------------------------------------------- flow

def test_flow_order_keeps_similar_songs_together():
    ctx = _ctx()
    rng = np.random.default_rng(0)
    pool = []
    for genre in ('Folk', 'Rock', 'Electronic'):
        pool += [s for s in ctx.songs if ctx.songs[s]['genre'] == genre][:8]
    shuffled = list(pool)
    rng.shuffle(shuffled)
    ordered = mixes.flow_order(ctx, shuffled, rng)
    assert sorted(ordered) == sorted(pool)

    def genre_switches(seq):
        return sum(ctx.songs[a]['genre'] != ctx.songs[b]['genre']
                   for a, b in zip(seq, seq[1:]))

    assert genre_switches(ordered) < genre_switches(shuffled)
    assert genre_switches(ordered) <= 4


def test_flow_order_avoids_same_artist_back_to_back():
    ctx = _ctx()
    rng = np.random.default_rng(1)
    pool = [s for s in ctx.songs if ctx.songs[s]['genre'] == 'Folk'][:18]
    ordered = mixes.flow_order(ctx, pool, rng)
    repeats = sum(ctx.artist(a) == ctx.artist(b) for a, b in zip(ordered, ordered[1:]))
    assert repeats <= 2


# ------------------------------------------------------------------ extend

def test_extend_follows_what_is_playing_and_excludes_queue():
    ctx = _ctx()
    recent = [s for s in ctx.songs if ctx.songs[s]['genre'] == 'Rock'][:5]
    more = mixes.extend(ctx, 'supermix', recent, limit=12, seed=3)
    assert len(more) == 12
    assert not set(more) & set(recent)
    rock_share = sum(ctx.songs[s]['genre'] == 'Rock' for s in more) / len(more)
    assert rock_share > 0.7, 'radio should stay near the current sound'


def test_extend_respects_mood_and_discover():
    ctx = _ctx()
    recent = [s for s in ctx.songs if ctx.songs[s]['genre'] == 'Folk'][:3]
    calm = mixes.extend(ctx, 'mood-energize', recent, limit=10, seed=4)
    # even starting from calm songs, an Energize mix must not go to sleep
    assert sum(ctx.songs[s]['genre'] == 'Folk' for s in calm) <= 3
    fresh = mixes.extend(ctx, 'discover', recent, limit=10, seed=5)
    assert all(not ctx.played(s) and s not in ctx.liked for s in fresh)


# ---------------------------------------------------------------- payload

def test_serialize_shape():
    ctx = _ctx()
    out = mixes.serialize(ctx, mixes.build_mixes(ctx, seed=9))
    assert out
    m = out[0]
    for key in ('id', 'kind', 'shelf', 'title', 'subtitle', 'count',
                'duration', 'covers', 'songs'):
        assert key in m
    assert m['count'] == len(m['songs']) and m['duration'] == 200 * m['count']
    assert 1 <= len(m['covers']) <= 4
    s = m['songs'][0]
    assert {'id', 'path', 'title', 'artist', 'album', 'duration', 'cover_path'} <= set(s)


def test_mood_percentiles_are_scale_free():
    rows = [{'song_id': i, 'tempo_bpm': 60 + i, 'danceability': i / 100,
             'energy': i / 100, 'loudness_db': -30 + i / 10} for i in range(50)]
    p = mixes.build_mood_percentiles(rows)
    assert p[0]['energy'] == 0.0 and p[49]['energy'] == 1.0
    assert mixes.build_mood_percentiles(rows[:1]) == {}
