"""Per-account library access model.

A song ROW is global (one file on disk = one row), but each user only
*sees* the songs they have a `library_access` row for:

- origin 'scan'   → came from a disk scan of the shared music folder;
                    granted to sysadmins only.
- origin 'import' → imported by that specific user; personal until a
                    sysadmin publishes it to everyone.
- origin 'public' → the song is published (`songs.published = 1`); every
                    account gets it, including ones created later.
- origin 'saved'  → added from a shared playlist the user is a member of.
                    It's someone else's song, so it isn't the user's
                    import (never counted or published as theirs).

Members of a shared playlist can also play its songs without any row
(see can_play); that access is temporary.
"""
from .database import Database

# A playlist `p` that is shared (has an accepted collaborator) and that the
# user (params: user_id, user_id) owns or has accepted an invite to.
_SHARED_PLAYLIST_MEMBER = """
    p.id IN (SELECT playlist_id FROM playlist_shares WHERE status = 'accepted')
    AND (p.owner_user_id = %s OR p.id IN (
        SELECT playlist_id FROM playlist_shares
        WHERE user_id = %s AND status = 'accepted'))
"""


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
    def song_is_communal(song_id):
        """True when the song is published or part of the scanned admin
        library, i.e. not one account's private import."""
        row = Database.execute_query(
            "SELECT 1 FROM songs s WHERE s.id = %s AND (s.published = 1 OR "
            "EXISTS (SELECT 1 FROM library_access la "
            "WHERE la.song_id = s.id AND la.origin = 'scan'))",
            (song_id,), fetch_one=True)
        return row is not None

    @staticmethod
    def exclusive_song_ids(user_id, song_ids):
        """The subset of song_ids that are the user's alone: in their
        library, not published, not scanned, and in no other account's
        library. Such songs only affect that user when merged or deleted."""
        if not song_ids:
            return set()
        fmt = ','.join(['%s'] * len(song_ids))
        rows = Database.execute_query(f"""
            SELECT s.id FROM songs s
            JOIN library_access mine ON mine.song_id = s.id AND mine.user_id = %s
            WHERE s.id IN ({fmt}) AND s.published = 0
            AND NOT EXISTS (
                SELECT 1 FROM library_access other
                WHERE other.song_id = s.id
                AND (other.user_id <> %s OR other.origin = 'scan'))
        """, (user_id, *song_ids, user_id), fetch_all=True) or []
        return {r['id'] for r in rows}

    @staticmethod
    def access_count_excluding(user_id, song_id):
        """How many OTHER accounts currently have access to the song."""
        row = Database.execute_query(
            "SELECT COUNT(*) AS c FROM library_access "
            "WHERE song_id = %s AND user_id <> %s", (song_id, user_id),
            fetch_one=True)
        return row['c'] if row else 0

    @staticmethod
    def has_access(user_id, song_id):
        # One round trip (it runs on every stream range request): an access
        # row, or the full-library permission for a song that exists.
        query = """
            SELECT 1 FROM users u
            WHERE u.id = %s AND (
                EXISTS (SELECT 1 FROM library_access la
                        WHERE la.user_id = u.id AND la.song_id = %s)
                OR (u.full_library = 1
                    AND EXISTS (SELECT 1 FROM songs s WHERE s.id = %s)))
        """
        return Database.execute_query(query, (user_id, song_id, song_id),
                                      fetch_one=True) is not None

    @staticmethod
    def can_play(user_id, song_id):
        """has_access, plus songs in a shared playlist the user is a member of.

        Shared-playlist access is temporary: it is checked live (no access
        rows), so it ends when the share is revoked, the user leaves, or the
        song is removed from the playlist, and the song never lands in the
        user's library. Use it for read-only surfaces (stream, lyrics, light
        show, download); anything that changes or re-shares a song still
        needs has_access. save_to_library turns it into a permanent row.
        """
        if LibraryAccessModel.has_access(user_id, song_id):
            return True
        query = f"""
            SELECT 1 FROM playlist_entries pe
            JOIN playlists p ON p.id = pe.playlist_id
            WHERE pe.track_id = %s AND {_SHARED_PLAYLIST_MEMBER}
            LIMIT 1
        """
        return Database.execute_query(query, (song_id, user_id, user_id),
                                      fetch_one=True) is not None

    @staticmethod
    def save_to_library(user_id, song_id):
        """Keep a song from a shared playlist in the user's library.
        Idempotent. Published songs keep the 'public' origin."""
        return Database.execute_query("""
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT %s, s.id, CASE WHEN s.published = 1 THEN 'public' ELSE 'saved' END
            FROM songs s WHERE s.id = %s
        """, (user_id, song_id))

    @staticmethod
    def shares_playlist(user_id, playlist_id):
        """Whether the playlist is shared and the user is one of its members,
        which makes all of its songs playable for them (see can_play)."""
        query = f"SELECT 1 FROM playlists p WHERE p.id = %s AND {_SHARED_PLAYLIST_MEMBER}"
        return Database.execute_query(query, (playlist_id, user_id, user_id),
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
    def filter_visible(user_id, songs, playlist_id=None):
        """Filter an in-memory list of song dicts to the user's visible ids.

        Songs carry their id under 'id' or 'song_id'. Used by routes that
        build song lists from raw SQL so every surface honours isolation.
        Pass playlist_id when the songs are that playlist's entries: members
        of a shared playlist see all of them (see can_play).
        """
        if not songs:
            return songs
        if playlist_id is not None and \
                LibraryAccessModel.shares_playlist(user_id, playlist_id):
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
    def backfill_user(user_id):
        """Give a user every song their role entitles them to. Idempotent.

        Everyone gets the published songs; sysadmins also get the scanned
        music-folder library. Runs when an account is created or promoted.
        Library loads re-run it for sysadmins only, so a regular user who
        removes a published song from their library doesn't get it back.
        """
        Database.execute_query("""
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT %s, s.id, 'public' FROM songs s WHERE s.published = 1
        """, (user_id,))
        row = Database.execute_query(
            "SELECT role FROM users WHERE id = %s", (user_id,), fetch_one=True)
        if not row or row.get('role') != 'sysadmin':
            return
        Database.execute_query("""
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT %s, s.id, 'scan' FROM songs s
            WHERE EXISTS (SELECT 1 FROM library_access la
                          WHERE la.song_id = s.id AND la.origin = 'scan')
        """, (user_id,))

    @staticmethod
    def revoke_scan_library(user_id):
        """Demotion: drop the scanned admin library from the user's view
        (their own imports and published songs stay)."""
        Database.execute_query(
            "DELETE FROM library_access WHERE user_id = %s AND origin = 'scan'",
            (user_id,))

    @staticmethod
    def _mark_published_rows():
        """Every access row of a published song is origin 'public'."""
        Database.execute_query("""
            UPDATE library_access SET origin = 'public'
            WHERE origin <> 'public'
            AND song_id IN (SELECT id FROM songs WHERE published = 1)
        """)

    @staticmethod
    def publish_to_all(song_id):
        """Sysadmin: publish a song to every account, current and future."""
        Database.execute_query(
            "UPDATE songs SET published = 1 WHERE id = %s", (song_id,))
        Database.execute_query("""
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT u.id, %s, 'public' FROM users u
        """, (song_id,))
        LibraryAccessModel._mark_published_rows()

    @staticmethod
    def publish_all_imported_by(owner_user_id):
        """Publish every personal import of one user (bulk variant)."""
        Database.execute_query("""
            UPDATE songs SET published = 1 WHERE id IN (
                SELECT song_id FROM library_access
                WHERE user_id = %s AND origin = 'import')
        """, (owner_user_id,))
        Database.execute_query("""
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT u.id, la.song_id, 'public'
            FROM users u
            JOIN library_access la
              ON la.user_id = %s AND la.origin = 'import'
        """, (owner_user_id,))
        LibraryAccessModel._mark_published_rows()

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

        ADMIN-ONLY by policy (Aug 2026): scans of the shared music folder are
        visible to administrators automatically; regular accounts get scanned
        songs only via an explicit 'Publish to Everyone'.
        """
        if not song_ids:
            return
        query = """
            INSERT IGNORE INTO library_access (user_id, song_id, origin)
            SELECT u.id, s.id, %s FROM users u, songs s
            WHERE s.id IN (%s) AND u.role = 'sysadmin'
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
