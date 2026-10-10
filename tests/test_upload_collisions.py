"""Upload name collisions and Chromecast host selection."""
import io
import os

import pytest

import routes.music as music_routes


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setattr("routes.music.SettingsModel.get_music_path",
                        staticmethod(lambda: str(tmp_path)))
    monkeypatch.setattr("routes.music.SongModel.get_song_by_path",
                        staticmethod(lambda rel: {"id": 5}))

    class FakeScanner:
        def __init__(self, path): pass
        def scan_single_file(self, path): return None

    monkeypatch.setattr(music_routes, "MusicScanner", FakeScanner)
    monkeypatch.setattr("models.library_access.LibraryAccessModel.on_scan_added",
                        staticmethod(lambda ids: None))
    return tmp_path


def _upload(client, data):
    return client.post("/api/music/upload", data={
        "files": (io.BytesIO(data), "song.mp3")}, content_type="multipart/form-data")


def test_identical_upload_is_not_stored_twice(client, library):
    (library / "song.mp3").write_bytes(b"same bytes")
    assert _upload(client, b"same bytes").get_json()["uploaded"] == 1
    assert sorted(os.listdir(library)) == ["song.mp3"]


def test_same_name_different_content_is_kept(client, library):
    (library / "song.mp3").write_bytes(b"original")
    assert _upload(client, b"different").get_json()["uploaded"] == 1
    assert sorted(os.listdir(library)) == ["song.mp3", "song_1.mp3"]
    assert (library / "song.mp3").read_bytes() == b"original"
    assert (library / "song_1.mp3").read_bytes() == b"different"


def test_cast_base_url_replaces_loopback_host(app, monkeypatch):
    class FakeSocket:
        def __init__(self, *a): pass
        def connect(self, addr): pass
        def getsockname(self): return ("192.168.1.20", 0)
        def close(self): pass

    monkeypatch.setattr("socket.socket", FakeSocket)
    with app.test_request_context("/", base_url="http://localhost:6969"):
        assert music_routes._cast_base_url().startswith("http://192.168.1.20:")
    with app.test_request_context("/", base_url="http://192.168.1.99:6969"):
        assert music_routes._cast_base_url().startswith("http://192.168.1.99:")
