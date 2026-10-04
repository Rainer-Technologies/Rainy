"""Duplicate song detection and smart merging.

Two songs are considered duplicates when their normalized title + artist match
(case-insensitive, punctuation/whitespace collapsed). Merging is careful about
user state: the "keeper" of a group is the copy that carries the most user
signal (likes, playlist memberships, ratings, play history). All references
(ratings, playlist entries, lyrics, lightshows, history, tags, features) are
re-pointed to the keeper before the redundant rows are deleted, so likes and
playlist placements are never lost.
"""

import re

from .database import Database


def _norm(s):
    """Normalize a string for duplicate comparison."""
    s = (s or '').lower()
    s = re.sub(r'[\(\[].*?[\)\]]', ' ', s)  # drop (feat. x), [remaster], etc.
    s = re.sub(r'[^a-z0-9]+', '', s)          # strip punctuation/whitespace
    return s


class DuplicateModel:
    @staticmethod
    def find_groups():
        """Return groups of duplicate songs.

        Each group: { key, songs: [ {id,title,artist,album,duration,cover_path,
        file_path, liked, disliked, playlist_count, play_count} ] }
        Only groups with 2+ songs are returned.
        """
        query = """
            SELECT s.id, s.title, s.artist, s.album, s.duration, s.cover_path,
                   s.file_path,
                   (SELECT COUNT(*) FROM song_ratings r
                      WHERE r.song_id = s.id AND r.rating = 'like') AS likes,
                   (SELECT COUNT(*) FROM song_ratings r
                      WHERE r.song_id = s.id AND r.rating = 'dislike') AS dislikes,
                   (SELECT COUNT(*) FROM playlist_entries pe
                      WHERE pe.track_id = s.id) AS playlist_count,
                   (SELECT COUNT(*) FROM play_history ph
                      WHERE ph.song_id = s.id AND ph.counted = 1) AS play_count
            FROM songs s
        """
        rows = Database.execute_query(query, fetch_all=True) or []

        groups = {}
        for row in rows:
            key = _norm(row.get('title')) + '||' + _norm(row.get('artist'))
            if not key.strip('|'):
                continue
            groups.setdefault(key, []).append(row)

        result = []
        for key, songs in groups.items():
            if len(songs) < 2:
                continue
            # Sort so the best keeper candidate is first.
            songs.sort(key=_keeper_score, reverse=True)
            result.append({'key': key, 'songs': songs})

        result.sort(key=lambda g: len(g['songs']), reverse=True)
        return result

    @staticmethod
    def merge_group(song_ids, keeper_id=None):
        """Merge a group of duplicate songs into a single keeper.

        If keeper_id is not supplied, the best candidate (most user signal) is
        chosen automatically. Returns a summary dict.
        """
        if not song_ids or len(song_ids) < 2:
            return {'success': False, 'error': 'Need at least two songs to merge'}

        ids = list(dict.fromkeys(int(i) for i in song_ids))  # dedupe, preserve order

        # Load the candidate rows to pick a keeper if needed.
        fmt = ','.join(['%s'] * len(ids))
        rows = Database.execute_query(
            f"""
            SELECT s.id,
                   (SELECT COUNT(*) FROM song_ratings r
                      WHERE r.song_id = s.id AND r.rating = 'like') AS likes,
                   (SELECT COUNT(*) FROM song_ratings r
                      WHERE r.song_id = s.id AND r.rating = 'dislike') AS dislikes,
                   (SELECT COUNT(*) FROM playlist_entries pe
                      WHERE pe.track_id = s.id) AS playlist_count,
                   (SELECT COUNT(*) FROM play_history ph
                      WHERE ph.song_id = s.id AND ph.counted = 1) AS play_count
            FROM songs s WHERE s.id IN ({fmt})
            """,
            tuple(ids),
            fetch_all=True,
        ) or []

        if keeper_id:
            keeper_id = int(keeper_id)
            if keeper_id not in ids:
                return {'success': False, 'error': 'Chosen keeper is not in the group'}
        else:
            rows.sort(key=_keeper_score, reverse=True)
            keeper_id = rows[0]['id']

        losers = [i for i in ids if i != keeper_id]
        if not losers:
            return {'success': False, 'error': 'Nothing to merge'}

        conn = Database.get_connection()
        try:
            cursor = conn.cursor()

            # 1) Ratings: move loser ratings to the keeper, skipping any that
            #    would violate the unique (user_id, song_id) constraint.
            for loser in losers:
                cursor.execute(
                    """
                    UPDATE song_ratings
                    SET song_id = %s
                    WHERE song_id = %s
                      AND user_id NOT IN (
                          SELECT user_id FROM (SELECT user_id FROM song_ratings
                                               WHERE song_id = %s) k
                      )
                    """,
                    (keeper_id, loser, keeper_id),
                )
                # Any leftover loser ratings (user already rated the keeper) are
                # dropped with the loser row below.

            # 1b) Library access: every account that could see a removed copy
            #     keeps the song through the keeper (same skip-if-present
            #     pattern). A published copy keeps the keeper published.
            for loser in losers:
                cursor.execute(
                    """
                    UPDATE library_access
                    SET song_id = %s
                    WHERE song_id = %s
                      AND user_id NOT IN (
                          SELECT user_id FROM (SELECT user_id FROM library_access
                                               WHERE song_id = %s) k
                      )
                    """,
                    (keeper_id, loser, keeper_id),
                )
            lfmt = ','.join(['%s'] * len(losers))
            cursor.execute(
                f"SELECT 1 FROM songs WHERE id IN ({lfmt}) AND published = 1",
                tuple(losers))
            if cursor.fetchone():
                cursor.execute(
                    "UPDATE songs SET published = 1 WHERE id = %s", (keeper_id,))
                cursor.execute(
                    "UPDATE library_access SET origin = 'public' WHERE song_id = %s",
                    (keeper_id,))

            # 2) Playlist entries: re-point to keeper, then dedupe within each
            #    playlist so a song never appears twice.
            for loser in losers:
                cursor.execute(
                    "UPDATE playlist_entries SET track_id = %s WHERE track_id = %s",
                    (keeper_id, loser),
                )
            cursor.execute(
                """
                DELETE FROM playlist_entries
                WHERE track_id = %s
                  AND id NOT IN (
                      SELECT keep_id FROM (
                          SELECT MIN(id) AS keep_id FROM playlist_entries
                          WHERE track_id = %s GROUP BY playlist_id
                      ) k
                  )
                """,
                (keeper_id, keeper_id),
            )

            # 3) One-to-one child tables keyed by song_id (PK). Move the loser's
            #    row to the keeper only if the keeper doesn't already have one.
            for table in ('song_lyrics', 'song_lyrics_words', 'song_lightshows',
                          'song_features'):
                for loser in losers:
                    cursor.execute(
                        f"SELECT 1 FROM {table} WHERE song_id = %s", (keeper_id,)
                    )
                    if cursor.fetchone():
                        cursor.execute(
                            f"DELETE FROM {table} WHERE song_id = %s", (loser,)
                        )
                    else:
                        cursor.execute(
                            f"UPDATE {table} SET song_id = %s WHERE song_id = %s",
                            (keeper_id, loser),
                        )

            # 4) History / tags: re-point (duplicates here are harmless).
            for loser in losers:
                cursor.execute(
                    "UPDATE play_history SET song_id = %s WHERE song_id = %s",
                    (keeper_id, loser),
                )
                cursor.execute(
                    "UPDATE song_tags SET song_id = %s WHERE song_id = %s",
                    (keeper_id, loser),
                )
            # Dedupe tags that now collide on (song_id, tag_name, source).
            cursor.execute(
                """
                DELETE FROM song_tags
                WHERE song_id = %s
                  AND id NOT IN (
                      SELECT keep_id FROM (
                          SELECT MIN(id) AS keep_id FROM song_tags
                          WHERE song_id = %s GROUP BY tag_name, source
                      ) k
                  )
                """,
                (keeper_id, keeper_id),
            )

            # 5) playback_state references the song with ON DELETE SET NULL, so
            #    deleting the loser rows is safe.

            # 6) Delete the loser song rows (cascades remaining FKs).
            # Remember the losers' files: the caller deletes them from disk
            # once the merge is committed (otherwise the next scan would add
            # them right back as new songs).
            cursor.execute(
                f"SELECT file_path, cover_path FROM songs WHERE id IN ({lfmt})",
                tuple(losers))
            removed_files = [{'file_path': r[0], 'cover_path': r[1]}
                             for r in cursor.fetchall()]
            cursor.execute(f"DELETE FROM songs WHERE id IN ({lfmt})", tuple(losers))

            conn.commit()
            cursor.close()
            return {
                'success': True,
                'keeper_id': keeper_id,
                'removed': losers,
                'removed_count': len(losers),
                'removed_files': removed_files,
            }
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.close()


def _keeper_score(row):
    """Higher = better keeper. Likes weigh most, then playlists, then plays."""
    return (
        (row.get('likes') or 0) * 100
        - (row.get('dislikes') or 0) * 50
        + (row.get('playlist_count') or 0) * 10
        + (row.get('play_count') or 0)
    )
