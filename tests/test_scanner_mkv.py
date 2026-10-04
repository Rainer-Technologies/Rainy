"""Matroska (.mkv) files: tags, duration and cover art come from ffprobe/ffmpeg."""
import shutil
import subprocess

import pytest

from utils.scanner import MusicScanner

pytestmark = pytest.mark.skipif(
    not (shutil.which('ffmpeg') and shutil.which('ffprobe')),
    reason='ffmpeg/ffprobe not installed')


def _ffmpeg(*args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True)


@pytest.fixture
def mkv(tmp_path):
    cover = tmp_path / 'cover.png'
    _ffmpeg('-f', 'lavfi', '-i', 'color=red:s=16x16:d=1', '-frames:v', '1', str(cover))
    song = tmp_path / 'song.mkv'
    _ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'flac',
            '-metadata', 'title=My Song', '-metadata', 'artist=Some Artist',
            '-metadata', 'album=An Album', '-metadata', 'genre=Rock',
            '-metadata', 'DATE_RELEASED=2021', '-metadata', 'PART_NUMBER=4',
            '-attach', str(cover), '-metadata:s:t', 'mimetype=image/png',
            '-metadata:s:t', 'filename=cover.png', str(song))
    return song, cover


def test_mkv_is_scanned(tmp_path, mkv):
    songs = MusicScanner(str(tmp_path)).scan()
    assert [s['path'] for s in songs] == ['song.mkv']


def test_mkv_metadata_and_cover(tmp_path, mkv):
    song, cover = mkv
    meta = MusicScanner(str(tmp_path))._extract_metadata(str(song), song.name)

    assert meta['title'] == 'My Song'
    assert meta['artist'] == 'Some Artist'
    assert meta['album'] == 'An Album'
    assert meta['genre'] == 'Rock'
    assert meta['year'] == '2021'
    assert meta['track'] == 4
    assert meta['duration'] == 3
    assert meta['cover_path'].startswith('covers/') and meta['cover_path'].endswith('.png')
    assert (tmp_path / meta['cover_path']).read_bytes() == cover.read_bytes()


def test_untagged_mkv_falls_back_to_filename(tmp_path):
    song = tmp_path / 'Bare Track.mkv'
    _ffmpeg('-f', 'lavfi', '-i', 'sine=duration=2', '-c:a', 'flac', str(song))
    meta = MusicScanner(str(tmp_path))._extract_metadata(str(song), song.name)

    assert meta['title'] == 'Bare Track'
    assert meta['artist'] == 'Unknown Artist'
    assert meta['duration'] == 2
    assert 'cover_path' not in meta
