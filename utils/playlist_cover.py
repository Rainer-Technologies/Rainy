"""Auto-generate playlist cover art as a mosaic grid of song covers.

The generated image is a 2x2 grid (Spotify-style mosaic) built from up to four
of the playlist's song covers. It is written under ``<music_path>/covers/playlists/``
so it can be served by the existing ``/api/music/cover/<path>`` endpoint, and the
relative path is stored on the playlist row. Once generated it stays fixed until
explicitly regenerated.
"""
import os
import random
import time

from PIL import Image, ImageDraw


OUTPUT_SIZE = 640          # final square edge in px
GRID = 2                   # 2x2 mosaic
CELL = OUTPUT_SIZE // GRID


def _hex_to_rgb(hex_color, fallback=(120, 120, 130)):
    """Parse '#rrggbb' (or 'rrggbb') into an (r, g, b) tuple."""
    if not hex_color:
        return fallback
    c = hex_color.strip().lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    if len(c) != 6:
        return fallback
    try:
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return fallback


def _darken(rgb, factor=0.45):
    return tuple(max(0, int(v * factor)) for v in rgb)


def _gradient_tile(color_rgb):
    """Diagonal gradient tile used when a cell has no real cover."""
    tile = Image.new('RGB', (CELL, CELL))
    draw = ImageDraw.Draw(tile)
    top = color_rgb
    bottom = _darken(color_rgb)
    for y in range(CELL):
        t = y / max(1, CELL - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        draw.line([(0, y), (CELL, y)], fill=(r, g, b))
    return tile


def _load_square(full_path):
    """Open an image, center-crop to square, resize to a grid cell."""
    try:
        with Image.open(full_path) as img:
            img = img.convert('RGB')
            w, h = img.size
            side = min(w, h)
            left = (w - side) // 2
            top = (h - side) // 2
            img = img.crop((left, top, left + side, top + side))
            return img.resize((CELL, CELL), Image.Resampling.LANCZOS)
    except Exception:
        return None


def generate_playlist_cover(playlist_id, songs, music_path, icon_color='#888888'):
    """Build a mosaic cover for a playlist.

    Args:
        playlist_id: the playlist id (used in the output filename).
        songs: list of song dicts, each may carry a 'cover_path' relative to
            music_path.
        music_path: absolute path to the music library root.
        icon_color: playlist accent color, used for gradient fallback cells.

    Returns:
        The cover path relative to music_path (e.g. 'covers/playlists/...jpg'),
        or None if it could not be generated.
    """
    if not music_path:
        return None

    accent = _hex_to_rgb(icon_color)

    # Collect distinct, existing cover files from the playlist's songs.
    cover_paths = []
    seen = set()
    for song in (songs or []):
        cp = song.get('cover_path')
        if not cp or cp in seen:
            continue
        full = os.path.normpath(os.path.join(music_path, cp))
        if os.path.isfile(full):
            seen.add(cp)
            cover_paths.append(full)

    # Pick up to GRID*GRID distinct covers at random.
    random.shuffle(cover_paths)
    chosen = cover_paths[:GRID * GRID]

    # Build the four cells: real covers where available, gradient tiles to fill.
    cells = []
    for i in range(GRID * GRID):
        tile = None
        if i < len(chosen):
            tile = _load_square(chosen[i])
        if tile is None:
            # Cycle through any loaded covers, else fall back to a gradient.
            tile = _gradient_tile(accent)
        cells.append(tile)

    # Composite into the final square.
    canvas = Image.new('RGB', (OUTPUT_SIZE, OUTPUT_SIZE), _darken(accent))
    idx = 0
    for row in range(GRID):
        for col in range(GRID):
            canvas.paste(cells[idx], (col * CELL, row * CELL))
            idx += 1

    # Write under covers/playlists/ so the existing cover endpoint serves it.
    out_dir = os.path.join(music_path, 'covers', 'playlists')
    os.makedirs(out_dir, exist_ok=True)
    filename = f"playlist_{playlist_id}_{int(time.time())}.jpg"
    full_out = os.path.join(out_dir, filename)
    canvas.save(full_out, 'JPEG', quality=88, optimize=True)

    # Relative path (forward slashes) for storage + URL building.
    return f"covers/playlists/{filename}"


def generate_and_save_cover(playlist_id, songs, music_path, icon_color=None,
                            owner_user_id=None):
    """Generate a mosaic cover and persist it on the playlist row.

    Wrapper used at the end of playlist imports so the default behaviour is
    that a downloaded playlist ends up with a generated cover. Never raises:
    a cover failure must not fail the import it follows. Returns the stored
    cover path (relative to music_path) or None.

    ``songs`` (the download results) only carry a cover for freshly downloaded
    tracks, so the playlist's stored song rows are used first — they include
    already-present / deduped songs and scanner-extracted covers, exactly like
    the manual "regenerate cover" action. ``songs`` is kept as a fallback.
    """
    try:
        from models.playlist import PlaylistModel

        playlist = PlaylistModel.get_playlist_by_id(playlist_id)
        if icon_color is None:
            icon_color = (playlist or {}).get('icon_color', '#888888')

        db_songs = PlaylistModel.get_playlist_songs(playlist_id) or []
        if owner_user_id is not None and db_songs:
            from models.library_access import LibraryAccessModel
            db_songs = LibraryAccessModel.filter_visible(
                owner_user_id, db_songs, playlist_id=playlist_id)

        cover_path = generate_playlist_cover(
            playlist_id, list(db_songs) + list(songs or []), music_path,
            icon_color=icon_color)
        if cover_path:
            PlaylistModel.update_playlist_cover(playlist_id, cover_path)
        return cover_path
    except Exception as e:  # noqa: BLE001
        print(f"[playlist-cover] auto cover failed for playlist "
              f"{playlist_id}: {e}")
        return None
