"""New songs (imports, downloads, uploads, playlist syncs) get lyrics queued automatically."""
from models.enrichment_job import EnrichmentJobModel
from models.song import SongModel
from utils import enrichment_worker, lightshow_worker, lyrics_worker
from utils.scanner import MusicScanner


def test_scan_single_file_queues_lyrics_and_light_show(tmp_path, monkeypatch):
    audio = tmp_path / 'artist - title.mp3'
    audio.write_bytes(b'x')

    queued = {'lyrics': [], 'lightshow': []}
    scanner = MusicScanner(str(tmp_path))
    monkeypatch.setattr(scanner, '_extract_metadata', lambda path, name: {'title': 'title', 'artist': 'artist'})
    monkeypatch.setattr(SongModel, 'add_song', staticmethod(lambda meta: 42))
    monkeypatch.setattr(EnrichmentJobModel, 'enqueue_song', staticmethod(lambda sid, force=False: 1))
    monkeypatch.setattr(enrichment_worker, 'notify', lambda: None)
    monkeypatch.setattr(lightshow_worker, 'enqueue_song', lambda sid, force=False: queued['lightshow'].append(sid))
    monkeypatch.setattr(lyrics_worker, 'enqueue_song', lambda sid, force=False: queued['lyrics'].append(sid))

    meta = scanner.scan_single_file(str(audio))

    assert meta['id'] == 42
    assert queued == {'lyrics': [42], 'lightshow': [42]}
