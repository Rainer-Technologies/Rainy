"""Pure-logic tests for the listening streak math (no database needed)."""
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