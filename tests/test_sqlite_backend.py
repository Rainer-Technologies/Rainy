"""MySQL -> SQLite translation layer (no database server needed)."""
from datetime import datetime

import pytest

from models import sqlite_backend as sb


@pytest.fixture
def db(tmp_path):
    conn = sb.connect(str(tmp_path / 'rainy.db'))
    cur = conn.cursor(dictionary=True)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(50) NOT NULL,
            kind ENUM('a', 'b') NOT NULL DEFAULT 'a',
            hits INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_name (name),
            INDEX idx_kind (kind)
        )
    """)
    yield cur
    conn.close()


def test_upsert_and_insert_ignore(db):
    upsert = ("INSERT INTO items (name, hits) VALUES (%s, %s) "
              "ON DUPLICATE KEY UPDATE hits = GREATEST(hits, VALUES(hits))")
    db.execute(upsert, ('x', 5))
    db.execute(upsert, ('x', 3))
    db.execute("INSERT IGNORE INTO items (name) VALUES (%s)", ('x',))
    assert db.lastrowid == 0
    db.execute("SELECT name, hits, kind FROM items")
    assert db.fetchall() == [{'name': 'x', 'hits': 5, 'kind': 'a'}]


def test_timestamps_come_back_as_datetimes(db):
    db.execute("INSERT INTO items (name) VALUES (%s)", ('x',))
    db.execute("SELECT created_at, MAX(created_at) AS latest, "
               "DATE_SUB(NOW(), INTERVAL 1 DAY) AS yesterday FROM items")
    row = db.fetchone()
    assert isinstance(row['created_at'], datetime)
    assert isinstance(row['latest'], datetime)
    assert 86000 < (datetime.now() - row['yesterday']).total_seconds() < 86800


def test_on_update_current_timestamp(db):
    db.execute("INSERT INTO items (name, updated_at) VALUES (%s, %s)",
               ('x', datetime(2000, 1, 1)))
    db.execute("UPDATE items SET hits = 1 WHERE name = %s", ('x',))
    db.execute("SELECT updated_at FROM items")
    assert db.fetchone()['updated_at'].year > 2000


def test_mysql_functions(db):
    for name in ('b', 'a', 'c', 'a2'):
        db.execute("INSERT INTO items (name) VALUES (%s)", (name,))
    db.execute("SELECT GROUP_CONCAT(DISTINCT name ORDER BY name SEPARATOR ' | ') AS names, "
               "MOD(-7, 3) AS m, FIELD('c', 'a', 'b', 'c') AS f, "
               "UNIX_TIMESTAMP(FROM_UNIXTIME(1700000000)) AS ts FROM items")
    assert db.fetchone() == {'names': 'a | a2 | b | c', 'm': -1, 'f': 3, 'ts': 1700000000}


def test_text_is_case_insensitive_like_mysql(db):
    db.execute("INSERT INTO items (name) VALUES (%s)", ('Hello',))
    db.execute("SELECT COUNT(*) AS c FROM items WHERE name = %s", ('hello',))
    assert db.fetchone()['c'] == 1


def test_percent_escapes(db):
    assert sb.translate("SELECT 1 WHERE 'a' LIKE '%%a' AND 1 = %s") == (
        "SELECT 1 WHERE 'a' LIKE '%a' AND 1 = ?",)
