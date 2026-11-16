"""Insights logic tests (streak math, top-artist aggregation) — no live database."""
from datetime import date, timedelta

from utils.insights import compute_streaks, STREAK_MIN_SECONDS


def d(offset):
    """A date `offset` days from a fixed anchor (today)."""
    return date(2026, 11, 15) + timedelta(days=offset)


TODAY = d(0)


def test_empty_history_has_no_streak():
    s = compute_streaks([], TODAY)
    assert s['current'] == 0 and s['longest'] == 0
    assert s['today_active'] is False and s['at_risk'] is False
    assert s['last_active'] is None


def test_single_day_today():
    s = compute_streaks([TODAY], TODAY)
    assert s['current'] == 1 and s['longest'] == 1
    assert s['today_active'] is True and s['at_risk'] is False


def test_consecutive_days_ending_today():
    days = [d(-i) for i in range(5)]   # today and the 4 days before
    s = compute_streaks(days, TODAY)
    assert s['current'] == 5 and s['longest'] == 5
    assert s['today_active'] is True


def test_yesterday_active_today_not_is_at_risk():
    days = [d(-1), d(-2), d(-3)]       # 3-day run ending yesterday
    s = compute_streaks(days, TODAY)
    assert s['current'] == 3
    assert s['today_active'] is False
    assert s['at_risk'] is True        # "listen today to keep it"


def test_gap_breaks_current_streak():
    days = [d(-3), d(-4), d(-5)]       # run ended 3 days ago, today empty
    s = compute_streaks(days, TODAY)
    assert s['current'] == 0           # streak is broken
    assert s['longest'] == 3
    assert s['at_risk'] is False


def test_longest_run_can_be_in_the_past():
    # old 6-day run, then a gap, then a fresh 2-day run ending today
    days = [d(-20), d(-19), d(-18), d(-17), d(-16), d(-15), d(-1), d(0)]
    s = compute_streaks(days, TODAY)
    assert s['current'] == 2
    assert s['longest'] == 6


def test_today_active_extends_a_run_that_started_yesterday():
    days = [d(-2), d(-1), d(0)]
    s = compute_streaks(days, TODAY)
    assert s['current'] == 3 and s['longest'] == 3
    assert s['at_risk'] is False


def test_unsorted_input_and_duplicates_are_handled():
    days = [d(0), d(-2), d(-1), d(-1), d(0)]
    s = compute_streaks(days, TODAY)
    assert s['current'] == 3 and s['longest'] == 3


def test_min_seconds_threshold_is_sane():
    assert STREAK_MIN_SECONDS >= 30   # a real listen, not an accidental tap


# --------------------------------------------------------------- top artists

class _FakeDB:
    """Stands in for utils.insights.Database; records queries, pops results."""

    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def execute_query(self, query, params=None, fetch_one=False, fetch_all=False):
        self.calls.append((' '.join(query.split()), params))
        return self.results.pop(0) if self.results else ([] if fetch_all else None)


def test_insights_top_artists_split_collab_credits(monkeypatch):
    from utils import insights
    fake = _FakeDB([[{'artist': 'A, B', 'play_count': 5}, {'artist': 'B', 'play_count': 4}]])
    monkeypatch.setattr(insights, 'Database', fake)
    assert insights._top_artists(1, 10) == [
        {'name': 'B', 'play_count': 9, 'song_count': 2},
        {'name': 'A', 'play_count': 5, 'song_count': 1},
    ]
    assert 'GROUP BY s.id, s.artist' in fake.calls[0][0]


def test_insights_top_artists_respect_day_selection(monkeypatch):
    from utils import insights
    fake = _FakeDB([[]])
    monkeypatch.setattr(insights, 'Database', fake)
    insights._top_artists(1, 10, selected={date(2026, 11, 15)})
    query, params = fake.calls[0]
    assert 'DATE(ph.played_at) IN (%s)' in query
    assert params == (1, '2026-11-15')


def test_wrapped_top_artist_credits_collabs(monkeypatch):
    from utils import insights
    fake = _FakeDB([
        {'total_plays': 21, 'unique_songs': 3, 'total_seconds': 900,
         'active_days': 3, 'first_listen': None},
        # X leads on solo plays, but Y's feature pushes Y past X once split.
        [{'artist': 'X', 'play_count': 10},
         {'artist': 'Y, Z', 'play_count': 6},
         {'artist': 'Y', 'play_count': 5}],
        None, None, None,
    ])
    monkeypatch.setattr(insights, 'Database', fake)
    wrapped = insights.build_wrapped(1, 2026)
    assert wrapped['top_artist'] == {'name': 'Y', 'plays': 11}