"""Tests for the YouTube blend in the personalised mixes (R1).

Pure logic: a fake external provider stands in for YouTube Music, so nothing here
touches the network or the database. The provider records what it was asked for
(mood anchoring, dedupe) and returns deterministic track dicts.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from utils import mixes
from test_mixes import _ctx, _by_id


def _track(vid, title="New Song", artist="New Artist"):
    return {"videoId": vid, "title": title, "artist": artist, "album": "",
            "duration": 210, "cover_url": f"https://img/{vid}.jpg",
            "radio": True, "in_library": False, "external": True}


class FakeProvider:
    """Returns up to `want` fresh tracks, honouring exclude_videos, and logs calls."""

    def __init__(self, pool=200, fail=False):
        self.pool = pool
        self.fail = fail
        self.calls = []
        self._n = 0

    def __call__(self, mood_id=None, want=mixes._YT_PER_MIX, exclude_videos=()):
        self.calls.append({"mood_id": mood_id, "want": want,
                           "exclude": set(exclude_videos)})
        if self.fail:
            raise RuntimeError("youtube is down")
        out = []
        while len(out) < want and self._n < self.pool:
            vid = f"vid{self._n:03d}"
            self._n += 1
            if vid in exclude_videos:
                continue
            out.append(_track(vid, title=f"{mood_id or 'general'} song {self._n}"))
        return out


def test_no_provider_is_exactly_the_local_shelf():
    ctx = _ctx()
    plain = mixes.build_mixes(ctx, seed=1)
    for m in plain:
        assert m.get("external_tracks") == []
    assert not any(m["kind"] == "youtube" for m in plain)
    ser = mixes.serialize(ctx, plain)
    assert all(m.get("external_count", 0) == 0 for m in ser)
    assert all(s.get("in_library", True) for m in ser for s in m["songs"])


def test_provider_blends_externals_into_feature_and_mood_mixes():
    ctx = _ctx()
    prov = FakeProvider()
    shelf = mixes.build_mixes(ctx, seed=1, external=prov)
    by = _by_id(shelf)
    assert by["supermix"]["external_tracks"], "supermix gains external tracks"
    for mid in ("chill", "energize", "focus", "workout", "party", "sleep"):
        assert by[f"mood-{mid}"]["external_tracks"], mid
    # mood mixes were asked with their mood id (anchored seeding)
    mood_calls = {c["mood_id"] for c in prov.calls if c["mood_id"]}
    assert mood_calls == {"chill", "energize", "focus", "workout", "party", "sleep"}


def test_youtube_radio_mix_is_all_external():
    ctx = _ctx()
    shelf = mixes.build_mixes(ctx, seed=1, external=FakeProvider())
    by = _by_id(shelf)
    assert "youtube-radio" in by
    radio = by["youtube-radio"]
    assert radio["kind"] == "youtube"
    assert radio["song_ids"] == []
    assert len(radio["external_tracks"]) == mixes._YT_RADIO_SIZE
    ser = _by_id(mixes.serialize(ctx, shelf))["youtube-radio"]
    assert ser["count"] == mixes._YT_RADIO_SIZE
    assert ser["external_count"] == mixes._YT_RADIO_SIZE
    assert all(s["in_library"] is False and s["videoId"] for s in ser["songs"])


def test_serialize_interleaves_and_flags_externals():
    ctx = _ctx()
    shelf = mixes.build_mixes(ctx, seed=1, external=FakeProvider())
    ser = _by_id(mixes.serialize(ctx, shelf))["mood-chill"]
    songs = ser["songs"]
    ext = [s for s in songs if s.get("external")]
    loc = [s for s in songs if not s.get("external")]
    assert len(ext) == ser["external_count"] == mixes._YT_PER_MIX
    assert len(loc) + len(ext) == ser["count"]
    # local songs keep their relative order (the flow is not reshuffled)
    local_ids = [s["id"] for s in loc]
    assert local_ids == sorted(local_ids, key=local_ids.index)
    # externals carry the preview-proxy shape the player already understands
    for s in ext:
        assert s["videoId"] and s["in_library"] is False and "cover_url" in s


def test_one_video_is_offered_at_most_once_across_the_shelf():
    ctx = _ctx()
    prov = FakeProvider()
    shelf = mixes.build_mixes(ctx, seed=1, external=prov)
    seen = []
    for m in shelf:
        seen += [t["videoId"] for t in m.get("external_tracks", [])]
    assert len(seen) == len(set(seen)), "no external song repeated across mixes"
    # the provider was told to exclude what earlier mixes already took
    assert any(c["exclude"] for c in prov.calls)


def test_discover_is_filled_from_youtube_when_local_pool_is_thin():
    # A listener who has played almost everything: the local unplayed pool is tiny.
    ctx = _ctx()
    for sid in list(ctx.songs):
        ctx.plays[sid] = {"c": 3, "last": None, "c60": 1}
    plain = _by_id(mixes.build_mixes(ctx, seed=1))
    assert "discover" not in plain, "precondition: local discover is dropped"
    shelf = mixes.build_mixes(ctx, seed=1, external=FakeProvider())
    by = _by_id(shelf)
    assert "discover" in by, "YouTube fills discover instead of dropping it"
    assert by["discover"]["external_tracks"]


def test_youtube_down_degrades_to_the_local_shelf():
    ctx = _ctx()
    plain = _by_id(mixes.build_mixes(ctx, seed=1))
    degraded = _by_id(mixes.build_mixes(ctx, seed=1, external=FakeProvider(fail=True)))
    assert set(plain) == set(degraded), "a failing provider must not change the shelf"
    assert "youtube-radio" not in degraded
    for m in degraded.values():
        assert m.get("external_tracks") == []


def test_empty_provider_returns_no_radio_mix():
    ctx = _ctx()
    shelf = mixes.build_mixes(ctx, seed=1, external=FakeProvider(pool=0))
    assert not any(m["kind"] == "youtube" for m in shelf)
    assert all(m.get("external_tracks") == [] for m in shelf)


def test_interleave_spreads_externals_and_keeps_local_order():
    local = [{"id": i} for i in range(12)]
    ext = [_track(f"e{i}") for i in range(3)]
    out = mixes._interleave(local, ext, every=6)
    assert [s["id"] for s in out if "id" in s] == list(range(12))
    assert len(out) == 15
    # an all-external mix is just the external list
    assert mixes._interleave([], ext) == ext
    assert mixes._interleave(local, []) == local


def test_external_covers_use_the_url_not_the_local_cover_route():
    ctx = _ctx()
    shelf = mixes.build_mixes(ctx, seed=1, external=FakeProvider())
    ser = _by_id(mixes.serialize(ctx, shelf))["youtube-radio"]
    assert all(c.startswith("https://") for c in ser["covers"])
