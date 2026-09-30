"""One-off library-wide genre classification pass (Discogs-EffNet, local).

Classifies every song's audio and writes:
  - songs.genre        -> top-level genre (replacing junk ID3 placeholders)
  - song_tags          -> top-3 Discogs labels, source='discogs-effnet'

Database credentials come from .env via config.py, like the app itself.

Usage:
    .venv/bin/python scripts/classify_genres.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.database import Database  # noqa: E402
from models.settings import SettingsModel  # noqa: E402
from models.song_metadata import SongMetadataModel, SongTagsModel  # noqa: E402
from utils.genre_classifier import classify_file, top_level_genre  # noqa: E402

music = SettingsModel.get_music_path()
if not music:
    sys.exit("No music library path configured; complete the initial setup first.")

songs = Database.execute_query(
    "SELECT id, title, artist, file_path FROM songs ORDER BY id ASC",
    fetch_all=True,
) or []
total = len(songs)
done = ok = failed = skipped = 0
t0 = time.time()

for song in songs:
    full = os.path.join(music, song['file_path'])
    label = f"[{done+1}/{total}] {song['title']}"
    if not os.path.isfile(full):
        print(f"{label}: FILE MISSING, skipped")
        skipped += 1
        done += 1
        continue
    results = classify_file(full)
    if not results:
        print(f"{label}: no result, skipped")
        skipped += 1
        done += 1
        continue
    genre = top_level_genre(results)
    SongMetadataModel.set_genre_if_placeholder(song['id'], genre)
    SongTagsModel.replace_for_song(song['id'], results, source='discogs-effnet')
    ok += 1
    print(f"{label}: {genre} <- {results[0][0]} ({results[0][1]}%)")
    done += 1

elapsed = time.time() - t0
print(f"\nDONE: {ok} classified, {skipped} skipped, {failed} failed "
      f"in {elapsed:.0f}s ({elapsed/max(total,1):.1f}s/song)")
