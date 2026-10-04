"""YouTube downloads must not get the video's category as their genre."""

from unittest import mock

import yt_dlp
from yt_dlp.postprocessor import FFmpegMetadataPP

from models.song_metadata import clean_genre
from utils.youtube import YouTubeDownloader


def test_download_does_not_tag_youtube_category_as_genre(tmp_path):
    # With no `genre`, yt-dlp's FFmpegMetadata falls back to `categories`
    # then `tags`. The downloader must blank it before metadata is written.
    seen = {}

    def fake_download(ydl, urls):
        info = ydl.run_all_pps('pre_process', {
            'id': 'x', 'title': 't',
            'categories': ['People & Blogs'], 'tags': ['lofi'],
        })
        seen['args'] = [
            arg for arg in FFmpegMetadataPP(ydl)._get_metadata_opts(info)
            if 'genre' in str(arg)
        ]

    with mock.patch.object(yt_dlp.YoutubeDL, 'download', fake_download):
        YouTubeDownloader(str(tmp_path))._do_download({'quiet': True}, ['u'])

    assert seen['args'] == []


def test_clean_genre_drops_placeholders():
    assert clean_genre('People & Blogs') is None
    assert clean_genre(' education ') is None
    assert clean_genre('MUSIC') is None
    assert clean_genre('') is None
    assert clean_genre(None) is None
    assert clean_genre(' Rock ') == 'Rock'
    assert clean_genre('Comedy') == 'Comedy'
