"""SQLite backend — runs Rainy from a single file when there is no MySQL server.

The models speak MySQL. Rather than fork every query, this module wraps
sqlite3 in a connection/cursor shaped like mysql-connector's (cursor(
dictionary=True), %s placeholders, datetime values in rows) and rewrites the
handful of MySQL-only constructs the app uses:

  - CREATE TABLE: AUTO_INCREMENT, ENUM, inline INDEX/UNIQUE KEY,
    DEFAULT/ON UPDATE CURRENT_TIMESTAMP (the latter becomes a trigger)
  - INSERT IGNORE, ON DUPLICATE KEY UPDATE ... VALUES(col)
  - NOW(), CURRENT_TIMESTAMP, DATE_ADD/DATE_SUB, NOW() - INTERVAL n UNIT
  - GROUP_CONCAT(... SEPARATOR ...), GREATEST/LEAST, RAND()
  - UNIX_TIMESTAMP, FROM_UNIXTIME, HOUR, MOD, FIELD, MD5 (as SQL functions)

Timestamps are stored as local-time 'YYYY-MM-DD HH:MM:SS' text, matching
what Python's datetime.now() writes elsewhere in the app. Text columns are
COLLATE NOCASE so lookups/sorting stay case-insensitive like MySQL's default
collation.

New SQL should stay within this subset (or plain portable SQL). Multi-table
UPDATE/DELETE (DELETE t1 FROM t1 JOIN t2 ...) is not translated — write it
with a subquery instead.
"""

import hashlib
import os
import re
import sqlite3
from datetime import date, datetime, timedelta
from decimal import Decimal
from functools import lru_cache

# ── Value conversion ────────────────────────────────────────────────

_TS_FMT = '%Y-%m-%d %H:%M:%S'
_TS_RE = re.compile(r'^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$')


def _adapt_datetime(dt):
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt.strftime(_TS_FMT)


sqlite3.register_adapter(datetime, _adapt_datetime)
sqlite3.register_adapter(date, lambda d: d.isoformat())
sqlite3.register_adapter(Decimal, float)


def _parse_ts(value):
    """Stored timestamp text -> naive local datetime (None when unparseable)."""
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value)
    if isinstance(value, str) and _TS_RE.match(value):
        return datetime.fromisoformat(value.replace('T', ' '))
    return None


def _out(value):
    # mysql-connector hands back datetime objects for DATETIME/TIMESTAMP
    # columns (and MAX() over them); callers rely on .isoformat() etc.
    if isinstance(value, str) and len(value) >= 19 and _TS_RE.match(value):
        return datetime.fromisoformat(value.replace('T', ' '))
    return value


# ── SQL functions MySQL has and SQLite lacks ────────────────────────

def _now():
    return datetime.now().strftime(_TS_FMT)


def _unix_timestamp(value=None):
    if value is None:
        return int(datetime.now().timestamp())
    dt = _parse_ts(value)
    return int(dt.timestamp()) if dt else None


def _from_unixtime(epoch):
    if epoch is None:
        return None
    return datetime.fromtimestamp(float(epoch)).strftime(_TS_FMT)


_UNIT_SECONDS = {'SECOND': 1, 'MINUTE': 60, 'HOUR': 3600, 'DAY': 86400, 'WEEK': 604800}


def _date_add(value, amount, unit):
    dt = _parse_ts(value)
    if dt is None or amount is None:
        return None
    return (dt + timedelta(seconds=float(amount) * _UNIT_SECONDS[unit])).strftime(_TS_FMT)


def _hour(value):
    dt = _parse_ts(value)
    return dt.hour if dt else None


def _mod(a, b):
    if a is None or b is None or b == 0:
        return None
    return a % b if a >= 0 else -((-a) % b)  # MySQL: sign follows the dividend


def _field(value, *candidates):
    for i, candidate in enumerate(candidates, 1):
        if candidate == value:
            return i
    return 0


def _md5(value):
    if value is None:
        return None
    return hashlib.md5(str(value).encode('utf-8', 'replace')).hexdigest()


class _GroupConcatDistinctSorted:
    """GROUP_CONCAT(DISTINCT x ORDER BY x SEPARATOR sep)."""

    def __init__(self):
        self.values = set()
        self.sep = ','

    def step(self, value, sep):
        self.sep = sep
        if value is not None:
            self.values.add(str(value))

    def finalize(self):
        if not self.values:
            return None
        return self.sep.join(sorted(self.values, key=str.lower))


def _register_functions(conn):
    conn.create_function('NOW', 0, _now)
    conn.create_function('UNIX_TIMESTAMP', 0, _unix_timestamp)
    conn.create_function('UNIX_TIMESTAMP', 1, _unix_timestamp)
    conn.create_function('FROM_UNIXTIME', 1, _from_unixtime)
    conn.create_function('RAINY_DATE_ADD', 3, _date_add)
    conn.create_function('HOUR', 1, _hour, deterministic=True)
    conn.create_function('MOD', 2, _mod, deterministic=True)
    conn.create_function('FIELD', -1, _field, deterministic=True)
    conn.create_function('MD5', 1, _md5, deterministic=True)
    conn.create_aggregate('RAINY_GROUP_CONCAT_DS', 2, _GroupConcatDistinctSorted)


# ── Query translation ───────────────────────────────────────────────

_PLACEHOLDER = re.compile(r'%([%s])')
_UNIT = r'(SECOND|MINUTE|HOUR|DAY|WEEK)'
_DATE_ADD = re.compile(
    r'\b(DATE_ADD|DATE_SUB)\(\s*(.+?)\s*,\s*INTERVAL\s+(\S+?)\s+' + _UNIT + r'\s*\)', re.I)
_NOW_INTERVAL = re.compile(r'\bNOW\(\)\s*([-+])\s*INTERVAL\s+(\S+?)\s+' + _UNIT + r'\b', re.I)
_GROUP_CONCAT_DS = re.compile(
    r"\bGROUP_CONCAT\(\s*DISTINCT\s+(.+?)\s+ORDER\s+BY\s+.+?\s+SEPARATOR\s+('(?:[^']|'')*')\s*\)",
    re.I | re.S)
_GROUP_CONCAT_SEP = re.compile(r"\bGROUP_CONCAT\((.+?)\s+SEPARATOR\s+('(?:[^']|'')*')\s*\)", re.I | re.S)
_ON_DUP = re.compile(r'\bON\s+DUPLICATE\s+KEY\s+UPDATE\b', re.I)
_VALUES_COL = re.compile(r'\bVALUES\(\s*([A-Za-z_]\w*)\s*\)', re.I)


def _translate_dml(sql):
    sql = _PLACEHOLDER.sub(lambda m: '?' if m.group(1) == 's' else '%', sql)
    sql = re.sub(r'\bINSERT\s+IGNORE\b', 'INSERT OR IGNORE', sql, flags=re.I)
    sql = re.sub(r'\bCURRENT_TIMESTAMP\b', 'NOW()', sql, flags=re.I)
    sql = _DATE_ADD.sub(
        lambda m: f"RAINY_DATE_ADD({m.group(2)}, "
                  f"{'-' if m.group(1).upper() == 'DATE_SUB' else ''}({m.group(3)}), '{m.group(4).upper()}')",
        sql)
    sql = _NOW_INTERVAL.sub(
        lambda m: f"RAINY_DATE_ADD(NOW(), {'-' if m.group(1) == '-' else ''}({m.group(2)}), '{m.group(3).upper()}')",
        sql)
    sql = _GROUP_CONCAT_DS.sub(lambda m: f'RAINY_GROUP_CONCAT_DS({m.group(1)}, {m.group(2)})', sql)
    sql = _GROUP_CONCAT_SEP.sub(lambda m: f'GROUP_CONCAT({m.group(1)}, {m.group(2)})', sql)
    sql = re.sub(r'\bGREATEST\(', 'MAX(', sql, flags=re.I)
    sql = re.sub(r'\bLEAST\(', 'MIN(', sql, flags=re.I)
    sql = re.sub(r'\bRAND\(\)', 'RANDOM()', sql, flags=re.I)

    dup = _ON_DUP.search(sql)
    if dup:
        head, tail = sql[:dup.start()], sql[dup.end():]
        # SQLite needs WHERE after INSERT ... SELECT to parse an upsert.
        if re.search(r'\bSELECT\b', head, re.I) and not re.search(r'\bWHERE\b', head, re.I):
            head += ' WHERE true '
        sql = head + 'ON CONFLICT DO UPDATE SET' + _VALUES_COL.sub(r'excluded.\1', tail)
    return sql


def _split_top_level(body):
    """Split a CREATE TABLE body on commas that aren't inside parens/quotes."""
    parts, depth, quote, start = [], 0, None, 0
    for i, ch in enumerate(body):
        if quote:
            if ch == quote:
                quote = None
        elif ch in ("'", '"', '`'):
            quote = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == ',' and depth == 0:
            parts.append(body[start:i].strip())
            start = i + 1
    parts.append(body[start:].strip())
    return [p for p in parts if p]


_CREATE_TABLE = re.compile(
    r'^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.*)\)\s*;?\s*$', re.I | re.S)
_TEXT_TYPE = re.compile(r'^\w+\s+(VARCHAR|CHAR|TEXT|TINYTEXT)\b', re.I)


def _translate_create_table(sql):
    m = _CREATE_TABLE.match(sql)
    table = m.group(2)
    columns, statements = [], []
    for item in _split_top_level(m.group(3)):
        unique = re.match(r'^UNIQUE\s+(?:KEY|INDEX)\s+(\w+)\s*\((.+)\)$', item, re.I)
        if unique:
            columns.append(f'CONSTRAINT {unique.group(1)} UNIQUE ({unique.group(2)})')
            continue
        # SQLite has no inline indexes, and index names are database-wide.
        index = re.match(r'^(?:INDEX|KEY)\s+(\w+)\s*\((.+)\)$', item, re.I)
        if index:
            statements.append(
                f'CREATE INDEX IF NOT EXISTS {table}_{index.group(1)} ON {table} ({index.group(2)})')
            continue

        col = item
        col = re.sub(r'\b(?:BIG)?INT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b',
                     'INTEGER PRIMARY KEY AUTOINCREMENT', col, flags=re.I)
        col = re.sub(r'\bENUM\((?:[^()\']|\'[^\']*\')*\)', 'TEXT', col, flags=re.I)
        if re.search(r'\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b', col, re.I):
            col = re.sub(r'\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP\b', '', col, flags=re.I)
            name = col.split()[0]
            statements.append(
                f'CREATE TRIGGER IF NOT EXISTS {table}_{name}_touch AFTER UPDATE ON {table} '
                f'FOR EACH ROW WHEN NEW.{name} IS OLD.{name} BEGIN '
                f"UPDATE {table} SET {name} = datetime('now', 'localtime') WHERE rowid = NEW.rowid; END")
        col = re.sub(r'\bDEFAULT\s+CURRENT_TIMESTAMP\b',
                     "DEFAULT (datetime('now', 'localtime'))", col, flags=re.I)
        if _TEXT_TYPE.match(col):
            col = re.sub(r'^(\w+\s+\w+(?:\(\d+\))?)', r'\1 COLLATE NOCASE', col)
        columns.append(col)

    head = f"CREATE TABLE {m.group(1) or ''}{table} (\n    " + ',\n    '.join(columns) + '\n)'
    return [head] + statements


@lru_cache(maxsize=1024)
def translate(sql):
    """MySQL statement -> list of SQLite statements (usually one)."""
    if _CREATE_TABLE.match(sql):
        return tuple(_translate_create_table(sql))
    return (_translate_dml(sql),)


# ── mysql-connector-shaped wrappers ─────────────────────────────────

class SQLiteCursor:
    def __init__(self, conn, dictionary=False):
        self._cur = conn.cursor()
        self._dictionary = dictionary
        self._is_insert = False

    def execute(self, query, params=None):
        statements = translate(query)
        params = tuple(params) if params else ()
        for stmt in statements[:-1]:
            self._cur.execute(stmt)
        self._cur.execute(statements[-1], params)
        self._is_insert = statements[-1].lstrip()[:6].upper() == 'INSERT'
        return self

    def executemany(self, query, seq_of_params):
        (stmt,) = translate(query)
        self._cur.executemany(stmt, [tuple(p) for p in seq_of_params])
        self._is_insert = False
        return self

    def _row(self, row):
        if row is None:
            return None
        values = [_out(v) for v in row]
        if self._dictionary:
            return dict(zip((d[0] for d in self._cur.description), values))
        return tuple(values)

    def fetchone(self):
        return self._row(self._cur.fetchone())

    def fetchall(self):
        return [self._row(r) for r in self._cur.fetchall()]

    def fetchmany(self, size=1):
        return [self._row(r) for r in self._cur.fetchmany(size)]

    def __iter__(self):
        return iter(self.fetchall())

    @property
    def lastrowid(self):
        # sqlite3 keeps the previous insert's id after an UPDATE or an
        # ignored INSERT; mysql-connector reports 0 there.
        if self._is_insert and self._cur.rowcount > 0:
            return self._cur.lastrowid
        return 0

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def description(self):
        return self._cur.description

    def close(self):
        self._cur.close()


class SQLiteConnection:
    def __init__(self, path):
        self._conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self._conn.execute('PRAGMA foreign_keys = ON')
        self._conn.execute('PRAGMA busy_timeout = 30000')
        self._conn.execute('PRAGMA synchronous = NORMAL')
        _register_functions(self._conn)

    def cursor(self, dictionary=False, **_kwargs):
        return SQLiteCursor(self._conn, dictionary=dictionary)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()


def connect(path):
    return SQLiteConnection(path)


def prepare_database(path):
    """Create the parent directory and switch the file to WAL, which lets
    readers run alongside the single writer (workers + request threads +
    gunicorn processes all share the file)."""
    if sqlite3.sqlite_version_info < (3, 35, 0):
        raise RuntimeError(
            f'SQLite {sqlite3.sqlite_version} is too old for Rainy (needs 3.35+). '
            'Use a newer Python build or set up MySQL.')
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    try:
        conn.execute('PRAGMA journal_mode = WAL')
    finally:
        conn.close()


def column_exists(cursor, table, column):
    cursor.execute(f'PRAGMA table_info({table})')
    return any(row[1] == column for row in cursor.fetchall())


def index_exists(cursor, table, index):
    cursor.execute(f'PRAGMA index_list({table})')
    return any(row[1] in (index, f'{table}_{index}') for row in cursor.fetchall())

