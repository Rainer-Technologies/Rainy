"""Tests for playlist DISCOVERY (search by name + preview).

Network calls are monkeypatched out: discovery.search_playlists' internals
and the requests/yt-dlp hits never touch the wire here. The point is to
pin the route contract (auth, validation, shapes, notices) and the pure
helpers.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from utils import discovery


# ------------------------------------------------------------------ unit ----

def test_detect_source():
    assert discovery.detect_source(
        'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M') == 'spotify'
    assert discovery.detect_source(
        'https://open.spotify.com/intl-es/playlist/37i9dQZF1DXcBWIGoYBM5M') == 'spotify'
    assert discovery.detect_source(
        'https://music.youtube.com/playlist?list=PLx0sYbCqOb8QPYZpbwQcqsD8WLEB2ZbHJ') == 'youtube'
    assert discovery.detect_source(
        'https://www.youtube.com/playlist?list=PLx0sYbCqOb8QP') == 'youtube'
    assert discovery.detect_source('https://example.com/playlist') is None
    assert discovery.detect_source('') is None


def test_spotify_cover_from_embed_entity():
    entity = {'coverArt': {'sources': [{'url': 'https://i.scdn.co/x', 'width': 640}]}}
    assert discovery._spotify_cover(entity) == 'https://i.scdn.co/x'
    assert discovery._spotify_cover({}) is None
    assert discovery._spotify_cover({'cover': 'https://c/y'}) == 'https://c/y'


def test_cache_roundtrip():
    discovery._cache_set(('t', 'x'), [1, 2])
    assert discovery._cache_get(('t', 'x')) == [1, 2]
    # empty-result TTL path also stores
    discovery._cache_set(('t', 'empty'), [], ttl=discovery._EMPTY_TTL)
    assert discovery._cache_get(('t', 'empty')) == []


# ----------------------------------------------------------------- route ----

def test_discovery_requires_auth(anon_client):
    assert anon_client.get('/api/discovery/playlists?q=lofi beats').status_code == 401
    assert anon_client.get('/api/discovery/preview?url=https://x').status_code == 401


def test_search_validates_query(client):
    r = client.get('/api/discovery/playlists?q=a')
    assert r.status_code == 400
    r = client.get('/api/discovery/playlists?q=&source=youtube')
    assert r.status_code == 400
    r = client.get('/api/discovery/playlists?q=lofi beats&source=bogus')
    assert r.status_code == 400


def test_search_returns_results_and_notices(client, monkeypatch):
    monkeypatch.setattr(discovery, 'search_youtube_playlists',
                        lambda q, limit=8: [{
                            'source': 'youtube', 'name': 'Lo-fi beats',
                            'url': 'https://www.youtube.com/playlist?list=PLx',
                            'channel': 'Some Channel', 'cover': None,
                            'track_count': None}])
    def _boom(q, limit=6, notices=None):
        if notices is not None:
            notices.append('Spotify name-search is rate-limited right now.')
        raise discovery.DiscoveryUnavailable('duckduckgo rate-limited')
    monkeypatch.setattr(discovery, 'search_spotify_playlists', _boom)

    r = client.get('/api/discovery/playlists?q=lofi beats')
    assert r.status_code == 200
    body = r.get_json()
    assert body['success'] is True
    assert len(body['results']) == 1
    assert body['results'][0]['source'] == 'youtube'
    # partial-success contract: notice explains the missing side
    assert any('rate-limited' in n for n in body['notices'])


def test_preview_rejects_unknown_url(client):
    r = client.get('/api/discovery/preview?url=https://example.com/playlist')
    assert r.status_code == 400
    assert 'recognized' in r.get_json()['error'].lower()


def test_preview_spotify_ok(client, monkeypatch):
    fake = {'success': True, 'source': 'spotify', 'name': 'Top Hits',
            'cover': 'https://i.scdn.co/x', 'total': 2, 'note': None,
            'tracks': [{'title': 'A', 'artist': 'B', 'duration': 200, 'url': None},
                       {'title': 'C', 'artist': 'D', 'duration': 180, 'url': None}]}
    monkeypatch.setattr(discovery, '_preview_spotify', lambda url: fake)
    r = client.get('/api/discovery/preview'
                   '?url=https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')
    assert r.status_code == 200
    body = r.get_json()
    assert body['name'] == 'Top Hits'
    assert body['total'] == 2
    assert body['tracks'][0]['title'] == 'A'


def test_preview_youtube_failure_is_422(client, monkeypatch):
    monkeypatch.setattr(discovery, '_preview_youtube',
                        lambda url: {'success': False,
                                     'error': 'YouTube said: no such playlist'})
    r = client.get('/api/discovery/preview'
                   '?url=https://www.youtube.com/playlist?list=PLNOPE')
    assert r.status_code == 422
    assert 'no such playlist' in r.get_json()['error']
