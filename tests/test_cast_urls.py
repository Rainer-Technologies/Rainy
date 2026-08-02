"""Tests for the Chromecast media-URL endpoints (/api/music/cast-url[s]).

These endpoints mint absolute, token-authenticated stream URLs that a Cast
receiver fetches directly (it can't use the browser's session cookie).
"""


def _fake_song(song_id):
    return {"id": song_id, "cover_path": "covers/album.jpg"}


def test_cast_url_requires_auth(anon_client):
    r = anon_client.get("/api/music/cast-url/1")
    assert r.status_code in (401, 403, 302)


def test_cast_urls_batch_requires_auth(anon_client):
    r = anon_client.post("/api/music/cast-urls", json={"song_ids": [1]})
    assert r.status_code in (401, 403, 302)


def test_cast_url_not_found(client, monkeypatch):
    monkeypatch.setattr(
        "routes.music.SongModel.get_song_by_id",
        staticmethod(lambda song_id: None),
    )
    r = client.get("/api/music/cast-url/999")
    assert r.status_code == 404


def test_cast_url_builds_absolute_token_url(client, monkeypatch):
    monkeypatch.setattr(
        "routes.music.SongModel.get_song_by_id",
        staticmethod(lambda song_id: _fake_song(song_id)),
    )
    r = client.get("/api/music/cast-url/42")
    assert r.status_code == 200
    data = r.get_json()
    assert data["success"] is True
    # Absolute URL the Chromecast can reach on the LAN.
    assert data["url"].startswith("http")
    assert "/api/music/stream/42" in data["url"]
    # Token auth embedded so the receiver can fetch without our cookies.
    assert "session=" in data["url"]
    # Cover art URL for Cast metadata.
    assert "/api/music/cover/" in data["cover_url"]
    assert "session=" in data["cover_url"]


def test_cast_urls_batch_resolves_only_known_songs(client, monkeypatch):
    def lookup(song_id):
        return _fake_song(song_id) if song_id == 42 else None

    monkeypatch.setattr(
        "routes.music.SongModel.get_song_by_id",
        staticmethod(lookup),
    )
    r = client.post("/api/music/cast-urls", json={"song_ids": [42, 999, "bad"]})
    assert r.status_code == 200
    urls = r.get_json()["urls"]
    assert set(urls.keys()) == {"42"}
    assert "/api/music/stream/42" in urls["42"]["url"]
