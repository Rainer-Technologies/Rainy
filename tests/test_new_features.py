"""Tests for all newly added Rainy features.

Covers: playback history, cross-device sync state, albums, smart mix,
and playlist drag-and-drop reordering.
"""


# ---------------------------------------------------------------------------
# Playback History
# ---------------------------------------------------------------------------

def test_record_and_get_history(client):
    r = client.post("/api/playback/history",
                    json={"song_id": 1, "position": 0, "duration": 200})
    assert r.status_code == 200
    assert r.get_json()["success"] is True

    r = client.get("/api/playback/history")
    assert r.status_code == 200
    songs = r.get_json()["songs"]
    assert isinstance(songs, list)
    assert any(s["id"] == 1 for s in songs)


def test_history_requires_song_id(client):
    r = client.post("/api/playback/history", json={"position": 0})
    assert r.status_code in (400, 500)


def test_history_stats(client):
    client.post("/api/playback/history",
                json={"song_id": 1, "position": 0, "duration": 200})
    r = client.get("/api/playback/stats")
    assert r.status_code == 200
    stats = r.get_json()["stats"]
    assert "total_plays" in stats
    assert "unique_songs" in stats
    assert int(stats["total_plays"]) >= 1


def test_top_artists(client):
    client.post("/api/playback/history",
                json={"song_id": 1, "position": 0, "duration": 200})
    r = client.get("/api/playback/history/artists")
    assert r.status_code == 200
    artists = r.get_json()["artists"]
    assert isinstance(artists, list)


def test_clear_history(client):
    client.post("/api/playback/history",
                json={"song_id": 1, "position": 0, "duration": 200})
    r = client.delete("/api/playback/history")
    assert r.status_code == 200
    r = client.get("/api/playback/history")
    assert r.get_json()["songs"] == []


def test_history_requires_auth(anon_client):
    r = anon_client.get("/api/playback/history")
    assert r.status_code in (401, 403, 302)


# ---------------------------------------------------------------------------
# Cross-Device Playback State
# ---------------------------------------------------------------------------

def test_save_and_get_state(client):
    payload = {
        "song_id": 1,
        "position": 42.5,
        "queue": [1, 2, 3],
        "queue_index": 0,
        "is_playing": True,
    }
    r = client.post("/api/playback/state", json=payload)
    assert r.status_code == 200
    assert r.get_json()["success"] is True

    r = client.get("/api/playback/state")
    assert r.status_code == 200
    state = r.get_json()["state"]
    assert state["song_id"] == 1
    assert state["position"] == 42.5
    assert state["queue"] == [1, 2, 3]
    assert state["is_playing"] is True
    # Full song metadata should be embedded
    assert "song" in state
    assert state["song"]["id"] == 1


def test_state_overwrites(client):
    client.post("/api/playback/state",
                json={"song_id": 1, "position": 10, "queue": [1], "queue_index": 0, "is_playing": True})
    client.post("/api/playback/state",
                json={"song_id": 2, "position": 99, "queue": [2], "queue_index": 0, "is_playing": False})
    r = client.get("/api/playback/state")
    state = r.get_json()["state"]
    assert state["song_id"] == 2
    assert state["position"] == 99
    assert state["is_playing"] is False


def test_state_requires_auth(anon_client):
    r = anon_client.post("/api/playback/state", json={"song_id": 1})
    assert r.status_code in (401, 403, 302)


# ---------------------------------------------------------------------------
# Albums
# ---------------------------------------------------------------------------

def test_list_albums(client):
    r = client.get("/api/albums/")
    assert r.status_code == 200
    albums = r.get_json()["albums"]
    assert isinstance(albums, list)
    assert len(albums) > 0
    a = albums[0]
    for key in ("album", "artist", "song_count", "total_duration"):
        assert key in a


def test_album_search(client):
    r = client.get("/api/albums/?search=zzzznonexistentzzzz")
    assert r.status_code == 200
    assert r.get_json()["albums"] == []


def test_album_detail(client):
    r = client.get("/api/albums/")
    albums = r.get_json()["albums"]
    assert albums, "Need at least one album to test detail"
    a = albums[0]
    import urllib.parse
    url = ("/api/albums/detail?album=" + urllib.parse.quote(a["album"])
           + "&artist=" + urllib.parse.quote(a["artist"]))
    r = client.get(url)
    assert r.status_code == 200
    data = r.get_json()
    assert "album" in data
    assert "songs" in data
    assert len(data["songs"]) >= 1


def test_albums_requires_auth(anon_client):
    r = anon_client.get("/api/albums/")
    assert r.status_code in (401, 403, 302)


# ---------------------------------------------------------------------------
# Smart Mix
# ---------------------------------------------------------------------------

def test_smartmix_discovery(client):
    r = client.post("/api/smartmix/generate",
                    json={"mode": "discovery", "limit": 5})
    assert r.status_code == 200
    songs = r.get_json()["songs"]
    assert isinstance(songs, list)
    assert len(songs) <= 5


def test_smartmix_radio(client):
    r = client.post("/api/smartmix/generate",
                    json={"mode": "radio", "seed_song_id": 1, "limit": 5})
    assert r.status_code == 200
    assert isinstance(r.get_json()["songs"], list)


def test_smartmix_liked(client):
    r = client.post("/api/smartmix/generate",
                    json={"mode": "liked", "limit": 5})
    assert r.status_code == 200
    assert isinstance(r.get_json()["songs"], list)


def test_smartmix_invalid_mode(client):
    r = client.post("/api/smartmix/generate",
                    json={"mode": "bogus", "limit": 5})
    # Should either 400 or return an empty/error gracefully
    assert r.status_code in (200, 400)


def test_smartmix_requires_auth(anon_client):
    r = anon_client.post("/api/smartmix/generate", json={"mode": "radio"})
    assert r.status_code in (401, 403, 302)


# ---------------------------------------------------------------------------
# Playlist Drag-and-Drop Reordering
# ---------------------------------------------------------------------------

def test_playlist_reorder(client):
    # Create a temp playlist
    r = client.post("/api/playlists/",
                    json={"name": "Reorder Test", "icon": "music-note", "icon_color": "#fa586a"})
    assert r.status_code == 200
    pid = r.get_json()["id"]

    try:
        for sid in [1, 2, 3]:
            client.post(f"/api/playlists/{pid}/songs", json={"song_id": sid})

        # Initial order should be [1, 2, 3]
        r = client.get(f"/api/playlists/{pid}")
        order = [s["id"] for s in r.get_json()["songs"]]
        assert order == [1, 2, 3]

        # Reorder to [3, 1, 2]
        r = client.post(f"/api/playlists/{pid}/reorder",
                        json={"ordered_track_ids": [3, 1, 2]})
        assert r.status_code == 200
        assert r.get_json()["success"] is True

        # Verify persisted order
        r = client.get(f"/api/playlists/{pid}")
        order = [s["id"] for s in r.get_json()["songs"]]
        assert order == [3, 1, 2]
    finally:
        client.delete(f"/api/playlists/{pid}")


def test_playlist_reorder_empty_list(client):
    r = client.post("/api/playlists/",
                    json={"name": "Reorder Empty", "icon": "music-note", "icon_color": "#fa586a"})
    pid = r.get_json()["id"]
    try:
        r = client.post(f"/api/playlists/{pid}/reorder",
                        json={"ordered_track_ids": []})
        assert r.status_code == 400
    finally:
        client.delete(f"/api/playlists/{pid}")


def test_playlist_reorder_not_found(client):
    r = client.post("/api/playlists/999999/reorder",
                    json={"ordered_track_ids": [1, 2]})
    assert r.status_code == 404


def test_playlist_reorder_requires_auth(anon_client):
    r = anon_client.post("/api/playlists/1/reorder",
                         json={"ordered_track_ids": [1]})
    assert r.status_code in (401, 403, 302)
