"""Play-history recording/reading logic (no live database needed)."""
from decimal import Decimal

import pytest
from mysql.connector import errors as mysql_errors

from models.playback_history import InvalidPlay, PlaybackHistoryModel, aggregate_top_artists


class FakeDB:
    def __init__(self):
        self.calls = []
        self.results = []
        self.error = None

    def __call__(self, query, params=None, fetch_one=False, fetch_all=False):
        # Background workers/hooks share Database.execute_query; only track
        # the play_history statements under test.
        if 'play_history' not in query:
            return None
        self.calls.append((' '.join(query.split()), params))
        if self.error:
            raise self.error
        if fetch_one or fetch_all:
            return self.results.pop(0) if self.results else ([] if fetch_all else None)
        return 1


@pytest.fixture
def db(monkeypatch):
    fake = FakeDB()

    # Patch only the playback model's Database reference: patching the shared
    # class would also hijack session validation queries made by the auth layer.
    class _FakeDatabase:
        execute_query = staticmethod(fake)

    monkeypatch.setattr('models.playback_history.Database', _FakeDatabase)
    return fake


# ---------------------------------------------------------------- validation

def test_normalize_cleans_and_clamps():
    p = PlaybackHistoryModel.normalize_play({
        'song_id': '12', 'duration': 30.6, 'position': -5, 'play_id': ' abc ',
        'age_seconds': 10 ** 12, 'client': 'mobile-with-a-very-long-name',
    })
    assert p['song_id'] == 12
    assert p['duration'] == 31
    assert p['position'] == 0
    assert p['play_id'] == 'abc'
    assert p['age'] == 30 * 24 * 3600
    assert len(p['client']) == 16
    assert p['counted'] == 1  # legacy clients: every report is a real listen


@pytest.mark.parametrize('bad', [
    {}, {'song_id': None}, {'song_id': 'x'}, {'song_id': 0}, {'song_id': -3},
    {'song_id': 1, 'play_id': 'x' * 65}, {'song_id': 1, 'play_id': '  '}, 'nope', None,
])
def test_normalize_rejects(bad):
    with pytest.raises(InvalidPlay):
        PlaybackHistoryModel.normalize_play(bad)


def test_normalize_survives_junk_numbers():
    p = PlaybackHistoryModel.normalize_play(
        {'song_id': 1, 'duration': float('nan'), 'age_seconds': 'soon'})
    assert p['duration'] == 0 and p['age'] == 0


# ------------------------------------------------------------------- writes

def test_record_play_is_an_upsert_on_play_id(db):
    PlaybackHistoryModel.record_play(1, 5, duration=42, play_id='p1', counted=False, client='web')
    query, params = db.calls[0]
    assert 'ON DUPLICATE KEY UPDATE' in query
    assert 'GREATEST(duration, VALUES(duration))' in query
    assert 'GREATEST(counted, VALUES(counted))' in query
    assert 'FROM_UNIXTIME' in query
    user, song, position, duration, _epoch, play_id, counted, client = params
    assert (user, song, duration, play_id, counted, client) == (1, 5, 42, 'p1', 0, 'web')


def test_record_play_backdates_offline_plays(db):
    import time
    PlaybackHistoryModel.record_play(1, 5, duration=40, play_id='p2', age_seconds=3600)
    epoch = db.calls[0][1][4]
    assert abs(epoch - (time.time() - 3600)) < 5


def test_record_play_missing_song_maps_to_lookup_error(db):
    db.error = mysql_errors.IntegrityError(msg='fk', errno=1452)
    with pytest.raises(LookupError):
        PlaybackHistoryModel.record_play(1, 999999, play_id='p3')


def test_batch_separates_permanent_rejects_from_recorded(db):
    recorded, rejected = PlaybackHistoryModel.record_plays(1, [
        {'song_id': 1, 'play_id': 'a', 'duration': 30},
        {'song_id': 'bad', 'play_id': 'b'},
        {'song_id': 2, 'play_id': 'c', 'duration': 12, 'counted': False},
    ])
    assert recorded == ['a', 'c']
    assert rejected == ['b']
    assert len(db.calls) == 2


# -------------------------------------------------------------------- reads

def test_stats_are_plain_ints_even_when_sum_is_decimal(db):
    db.results = [{'total_plays': 3, 'unique_songs': 2, 'active_days': 1,
                   'total_seconds': Decimal('725')}]
    stats = PlaybackHistoryModel.get_listening_stats(1)
    assert stats == {'total_plays': 3, 'unique_songs': 2, 'active_days': 1, 'total_seconds': 725}
    assert all(type(v) is int for v in stats.values())
    assert 'counted = 1' in db.calls[0][0]


def test_stats_for_a_new_user_are_zeros(db):
    db.results = [None]
    assert PlaybackHistoryModel.get_listening_stats(1)['total_plays'] == 0


def _row(**over):
    row = {'song_id': 1, 'played_epoch': 1_700_000_000, 'title': 't', 'artist': 'a',
           'album': 'al', 'duration': 200, 'cover_path': None, 'genre': 'g',
           'year': 2020, 'track_number': 1, 'file_path': '/x.mp3'}
    row.update(over)
    return row


def test_recently_played_has_utc_iso_and_stable_ordering(db):
    db.results = [[_row()]]
    songs = PlaybackHistoryModel.get_recently_played(1, limit=10, offset=0)
    assert songs[0]['played_at'] == '2023-11-14T22:13:20+00:00'
    query = db.calls[0][0]
    # newest first with an id tie-break (played_at only has 1s resolution)
    assert 'ORDER BY r.last_played DESC, r.last_id DESC' in query
    # started-but-not-counted listens still show up in Recently Played
    assert 'counted' not in query


def test_most_played_counts_only_qualifying_listens(db):
    db.results = [[_row(play_count=Decimal('4'))]]
    songs = PlaybackHistoryModel.get_play_counts(1, 5)
    assert songs[0]['play_count'] == 4 and type(songs[0]['play_count']) is int
    assert 'counted = 1' in db.calls[0][0]
    assert 'r.play_count DESC, r.last_played DESC' in db.calls[0][0]


def test_top_artists_credit_every_artist_on_a_collab(db):
    # bbno$'s solo track plus two features: every play must reach bbno$.
    db.results = [[
        {'artist': 'bbno$', 'play_count': Decimal('71')},
        {'artist': 'bbno$, Ethan Nestor', 'play_count': Decimal('38')},
        {'artist': 'bbno$, ironmouse', 'play_count': Decimal('28')},
        {'artist': 'ironmouse', 'play_count': Decimal('59')},
    ]]
    artists = PlaybackHistoryModel.get_top_artists(1, 10)
    assert artists[0] == {'artist': 'bbno$', 'play_count': 137, 'song_count': 3}
    assert artists[1] == {'artist': 'ironmouse', 'play_count': 87, 'song_count': 2}
    assert artists[2] == {'artist': 'Ethan Nestor', 'play_count': 38, 'song_count': 1}
    query = db.calls[0][0]
    assert 'counted = 1' in query
    # Per-song rows: a SQL LIMIT before splitting credits would drop plays.
    assert 'GROUP BY s.id, s.artist' in query
    assert 'LIMIT' not in query


def test_top_artists_merge_case_and_dedupe_within_a_credit():
    rows = [{'artist': 'A, a, B', 'play_count': 3}, {'artist': 'a', 'play_count': 2}]
    assert aggregate_top_artists(rows, 10) == [
        {'artist': 'A', 'play_count': 5, 'song_count': 2},
        {'artist': 'B', 'play_count': 3, 'song_count': 1},
    ]


def test_top_artists_empty_credit_is_unknown_artist():
    rows = [{'artist': None, 'play_count': 2}, {'artist': '  ', 'play_count': 1}]
    assert aggregate_top_artists(rows, 10) == [
        {'artist': 'Unknown Artist', 'play_count': 3, 'song_count': 2}]


def test_top_artists_ties_break_alphabetically_and_limit_applies():
    rows = [{'artist': 'Zed', 'play_count': 4}, {'artist': 'alice', 'play_count': 4},
            {'artist': 'Bob', 'play_count': 1}]
    assert [a['artist'] for a in aggregate_top_artists(rows, 2)] == ['alice', 'Zed']


# ------------------------------------------------------------------- routes

def test_route_records_play_with_new_fields(client, db):
    r = client.post('/api/playback/history', json={
        'song_id': 3, 'duration': 31, 'play_id': 'zz', 'counted': True,
        'age_seconds': 4, 'client': 'mobile'})
    assert r.status_code == 200
    assert db.calls[0][1][5] == 'zz'


def test_route_accepts_beacon_style_body_without_json_content_type(client, db):
    r = client.post('/api/playback/history', data='{"song_id": 3, "duration": 31}',
                    content_type='text/plain')
    assert r.status_code == 200


def test_route_bad_payloads(client, db):
    assert client.post('/api/playback/history', data='not json').status_code == 400
    assert client.post('/api/playback/history', json={'song_id': 'x'}).status_code == 400
    db.error = mysql_errors.IntegrityError(msg='fk', errno=1452)
    assert client.post('/api/playback/history', json={'song_id': 9}).status_code == 404


def test_batch_route(client, db):
    r = client.post('/api/playback/history/batch', json={'plays': [
        {'song_id': 1, 'play_id': 'a', 'duration': 30},
        {'song_id': 0, 'play_id': 'b'},
    ]})
    assert r.status_code == 200
    body = r.get_json()
    assert body['recorded'] == ['a'] and body['rejected'] == ['b']


def test_batch_route_validation(client, db):
    assert client.post('/api/playback/history/batch', json={'plays': 'x'}).status_code == 400
    too_many = [{'song_id': 1, 'play_id': str(i)} for i in range(201)]
    assert client.post('/api/playback/history/batch', json={'plays': too_many}).status_code == 400


def test_batch_route_requires_auth(anon_client):
    assert anon_client.post('/api/playback/history/batch', json={'plays': []}).status_code in (401, 403, 302)


def test_artists_route_clamps_limit(client, db):
    db.results = [[{'artist': 'A', 'play_count': 2}, {'artist': 'B', 'play_count': 1}]]
    r = client.get('/api/playback/history/artists?limit=-1')
    assert r.status_code == 200
    # Clamped to 1 — a negative slice would silently drop the last artist.
    assert len(r.get_json()['artists']) == 1
    db.results = [[]]
    assert client.get('/api/playback/history/artists?limit=99999999').status_code == 200


def test_genres_route_clamps_limit(client, db):
    db.results = [[]]
    assert client.get('/api/playback/history/genres?limit=-5').status_code == 200
    assert db.calls[0][1] == (1, 1)
