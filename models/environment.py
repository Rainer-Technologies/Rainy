"""Data access for installed light show environment packages."""
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


class EnvironmentModel:
    """CRUD for `lightshow_environments`. Listings never carry the package itself."""

    @staticmethod
    def list_all(include_disabled=False):
        where = '' if include_disabled else 'WHERE enabled = 1'
        rows = Database.execute_query(
            f"SELECT {_COLUMNS} FROM lightshow_environments {where} ORDER BY name, id", fetch_all=True)
        return [_row(r) for r in rows or []]

    @staticmethod
    def get(env_id):
        return _row(Database.execute_query(
            f"SELECT {_COLUMNS} FROM lightshow_environments WHERE id = %s", (env_id,), fetch_one=True))

    @staticmethod
    def get_package(env_id):
        """The installed zip's bytes, or None."""
        row = Database.execute_query(
            "SELECT package FROM lightshow_environments WHERE id = %s", (env_id,), fetch_one=True)
        return bytes(row['package']) if row and row['package'] is not None else None

    @staticmethod
    def save(manifest, package, sha256, user_id=None):
        """Install a package, or replace the installed one with the same id (it stays enabled or disabled as it was)."""
        Database.execute_query(
            """
            INSERT INTO lightshow_environments (id, name, version, manifest, sha256, size, package, installed_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                name = VALUES(name), version = VALUES(version), manifest = VALUES(manifest),
                sha256 = VALUES(sha256), size = VALUES(size), package = VALUES(package),
                installed_by = VALUES(installed_by), updated_at = CURRENT_TIMESTAMP
            """,
            (manifest['id'], manifest['name'], manifest['version'], json.dumps(manifest),
             sha256, len(package), package, user_id))
        return EnvironmentModel.get(manifest['id'])

    @staticmethod
    def set_enabled(env_id, enabled):
        Database.execute_query(
            "UPDATE lightshow_environments SET enabled = %s WHERE id = %s", (1 if enabled else 0, env_id))

    @staticmethod
    def delete(env_id):
        Database.execute_query("DELETE FROM lightshow_environments WHERE id = %s", (env_id,))
