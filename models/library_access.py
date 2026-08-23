"""Per-account library access model.

A song ROW is global (one file on disk = one row), but each user only
*sees* the songs they have a `library_access` row for:

- origin 'scan'   → came from a disk scan (sysadmin-managed, communal).
                    Treated as public: new users get them via backfill.
- origin 'import' → imported by that specific user; personal until a
                    sysadmin publishes it to everyone.
"""
from .database import Database


class LibraryAccessModel:
    @staticmethod
    def user_full_library(user_id):
        """Whether the user has the 'full system library' permission.

        Full-library users see every song on the server (including other
        accounts' personal imports). It is granted explicitly by an admin —
        never implied by role, and never on by default.
        """
        row = Database.execute_query(
            "SELECT full_library FROM users WHERE id = %s", (user_id,),
            fetch_one=True)
        return bool(row and row.get('full_library'))

    @staticmethod
    def access_join(user_id):
        """(sql_fragment, params) for JOIN-ing allowed song ids with the
        full-library bypass baked in.

        The fragment joins a subquery that yields ONE row per allowed song
        (never duplicates — an OR-condition join would multiply rows for
        full-library users). Usage: pass *params FIRST since the fragment's
        %s placeholders precede any later ones.
        """
        if LibraryAccessModel.user_full_library(user_id):
            fragment = ("JOIN (SELECT id AS song_id FROM songs) la "
                        "ON la.song_id = s.id")
            return fragment, ()
        fragment = ("JOIN (SELECT song_id FROM library_access "
                    "WHERE user_id = %s) la ON la.song_id = s.id")
        return fragment, (user_id,)

    @staticmethod
    def grant(user_id, song_id, origin='import'):
        """Grant one user access to one song. Idempotent."""
        query = """
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            VALUES (%s, %s, %s)
        """
        return Database.execute_query(query, (user_id, song_id, origin))

    @staticmethod
    def revoke(user_id, song_id):
        """Remove one user's access to one song (hide from their library)."""
        query = "DELETE FROM library_access WHERE user_id = %s AND song_id = %s"
        return Database.execute_query(query, (user_id, song_id))

    @staticmethod
    def has_access(user_id, song_id):
        if LibraryAccessModel.user_full_library(user_id):
            return True
        query = """
            SELECT 1 FROM library_access WHERE user_id = %s AND song_id = %s
        """
        return Database.execute_query(query, (user_id, song_id),
                                      fetch_one=True) is not None

    @staticmethod
    def visible_song_ids(user_id):
        """All song ids the user can see."""
        if LibraryAccessModel.user_full_library(user_id):
            rows = Database.execute_query(
                "SELECT id AS song_id FROM songs", fetch_all=True) or []
            return {r['song_id'] for r in rows}
        query = "SELECT song_id FROM library_access WHERE user_id = %s"
        rows = Database.execute_query(query, (user_id,), fetch_all=True) or []
        return {r['song_id'] for r in rows}

    @staticmethod
    def filter_visible(user_id, songs):
        """Filter an in-memory list of song dicts to the user's visible ids.

        Songs carry their id under 'id' or 'song_id'. Used by routes that
        build song lists from raw SQL so every surface honours isolation.
        """
        if not songs:
            return songs
        visible = LibraryAccessModel.visible_song_ids(user_id)
        key = 'id' if ('id' in songs[0]) else 'song_id'
        out = []
        for s in songs:
            sid = s.get(key)
            # Defensive: keep rows without an id rather than hiding them.
            out.append(s) if sid is None else (
                out.append(s) if sid in visible else None)
        return out

    @staticmethod
    def backfill_user(user_id, origin='scan'):
        """Give a user every 'public' song they don't have yet.

        Called on login and after scans. Only 'scan'-origin access rows are
        copied — personal imports of other users stay hidden.
        """
        query = """
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT %s, s.id, 'scan'
            FROM songs s
            JOIN library_access la ON la.song_id = s.id AND la.origin = 'scan'
        """
        return Database.execute_query(query, (user_id,))

    @staticmethod
    def publish_to_all(song_id):
        """Sysadmin: make a personally-imported song public.

        Grants every existing user access and flips ALL access rows for this
        song to origin='scan' so future users get it via backfill too.
        """
        q1 = """
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT u.id, %s, 'scan' FROM users u
        """
        q2 = "UPDATE library_access SET origin = 'scan' WHERE song_id = %s"
        Database.execute_query(q1, (song_id,))
        return Database.execute_query(q2, (song_id,))

    @staticmethod
    def publish_all_imported_by(owner_user_id):
        """Publish every personal import of one user (bulk variant)."""
        q1 = """
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT u.id, la.song_id, 'scan'
            FROM users u
            JOIN library_access la ON la.song_id IN (
                SELECT song_id FROM library_access
                WHERE user_id = %s AND origin = 'import'
            )
        """
        q2 = """
            UPDATE library_access SET origin = 'scan'
            WHERE user_id = %s AND origin = 'import'
        """
        Database.execute_query(q1, (owner_user_id,))
        return Database.execute_query(q2, (owner_user_id,))

    @staticmethod
    def import_stats():
        """Per-user counts of personal (unpublished) imports — admin panel."""
        query = """
            SELECT u.id AS user_id, u.username, COUNT(*) AS personal_songs
            FROM library_access la
            JOIN users u ON u.id = la.user_id
            WHERE la.origin = 'import'
            GROUP BY u.id, u.username
            ORDER BY personal_songs DESC
        """
        return Database.execute_query(query, fetch_all=True) or []

    @staticmethod
    def on_scan_added(song_ids, origin='scan'):
        """Grant access to newly scanned songs.

        Communal rule: scan-origin files go to EVERY user. (Scans run from
        the shared music folder, so what lands there belongs to everyone.)
        """
        if not song_ids:
            return
        query = """
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT u.id, s.id, %s FROM users u, songs s
            WHERE s.id IN (%s)
        """ % ('%s', ','.join(['%s'] * len(song_ids)))
        Database.execute_query(query, (origin, *song_ids))

    @staticmethod
    def on_scan_removed(paths):
        """Songs removed from disk: drop all access rows (cascades would do
        this via FK, but paths→ids deletion happens before we see it)."""
        if not paths:
            return
        query = "DELETE FROM library_access WHERE song_id IN (%s)" % \
            ','.join(['%s'] * len(paths))
        Database.execute_query(query, tuple(paths))

    @staticmethod
    def on_user_deleted(user_id):
        """Cleanup hook (FK CASCADE already handles it)."""
        Database.execute_query(
            "DELETE FROM library_access WHERE user_id = %s", (user_id,))
