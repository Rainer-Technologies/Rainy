"""Listening insights + Duolingo-style daily streaks ("Rainy Wrapped").

Read-only aggregations over play_history. The streak math lives in
`compute_streaks`, a pure function over a set of qualifying dates so it can be
unit-tested without a database.

A "listening day" is a day with at least STREAK_MIN_SECONDS of *counted*
listening — a one-second accidental tap does not keep a streak alive.

The interactive calendar can select a set of days; when `selected` is passed to
build_insights, the overview / clock / tops / trend are filtered to just those
days, while the calendar history and the streak always span the full history.
"""
from datetime import date, timedelta

from models.database import Database
from models.playback_history import _to_epoch_iso

# Minimum counted seconds in a day for it to count toward a streak.
STREAK_MIN_SECONDS = 60
TREND_DAYS = 30             # daily listening trend length (no selection)


def compute_streaks(active_days, today):
    """Current / longest run of consecutive listening days.

    `active_days` is any iterable of datetime.date. `today` is a date.
    The current streak counts back from today; if today has not qualified yet
    but yesterday did, the streak is still alive and `at_risk` is True (the
    Duolingo "play today to keep it" state). Returns plain JSON-safe values.
    """
    days = set(active_days)
    if not days:
        return {'current': 0, 'longest': 0, 'today_active': False,
                'at_risk': False, 'last_active': None}
    today_active = today in days
    anchor = today if today_active else today - timedelta(days=1)
    current = 0
    d = anchor
    while d in days:
        current += 1
        d -= timedelta(days=1)
    at_risk = (not today_active) and current > 0

    longest = run = 0
    prev = None
    for d in sorted(days):
        run = run + 1 if (prev is not None and (d - prev).days == 1) else 1
        longest = max(longest, run)
        prev = d

    return {'current': current, 'longest': longest, 'today_active': today_active,
            'at_risk': at_risk, 'last_active': max(days).isoformat()}


def _as_date(value):
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _sel_clause(selected, col='played_at'):
    """SQL fragment + params restricting to a set of dates (empty -> no filter)."""
    if not selected:
        return '', []
    ph = ','.join(['%s'] * len(selected))
    return f' AND DATE({col}) IN ({ph})', [d.isoformat() for d in sorted(selected)]


def _daily_rows(user_id):
    """One row per calendar day: {date, seconds, plays} (counted listens)."""
    rows = Database.execute_query(
        """
        SELECT DATE(played_at) AS d, COALESCE(SUM(duration), 0) AS secs, COUNT(*) AS plays
        FROM play_history
        WHERE user_id = %s AND counted = 1
        GROUP BY DATE(played_at)
        """,
        (user_id,), fetch_all=True) or []
    return [{'date': _as_date(r['d']), 'seconds': int(r['secs'] or 0),
             'plays': int(r['plays'] or 0)} for r in rows]


def _qualifying_days(daily):
    return {r['date'] for r in daily if r['seconds'] >= STREAK_MIN_SECONDS}


def _overview(user_id, selected=None):
    clause, params = _sel_clause(selected)
    row = Database.execute_query(
        f"""
        SELECT COUNT(*) AS total_plays, COUNT(DISTINCT song_id) AS unique_songs,
               COALESCE(SUM(duration), 0) AS total_seconds,
               COUNT(DISTINCT DATE(played_at)) AS active_days,
               MIN(played_at) AS first_listen
        FROM play_history
        WHERE user_id = %s AND counted = 1{clause}
        """,
        (user_id, *params), fetch_one=True) or {}
    first = row.get('first_listen')
    return {
        'total_plays': int(row.get('total_plays') or 0),
        'unique_songs': int(row.get('unique_songs') or 0),
        'total_seconds': int(row.get('total_seconds') or 0),
        'active_days': int(row.get('active_days') or 0),
        'first_listen': first.date().isoformat() if hasattr(first, 'date') else (
            str(first)[:10] if first else None),
    }


def _clock(user_id, selected=None):
    """Listening seconds by hour of day (0-23) and by weekday (Mon=0)."""
    clause, params = _sel_clause(selected)
    hours = [0] * 24
    for r in Database.execute_query(
            f"""
            SELECT HOUR(played_at) AS h, COALESCE(SUM(duration), 0) AS secs
            FROM play_history WHERE user_id = %s AND counted = 1{clause}
            GROUP BY HOUR(played_at)
            """, (user_id, *params), fetch_all=True) or []:
        h = int(r['h'])
        if 0 <= h < 24:
            hours[h] = int(r['secs'] or 0)
    weekdays = [0] * 7
    for r in Database.execute_query(
            f"""
            SELECT DAYOFWEEK(played_at) AS dw, COALESCE(SUM(duration), 0) AS secs
            FROM play_history WHERE user_id = %s AND counted = 1{clause}
            GROUP BY DAYOFWEEK(played_at)
            """, (user_id, *params), fetch_all=True) or []:
        idx = (int(r['dw']) + 5) % 7   # Sun(1)->6, Mon(2)->0, ... Sat(7)->5
        weekdays[idx] = int(r['secs'] or 0)
    return {'hours': hours, 'weekdays': weekdays}


def _top_artists(user_id, limit, selected=None):
    clause, params = _sel_clause(selected, 'ph.played_at')
    rows = Database.execute_query(
        f"""
        SELECT s.artist AS name, COUNT(*) AS play_count, COUNT(DISTINCT s.id) AS song_count
        FROM play_history ph JOIN songs s ON ph.song_id = s.id
        WHERE ph.user_id = %s AND ph.counted = 1{clause}
        GROUP BY s.artist ORDER BY play_count DESC, s.artist ASC LIMIT %s
        """, (user_id, *params, limit), fetch_all=True) or []
    for r in rows:
        r['play_count'] = int(r['play_count'])
        r['song_count'] = int(r['song_count'])
    return rows


def _top_songs(user_id, limit, selected=None):
    clause, params = _sel_clause(selected, 'ph.played_at')
    rows = Database.execute_query(
        f"""
        SELECT s.id, s.title, s.artist, s.album, s.cover_path, s.duration,
               COUNT(*) AS play_count, COALESCE(SUM(ph.duration), 0) AS seconds
        FROM play_history ph JOIN songs s ON ph.song_id = s.id
        WHERE ph.user_id = %s AND ph.counted = 1{clause}
        GROUP BY s.id, s.title, s.artist, s.album, s.cover_path, s.duration
        ORDER BY play_count DESC, seconds DESC LIMIT %s
        """, (user_id, *params, limit), fetch_all=True) or []
    for r in rows:
        r['play_count'] = int(r['play_count'])
        r['seconds'] = int(r['seconds'] or 0)
    return rows


def _top_genres(user_id, limit, selected=None):
    clause, params = _sel_clause(selected, 'ph.played_at')
    rows = Database.execute_query(
        f"""
        SELECT s.genre AS name, COUNT(*) AS play_count
        FROM play_history ph JOIN songs s ON ph.song_id = s.id
        WHERE ph.user_id = %s AND ph.counted = 1{clause}
          AND s.genre IS NOT NULL AND s.genre != ''
        GROUP BY s.genre ORDER BY play_count DESC, s.genre ASC LIMIT %s
        """, (user_id, *params, limit), fetch_all=True) or []
    for r in rows:
        r['play_count'] = int(r['play_count'])
    return rows


def _top_albums(user_id, limit, selected=None):
    clause, params = _sel_clause(selected, 'ph.played_at')
    rows = Database.execute_query(
        f"""
        SELECT s.album AS name, s.artist AS secondary, COUNT(*) AS play_count
        FROM play_history ph JOIN songs s ON ph.song_id = s.id
        WHERE ph.user_id = %s AND ph.counted = 1{clause}
          AND s.album IS NOT NULL AND s.album != ''
        GROUP BY s.album, s.artist ORDER BY play_count DESC, s.album ASC LIMIT %s
        """, (user_id, *params, limit), fetch_all=True) or []
    for r in rows:
        r['play_count'] = int(r['play_count'])
    return rows


def _on_this_day(user_id, today):
    rows = Database.execute_query(
        """
        SELECT YEAR(ph.played_at) AS yr, s.title, s.artist, s.cover_path,
               COUNT(*) AS play_count
        FROM play_history ph JOIN songs s ON ph.song_id = s.id
        WHERE ph.user_id = %s AND ph.counted = 1
          AND MONTH(ph.played_at) = %s AND DAY(ph.played_at) = %s
          AND YEAR(ph.played_at) < %s
        GROUP BY yr, s.id, s.title, s.artist, s.cover_path
        ORDER BY yr DESC, play_count DESC
        LIMIT 40
        """, (user_id, today.month, today.day, today.year), fetch_all=True) or []
    by_year = {}
    for r in rows:
        yr = int(r['yr'])
        by_year.setdefault(yr, []).append(
            {'title': r['title'], 'artist': r['artist'],
             'cover_path': r['cover_path'], 'play_count': int(r['play_count'])})
    return [{'year': yr, 'songs': songs} for yr, songs in sorted(by_year.items(), reverse=True)]


def build_insights(user_id, today=None, selected=None):
    """The Insights page payload.

    `selected` (a set of datetime.date) filters the overview / clock / tops /
    trend to those days. The calendar `history` and the `streak` always span the
    full history so the calendar stays stable while the user selects days.
    """
    today = today or date.today()
    selected = set(selected) if selected else None
    daily = _daily_rows(user_id)
    by_date = {r['date']: r for r in daily}
    qualifying = _qualifying_days(daily)
    streak = compute_streaks(qualifying, today)

    # Full contribution-calendar range: first listening day -> today.
    start = min(by_date) if by_date else today
    history = []
    d = start
    while d <= today:
        rec = by_date.get(d)
        history.append({'date': d.isoformat(),
                        'seconds': rec['seconds'] if rec else 0,
                        'plays': rec['plays'] if rec else 0,
                        'active': d in qualifying})
        d += timedelta(days=1)

    if selected:
        trends = [{'date': d.isoformat(),
                   'seconds': by_date.get(d, {}).get('seconds', 0),
                   'plays': by_date.get(d, {}).get('plays', 0)}
                  for d in sorted(selected)]
    else:
        trends = []
        for i in range(TREND_DAYS - 1, -1, -1):
            d = today - timedelta(days=i)
            rec = by_date.get(d)
            trends.append({'date': d.isoformat(),
                           'seconds': rec['seconds'] if rec else 0,
                           'plays': rec['plays'] if rec else 0})

    return {
        'overview': _overview(user_id, selected),
        'streak': {**streak, 'min_seconds': STREAK_MIN_SECONDS},
        'history': history,
        'clock': _clock(user_id, selected),
        'trends': trends,
        'top_artists': _top_artists(user_id, 10, selected),
        'top_songs': _top_songs(user_id, 10, selected),
        'top_genres': _top_genres(user_id, 10, selected),
        'top_albums': _top_albums(user_id, 10, selected),
        'on_this_day': _on_this_day(user_id, today),
        'selected_dates': sorted(d.isoformat() for d in selected) if selected else [],
        'generated_for': today.isoformat(),
    }


def build_wrapped(user_id, year):
    """A shareable year-in-review card."""
    row = Database.execute_query(
        """
        SELECT COUNT(*) AS total_plays, COUNT(DISTINCT song_id) AS unique_songs,
               COALESCE(SUM(duration), 0) AS total_seconds,
               COUNT(DISTINCT DATE(played_at)) AS active_days,
               MIN(played_at) AS first_listen
        FROM play_history
        WHERE user_id = %s AND counted = 1 AND YEAR(played_at) = %s
        """, (user_id, year), fetch_one=True) or {}

    def _top(sql):
        return Database.execute_query(sql, (user_id, year), fetch_one=True)

    top_artist = _top(
        """SELECT s.artist AS name, COUNT(*) AS plays
           FROM play_history ph JOIN songs s ON ph.song_id = s.id
           WHERE ph.user_id=%s AND ph.counted=1 AND YEAR(ph.played_at)=%s
           GROUP BY s.artist ORDER BY plays DESC, s.artist ASC LIMIT 1""")
    top_song = _top(
        """SELECT s.title AS name, s.artist AS secondary, s.cover_path AS cover_path,
                  COUNT(*) AS plays
           FROM play_history ph JOIN songs s ON ph.song_id = s.id
           WHERE ph.user_id=%s AND ph.counted=1 AND YEAR(ph.played_at)=%s
           GROUP BY s.id, s.title, s.artist, s.cover_path
           ORDER BY plays DESC, s.title ASC LIMIT 1""")
    top_genre = _top(
        """SELECT s.genre AS name, COUNT(*) AS plays
           FROM play_history ph JOIN songs s ON ph.song_id = s.id
           WHERE ph.user_id=%s AND ph.counted=1 AND YEAR(ph.played_at)=%s
             AND s.genre IS NOT NULL AND s.genre != ''
           GROUP BY s.genre ORDER BY plays DESC, s.genre ASC LIMIT 1""")
    biggest_month = _top(
        """SELECT MONTH(played_at) AS m, COALESCE(SUM(duration),0) AS secs
           FROM play_history WHERE user_id=%s AND counted=1 AND YEAR(played_at)=%s
           GROUP BY MONTH(played_at) ORDER BY secs DESC LIMIT 1""")

    first = row.get('first_listen')
    return {
        'year': year,
        'total_plays': int(row.get('total_plays') or 0),
        'unique_songs': int(row.get('unique_songs') or 0),
        'total_seconds': int(row.get('total_seconds') or 0),
        'active_days': int(row.get('active_days') or 0),
        'first_listen': first.date().isoformat() if hasattr(first, 'date') else (
            str(first)[:10] if first else None),
        'top_artist': {'name': top_artist['name'], 'plays': int(top_artist['plays'])} if top_artist else None,
        'top_song': {'name': top_song['name'], 'artist': top_song['secondary'],
                     'cover_path': top_song['cover_path'], 'plays': int(top_song['plays'])} if top_song else None,
        'top_genre': {'name': top_genre['name'], 'plays': int(top_genre['plays'])} if top_genre else None,
        'biggest_month': int(biggest_month['m']) if biggest_month else None,
    }


def build_day(user_id, day):
    """One day's listening: hourly clock, totals, tops and the actual listens."""
    iso = day.isoformat()
    totals = Database.execute_query(
        """
        SELECT COALESCE(SUM(duration), 0) AS secs, COUNT(*) AS plays,
               COUNT(DISTINCT song_id) AS uniq
        FROM play_history
        WHERE user_id = %s AND counted = 1 AND DATE(played_at) = %s
        """, (user_id, iso), fetch_one=True) or {}

    hours = [0] * 24
    for r in Database.execute_query(
            """
            SELECT HOUR(played_at) AS h, COALESCE(SUM(duration), 0) AS secs
            FROM play_history
            WHERE user_id = %s AND counted = 1 AND DATE(played_at) = %s
            GROUP BY HOUR(played_at)
            """, (user_id, iso), fetch_all=True) or []:
        h = int(r['h'])
        if 0 <= h < 24:
            hours[h] = int(r['secs'] or 0)

    top_songs = Database.execute_query(
        """
        SELECT s.id, s.title, s.artist, s.cover_path, COUNT(*) AS play_count,
               COALESCE(SUM(ph.duration), 0) AS seconds
        FROM play_history ph JOIN songs s ON ph.song_id = s.id
        WHERE ph.user_id = %s AND ph.counted = 1 AND DATE(ph.played_at) = %s
        GROUP BY s.id, s.title, s.artist, s.cover_path
        ORDER BY play_count DESC, seconds DESC LIMIT 10
        """, (user_id, iso), fetch_all=True) or []
    for r in top_songs:
        r['play_count'] = int(r['play_count'])
        r['seconds'] = int(r['seconds'] or 0)

    listens = Database.execute_query(
        """
        SELECT s.title, s.artist, s.cover_path, UNIX_TIMESTAMP(ph.played_at) AS epoch,
               ph.duration
        FROM play_history ph JOIN songs s ON ph.song_id = s.id
        WHERE ph.user_id = %s AND ph.counted = 1 AND DATE(ph.played_at) = %s
        ORDER BY ph.played_at ASC LIMIT 200
        """, (user_id, iso), fetch_all=True) or []
    for r in listens:
        r['played_at'] = _to_epoch_iso(r['epoch'])
        r['duration'] = int(r['duration'] or 0)

    return {
        'date': iso,
        'total_seconds': int(totals.get('secs') or 0),
        'plays': int(totals.get('plays') or 0),
        'unique_songs': int(totals.get('uniq') or 0),
        'hours': hours,
        'top_songs': top_songs,
        'listens': listens,
    }