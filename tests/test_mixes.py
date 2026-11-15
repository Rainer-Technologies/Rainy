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


def _ctx(listens=True, liked_n=6, hidden=(), played=('Folk', 'Rock')):
    """A listener over the synthetic library; `hidden` songs have no audio features."""
    songs, data, rows = _library()
    hidden = set(hidden)
    fi = FeatureIndex.build(data, set(songs) - hidden)
    plays, liked = {}, []
    if listens:
        # the listener plays chill and rock, never the dance cluster
        for sid, s in songs.items():
            if s['genre'] in played and sid % 2 == 0:
                last = NOW - timedelta(days=5 if sid % 4 == 0 else 120)
                plays[sid] = {'c': 4 + sid % 5, 'last': last,
                              'c60': 3 if sid % 4 == 0 else 0}
        liked = [s for s in songs if songs[s]['genre'] == 'Folk'][:liked_n]
    hour_plays = {s: 3 for s in list(plays)[:12]}
    return Ctx(songs, liked, [], plays, hour_plays, 9, fi,
               mixes.build_mood_percentiles([r for r in rows if r['song_id'] not in hidden]),
               now=NOW)


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


# --------------------------------------------- R2: moods mean something

def test_chill_mix_has_no_rock_or_dance_tracks():
    # Chill's audio bar is the listener's quietest third; Rock and Dance sit above it.
    ctx = _ctx()
    chill = _by_id(mixes.build_mixes(ctx, seed=13))['mood-chill']['song_ids']
    assert {ctx.songs[s]['genre'] for s in chill} == {'Folk'}


def test_crowd_labels_cannot_pull_a_hard_dance_track_into_chill():
    ctx = _ctx()
    dance = next(s for s in ctx.songs if ctx.songs[s]['genre'] == 'Electronic')
    ctx.tags = {dance: [('chill', 100), ('sleep', 100)]}
    for seed in (5, 6):
        ms = _by_id(mixes.build_mixes(ctx, seed=seed))
        assert dance not in ms['mood-chill']['song_ids']
        assert dance not in ms['mood-sleep']['song_ids']


def test_mood_label_reads_crowd_tags_and_genre():
    ctx = _ctx()
    dance = next(s for s in ctx.songs if ctx.songs[s]['genre'] == 'Electronic')
    ctx.tags = {dance: [('Electronic---House', 80)]}
    assert ctx.mood_label(dance, 'party') == 0.8
    assert ctx.mood_label(dance, 'chill') == 0.0
    folk = next(s for s in ctx.songs if ctx.songs[s]['genre'] == 'Folk')
    assert ctx.mood_label(folk, 'chill') == mixes._GENRE_LABEL


def test_disliked_artist_is_out_of_every_mix_but_a_like_keeps_the_rest():
    ctx = _ctx()
    rock_zero = [s for s in ctx.songs if ctx.artist(s) == 'Rock Artist 0']
    assert len(rock_zero) == 2
    ctx.disliked = {rock_zero[0]}
    for seed in (1, 2):
        for m in mixes.build_mixes(ctx, seed=seed):
            assert not set(m['song_ids']) & set(rock_zero), m['id']
    ctx.liked = set(ctx.liked) | {rock_zero[1]}
    assert ctx.blocked(rock_zero[0]) and not ctx.blocked(rock_zero[1])


def test_mood_percentiles_are_ranked_within_the_listeners_visible_library(monkeypatch):
    from models.database import Database
    from models.library_access import LibraryAccessModel
    from utils import recommender

    songs = [{'id': i, 'file_path': f'/m/{i}.mp3', 'title': f'T{i}', 'artist': f'A{i}',
              'album': 'x', 'duration': 200, 'track_number': i, 'year': '2020',
              'genre': 'Rock', 'cover_path': None, 'scanned_at': None}
             for i in range(1, 7)]
    energies = dict(zip(range(1, 7), (0.1, 0.2, 0.3, 0.4, 0.9, 1.0)))
    features = [{'song_id': i, 'tempo_bpm': 100.0, 'danceability': 0.5,
                 'energy': e, 'loudness_db': -10.0} for i, e in energies.items()]

    def fake_query(query, params=None, fetch_one=False, fetch_all=False):
        if fetch_one and 'HOUR(NOW())' in query:
            return {'h': 9}
        if 'FROM songs' in query:
            return [dict(s) for s in songs]
        if 'FROM song_features' in query:
            return [dict(f) for f in features]
        return None if fetch_one else []

    monkeypatch.setattr(Database, 'execute_query', fake_query)
    monkeypatch.setattr(LibraryAccessModel, 'visible_song_ids',
                        staticmethod(lambda user_id: {1, 2, 3, 4}))
    monkeypatch.setattr(recommender, '_load_features',
                        lambda force=False: {'ids': [], 'vecs': np.zeros((0, 23)),
                                             'masks': np.zeros((0, 23), bool)})

    ctx = mixes.load_context(1)
    # songs 5 and 6 are not visible: they must not stretch the visible percentiles
    assert set(ctx.mood_pct) == {1, 2, 3, 4}
    assert ctx.mood_pct[1]['energy'] == 0.0 and ctx.mood_pct[4]['energy'] == 1.0


def test_moods_are_hidden_until_enough_songs_are_analysed():
    ctx = _ctx(hidden=set(range(21, 109)))      # only 20 songs have features
    ms = _by_id(mixes.build_mixes(ctx, seed=3))
    assert 'supermix' in ms
    assert not any(k.startswith('mood-') for k in ms)


# ----------------------------------------- R5: unanalysed songs are placed

def test_mood_mixes_only_use_analysed_songs_when_enough_are_analysed():
    ctx = _ctx(hidden={s for s in range(1, 109) if s % 3 == 0})   # a third has no features
    ms = _by_id(mixes.build_mixes(ctx, seed=21))
    moods = [m for k, m in ms.items() if k.startswith('mood-')]
    assert len(moods) == len(mixes.MOODS)
    for m in moods:
        assert all(ctx.featured(s) for s in m['song_ids']), m['id']


def test_feature_driven_mixes_carry_at_most_two_unanalysed_songs():
    # History kinds (liked, replay, ...) may keep unanalysed songs; the kinds
    # that judge songs by sound may not.
    ctx = _ctx(hidden=set(range(1, 37)))       # the Folk songs they play and like
    shelf = mixes.build_mixes(ctx, seed=8)
    for m in shelf:
        if m['kind'] in ('supermix', 'discover', 'my', 'mood'):
            assert sum(not ctx.featured(s) for s in m['song_ids']) <= mixes._UNANALYSED_MAX, m['id']
    for m in mixes.serialize(ctx, shelf):
        assert m['unanalysed'] == sum(not ctx.featured(s['id']) for s in m['songs']), m['id']


def test_unanalysed_songs_are_spread_through_the_mix_not_stacked_at_the_end():
    ctx = _ctx(hidden=set(range(1, 37)))
    pool = [s for s in ctx.songs if ctx.featured(s)][:12]
    extra = [s for s in ctx.songs if not ctx.featured(s)][:2]
    ordered = mixes.flow_order(ctx, pool + extra, np.random.default_rng(3))
    n = len(ordered)
    assert sorted(ordered) == sorted(pool + extra)
    pos = sorted(ordered.index(s) for s in extra)
    assert 0 < pos[0] and pos[1] < n - 1
    assert pos[1] - pos[0] >= n // 3


# ------------------------------------------ R3: refresh keeps the core

def test_pick_keeps_the_top_scorers_and_rotates_only_the_tail():
    ctx = _ctx()
    scores = {s: ctx.taste_score(s) for s in ctx.songs}
    top = sorted(scores, key=lambda s: -scores[s])[:24]
    runs = []
    for seed in (1, 2, 3, 4):
        run = mixes._pick(ctx, scores, 30, np.random.default_rng(seed),
                          mixes._Room(ctx), artist_cap=3)
        assert len(run) == 30 and len(set(run)) == 30
        assert set(top) <= set(run), seed
        runs.append(run)
    assert len(set().union(*map(set, runs))) > 30
    again = mixes._pick(ctx, scores, 30, np.random.default_rng(2),
                        mixes._Room(ctx), artist_cap=3)
    assert again == runs[1]


def test_a_refresh_keeps_the_core_of_every_mix_and_rotates_the_rest():
    ctx = _ctx()
    shelves = [_by_id(mixes.build_mixes(ctx, seed=s)) for s in (11, 23, 37)]
    stable = [k for k in shelves[0]
              if k in ('supermix', 'liked', 'replay') or k.startswith(('my-', 'artist-', 'mood-'))]
    rotated = False
    for mid in stable:
        for a, b in ((0, 1), (1, 2)):
            if mid not in shelves[a] or mid not in shelves[b]:
                continue
            A = set(shelves[a][mid]['song_ids'])
            B = set(shelves[b][mid]['song_ids'])
            assert len(A & B) / len(A | B) >= 0.6, mid
            rotated = rotated or A != B
    assert rotated


# ------------------------------------------------------- artist diversity

def test_no_mix_puts_more_than_four_songs_by_one_artist():
    ctx = _ctx()
    for seed in (4, 9):
        for m in mixes.build_mixes(ctx, seed=seed):
            counts = {}
            for s in m['song_ids']:
                counts[ctx.artist(s)] = counts.get(ctx.artist(s), 0) + 1
            assert max(counts.values()) <= 4, (m['id'], counts)


# ------------------------- (a) a mix kind never vanishes without a reason

EXPECTED_KINDS = ('supermix', 'my', 'discover', 'replay', 'now', 'new',
                  'rediscover', 'liked', 'artist', 'mood')


def _present_or_reasoned(ctx, seed):
    notes = []
    shelf = mixes.build_mixes(ctx, seed=seed, notes=notes)
    present = {m['kind'] for m in shelf}
    reasons = {kind for kind, _ in notes}
    for kind in EXPECTED_KINDS:
        assert kind in present or kind in reasons, f'{kind} vanished without a reason'
    for m in shelf:
        if m['kind'] == 'liked':
            assert len(m['song_ids']) >= 1, m['id']
        else:
            assert mixes._MIN_MIX <= len(m['song_ids']) <= mixes.MIX_SIZE, m['id']
    return shelf, notes


def test_a_thin_history_is_topped_up_to_the_minimum_not_dropped():
    songs, data, rows = _library()            # likes, but nothing played in 60 days
    liked = [s for s in songs if songs[s]['genre'] == 'Folk'][:12]
    fi = FeatureIndex.build(data, set(songs))
    ctx = Ctx(songs, liked, [], {}, {}, 9, fi, mixes.build_mood_percentiles(rows), now=NOW)
    notes = []
    shelf = _by_id(mixes.build_mixes(ctx, seed=6, notes=notes))
    assert len(shelf['replay']['song_ids']) >= mixes._MIN_MIX
    assert set(shelf['replay']['song_ids']) <= set(ctx.liked)   # topped up from what they like
    assert not any(kind == 'replay' for kind, _ in notes)


def test_no_mix_kind_vanishes_without_a_reason():
    tiny = dict(list(_library()[0].items())[:5])
    scenarios = [
        _ctx(),                                   # a full listener
        _ctx(listens=False, liked_n=0),           # a new listener
        _ctx(listens=False, liked_n=3),           # likes only
        _ctx(hidden=set(range(1, 37))),           # the listened songs have no audio
        _ctx(hidden=set(range(21, 109))),         # only 20 songs have audio
        mixes.Ctx(tiny, liked=[1]),               # a five-song library
    ]
    for ctx in scenarios:
        for seed in (3, 8):
            _present_or_reasoned(ctx, seed)


# ------------------ (b) history kinds keep unanalysed songs, placed explicitly

def test_history_kinds_keep_unanalysed_songs_and_feature_kinds_still_refuse_them():
    ctx = _ctx(hidden=set(range(1, 37)))      # every Folk song: liked and played, unanalysed
    shelf = _by_id(mixes.build_mixes(ctx, seed=4))
    assert set(shelf['liked']['song_ids']) == set(ctx.liked)
    assert any(not ctx.featured(s) for s in shelf['replay']['song_ids'])
    artists = [m for k, m in shelf.items() if k.startswith('artist-')]
    assert artists
    assert any(any(not ctx.featured(s) for s in m['song_ids']) for m in artists)
    for m in shelf.values():
        if m['kind'] in ('mood', 'my'):
            assert all(ctx.featured(s) for s in m['song_ids']), m['id']


# ------------------------------ (c) the order is stable across refreshes

def test_same_seed_gives_the_same_order_and_refreshes_keep_the_liked_order():
    a = mixes.build_mixes(_ctx(), seed=11)
    b = mixes.build_mixes(_ctx(), seed=11)
    assert [m['song_ids'] for m in a] == [m['song_ids'] for m in b]
    ctx = _ctx()
    liked_a = _by_id(mixes.build_mixes(ctx, seed=11))['liked']['song_ids']
    liked_b = _by_id(mixes.build_mixes(ctx, seed=23))['liked']['song_ids']
    assert liked_a == liked_b          # the whole liked set is fixed, so is its order


def test_flow_keeps_the_core_order_when_only_the_tail_changes():
    ctx = _ctx()
    pool = [s for s in ctx.songs if ctx.featured(s)]
    core, tail_a, tail_b = pool[:10], pool[10:14], pool[14:18]
    fa = mixes.flow_order(ctx, core + tail_a, core=core)
    fb = mixes.flow_order(ctx, core + tail_b, core=core)
    assert [s for s in fa if s in core] == [s for s in fb if s in core]
    assert sorted(fa) == sorted(core + tail_a)


# -------------------------------- (d) the My Mix cluster-size floor

def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def test_taste_groups_hold_the_cluster_size_floor():
    rng = np.random.default_rng(0)
    big = [_unit(np.array([1.0, 0.0, 0.0, 0.0]) + rng.normal(0, 0.05, 4)) for _ in range(14)]
    small = [_unit(np.array([0.0, 1.0, 0.0, 0.0]) + rng.normal(0, 0.05, 4)) for _ in range(3)]
    U = np.stack(big + small)
    groups = mixes._taste_groups(U, np.ones(len(U)), 2)
    assert len(groups) == 2
    assert all(len(g) >= mixes._MY_MIN_MEMBERS for g in groups)
    assert sorted(np.concatenate(groups).tolist()) == list(range(17))


def test_a_group_too_small_to_stand_alone_is_folded_not_dropped():
    U = np.stack([_unit([1.0, 0.0, 0.0, 0.0])] * 4 + [_unit([0.0, 1.0, 0.0, 0.0])] * 2)
    groups = mixes._taste_groups(U, np.ones(6), 2)
    assert len(groups) == 1 and len(groups[0]) == 6


def test_my_group_count_follows_the_profile_and_the_floor():
    assert mixes._my_group_count(12) == 2
    assert mixes._my_group_count(17) == mixes._MY_MIX_FLOOR
    assert mixes._my_group_count(246) == mixes._MY_MIX_MAX


def test_taste_across_three_clusters_keeps_three_my_mixes():
    ctx = _ctx(played=('Folk', 'Rock', 'Electronic'))
    my = [m for m in mixes.build_mixes(ctx, seed=5) if m['kind'] == 'my']
    assert len(my) >= mixes._MY_MIX_FLOOR
    dominant = set()
    for m in my:
        genres = [ctx.songs[s]['genre'] for s in m['song_ids']]
        dominant.add(max(set(genres), key=genres.count))
    assert dominant == {'Folk', 'Rock', 'Electronic'}


def test_too_few_analysed_listened_songs_gives_no_my_mix_and_says_why():
    ctx = _ctx(hidden=set(range(6, 109)))     # five analysed songs
    notes = []
    shelf = mixes.build_mixes(ctx, seed=2, notes=notes)
    assert not any(m['kind'] == 'my' for m in shelf)
    assert any(kind == 'my' for kind, _ in notes)
