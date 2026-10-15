"""Data access for installed packages (light show environments, UI themes).

Each kind has its own table with the same columns; a subclass names it in
TABLE. The zip itself is kept in the row, so an install survives wherever the
server's files do not (a rebuilt container). Listings never carry it.
"""
import json

from .database import Database

_COLUMNS = 'id, name, version, manifest, enabled, sha256, size, installed_by, installed_at, updated_at'


def _row(row):
    if not row:
        return None
    row = dict(row)
    try:
        row['manifest'] = json.loads(row['manifest'])
    except (TypeError, ValueError):
        row['manifest'] = {}
    row['enabled'] = bool(row['enabled'])
    return row


class PackageStore:
    """CRUD for one kind's table of installed packages."""

    TABLE = None

    @classmethod
    def list_all(cls, include_disabled=False):
        where = '' if include_disabled else 'WHERE enabled = 1'
        rows = Database.execute_query(
            f"SELECT {_COLUMNS} FROM {cls.TABLE} {where} ORDER BY name, id", fetch_all=True)
        return [_row(r) for r in rows or []]

    @classmethod
    def get(cls, pkg_id):
        return _row(Database.execute_query(
            f"SELECT {_COLUMNS} FROM {cls.TABLE} WHERE id = %s", (pkg_id,), fetch_one=True))

    @classmethod
    def get_package(cls, pkg_id):
        """The installed zip's bytes, or None."""
        row = Database.execute_query(
            f"SELECT package FROM {cls.TABLE} WHERE id = %s", (pkg_id,), fetch_one=True)
        return bytes(row['package']) if row and row['package'] is not None else None

    @classmethod
    def save(cls, manifest, package, sha256, user_id=None):
        """Install a package, or replace the installed one with the same id (it stays enabled or disabled as it was)."""
        Database.execute_query(
            f"""
            INSERT INTO {cls.TABLE} (id, name, version, manifest, sha256, size, package, installed_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                name = VALUES(name), version = VALUES(version), manifest = VALUES(manifest),
                sha256 = VALUES(sha256), size = VALUES(size), package = VALUES(package),
                installed_by = VALUES(installed_by), updated_at = CURRENT_TIMESTAMP
            """,
            (manifest['id'], manifest['name'], manifest['version'], json.dumps(manifest),
             sha256, len(package), package, user_id))
        return cls.get(manifest['id'])

    @classmethod
    def set_enabled(cls, pkg_id, enabled):
        Database.execute_query(
            f"UPDATE {cls.TABLE} SET enabled = %s WHERE id = %s", (1 if enabled else 0, pkg_id))

    @classmethod
    def delete(cls, pkg_id):
        Database.execute_query(f"DELETE FROM {cls.TABLE} WHERE id = %s", (pkg_id,))
