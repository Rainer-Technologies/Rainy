"""Data-access layer for song enrichment metadata.

Covers the three enrichment tables (`song_features`, `song_tags`,
`artist_relations`) plus the `musicbrainz_id` column on `songs`. All of this
data is source-agnostic: audio features come from local librosa analysis,
tags and artist relations come from the free Last.fm / MusicBrainz APIs,
keyed on artist + title so they work for any audio file.
"""
import json

from models.database import Database


class SongFeaturesModel:
    """CRUD for the `song_features` table (librosa audio analysis)."""

    # Columns that hold numeric descriptors (everything except ids/timestamps
    # and the JSON mfccs blob). Used by upsert and the serializer.
    NUMERIC_COLUMNS = (
        'tempo_bpm', 'tempo_confidence', 'key_name', 'scale_type',
        'key_strength', 'danceability', 'loudness_db', 'energy',
        'spectral_centroid', 'spectral_rolloff', 'spectral_complexity',
        'zero_crossing_rate',
    )

    @staticmethod
    def upsert(song_id, features):
        """Insert or replace the feature row for a song.

        `features` is a dict whose keys match NUMERIC_COLUMNS plus an optional
        `mfccs` list. Missing keys are stored as NULL.
        """
        cols = ['song_id'] + list(SongFeaturesModel.NUMERIC_COLUMNS) + ['mfccs']
        values = [song_id]
        for col in SongFeaturesModel.NUMERIC_COLUMNS:
            values.append(features.get(col))
        mfccs = features.get('mfccs')
        values.append(json.dumps(mfccs) if mfccs is not None else None)

        placeholders = ', '.join(['%s'] * len(cols))
        updates = ', '.join(f'{c} = VALUES({c})' for c in cols[1:])
        query = f"""
            INSERT INTO song_features ({', '.join(cols)})
            VALUES ({placeholders})
            ON DUPLICATE KEY UPDATE {updates}
        """
        Database.execute_query(query, tuple(values))

    @staticmethod
    def get(song_id):
        """Fetch the feature row for a song (dict) or None."""
        query = "SELECT * FROM song_features WHERE song_id = %s"
        return Database.execute_query(query, (song_id,), fetch_one=True)

    @staticmethod
    def serialize(row):
        """Convert a DB row into a JSON-safe dict for the frontend."""
        if not row:
            return None
        mfccs = row.get('mfccs')
        if isinstance(mfccs, str) and mfccs:
            try:
                mfccs = json.loads(mfccs)
            except (ValueError, TypeError):
                mfccs = None
        out = dict(row)
        out['mfccs'] = mfccs
        analyzed = out.get('analyzed_at')
        out['analyzed_at'] = analyzed.isoformat() if analyzed else None
        return out


class SongTagsModel:
    """CRUD for the `song_tags` table (crowd-sourced labels)."""

    @staticmethod
    def replace_for_song(song_id, tags, source):
        """Replace all tags for a song from a given source.

        `tags` is a list of (tag_name, weight) tuples. Old tags from the same
        source are dropped first so re-enrichment stays fresh.
        """
        Database.execute_query(
            "DELETE FROM song_tags WHERE song_id = %s AND source = %s",
            (song_id, source),
        )
        for tag_name, weight in tags:
            Database.execute_query(
                """
                INSERT INTO song_tags (song_id, tag_name, weight, source)
                VALUES (%s, %s, %s, %s)
                """,
                (song_id, tag_name[:100], int(weight), source),
            )

    @staticmethod
    def get(song_id):
        """Fetch all tags for a song, strongest first."""
        query = """
            SELECT tag_name, weight, source FROM song_tags
            WHERE song_id = %s
            ORDER BY weight DESC, tag_name ASC
        """
        return Database.execute_query(query, (song_id,), fetch_all=True)


class ArtistRelationsModel:
    """CRUD for the `artist_relations` table (similar-artist graph)."""

    @staticmethod
    def has(artist_name):
        """True if we already cached relations for this artist."""
        query = "SELECT id FROM artist_relations WHERE artist_name = %s LIMIT 1"
        return Database.execute_query(query, (artist_name,), fetch_one=True) is not None

    @staticmethod
    def replace_for_artist(artist_name, relations):
        """Replace cached relations for an artist.

        `relations` is a list of (related_artist, similarity) tuples.
        """
        Database.execute_query(
            "DELETE FROM artist_relations WHERE artist_name = %s",
            (artist_name,),
        )
        for related, similarity in relations:
            Database.execute_query(
                """
                INSERT INTO artist_relations (artist_name, related_artist, similarity)
                VALUES (%s, %s, %s)
                """,
                (artist_name, related[:255], float(similarity)),
            )

    @staticmethod
    def get(artist_name):
        """Fetch similar artists for an artist, most similar first."""
        query = """
            SELECT related_artist, similarity FROM artist_relations
            WHERE artist_name = %s
            ORDER BY similarity DESC
        """
        return Database.execute_query(query, (artist_name,), fetch_all=True)


class SongMetadataModel:
    """Aggregate accessor: everything we know about one song's enrichment."""

    @staticmethod
    def set_musicbrainz_id(song_id, mbid):
        Database.execute_query(
            "UPDATE songs SET musicbrainz_id = %s WHERE id = %s",
            (mbid, song_id),
        )

    @staticmethod
    def mark_enriched(song_id):
        """Stamp the song as having gone through enrichment."""
        Database.execute_query(
            "UPDATE songs SET enriched_at = NOW() WHERE id = %s",
            (song_id,),
        )

    @staticmethod
    def set_genre_if_missing(song_id, genre):
        """Fill in the genre only if the song doesn't already have one.

        Never overwrites a genre that came from the file's own tags.
        """
        if not genre:
            return
        Database.execute_query(
            """
            UPDATE songs SET genre = %s
            WHERE id = %s AND (genre IS NULL OR genre = '')
            """,
            (genre, song_id),
        )

    @staticmethod
    def get_full(song_id):
        """Return features + tags + artist relations for a song.

        The artist used for relations is the song's primary (first-listed)
        artist, matching how enrichment queries Last.fm.
        """
        song = Database.execute_query(
            "SELECT id, title, artist, genre, musicbrainz_id FROM songs WHERE id = %s",
            (song_id,), fetch_one=True,
        )
        if not song:
            return None

        features = SongFeaturesModel.serialize(SongFeaturesModel.get(song_id))
        tags = SongTagsModel.get(song_id)

        primary_artist = (song.get('artist') or '').split(',')[0].strip()
        relations = ArtistRelationsModel.get(primary_artist) if primary_artist else []

        return {
            'song_id': song_id,
            'title': song.get('title'),
            'artist': song.get('artist'),
            'primary_artist': primary_artist,
            'musicbrainz_id': song.get('musicbrainz_id'),
            'features': features,
            'tags': tags,
            'similar_artists': relations,
        }
