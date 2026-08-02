"""Tests for the Chromecast setup info API (/api/server/chromecast-info)."""


def test_chromecast_info_requires_auth(anon_client):
    r = anon_client.get("/api/server/chromecast-info")
    assert r.status_code in (401, 403, 302)


def test_chromecast_info(client):
    r = client.get("/api/server/chromecast-info")
    assert r.status_code == 200
    data = r.get_json()
    assert "origin_url" in data
    assert "chrome_flag_url" in data
    assert "edge_flag_url" in data
    assert data["origin_url"].startswith("http://")
