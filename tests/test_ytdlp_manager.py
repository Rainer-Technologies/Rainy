"""yt-dlp manager: outdated-error detection, update-on-failure, option injection."""
import pytest

import app as app_module
from utils import ytdlp_manager as m


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    monkeypatch.setattr(m, '_last_failure_update', 0.0)
    for flag in ('_import_worker_started', '_enrichment_worker_started', '_sync_worker_started',
                 '_lightshow_worker_started', '_lyrics_worker_started', '_ytdlp_worker_started'):
        monkeypatch.setattr(app_module, flag, True)


@pytest.mark.parametrize('msg', [
    'ERROR: unable to download video data: HTTP Error 403: Forbidden',
    'ERROR: [youtube] abc: Requested format is not available. Use --list-formats',
    "ERROR: [youtube] abc: Sign in to confirm you're not a bot",
    'WARNING: [youtube] nsig extraction failed: Some formats may be missing',
])
def test_detects_outdated_errors(msg):
    assert m.looks_outdated(msg)


@pytest.mark.parametrize('msg', [
    'ERROR: [youtube] abc: Private video. Sign in if you have access to the video',
    'ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader',
    'Invalid YouTube URL',
])
def test_ignores_unrelated_errors(msg):
    assert not m.looks_outdated(msg)


def test_version_compare_ignores_zero_padding():
    assert m._norm('2026.08.19') == m._norm('2026.8.19')
    assert m._norm('2026.8.19') > m._norm('2026.3.17')


def test_update_on_failure_updates_once_then_cools_down(monkeypatch):
    versions = iter(['2026.3.17', '2026.8.19', '2026.8.19', '2026.8.19'])
    calls = []
    monkeypatch.setattr(m, 'installed_version', lambda: next(versions))
    monkeypatch.setattr(m, 'check', lambda **kw: calls.append(kw))
    assert m.update_on_failure('HTTP Error 403: Forbidden') is True
    assert m.update_on_failure('HTTP Error 403: Forbidden') is False  # cooldown
    assert len(calls) == 1


def test_update_on_failure_skips_unrelated_errors(monkeypatch):
    monkeypatch.setattr(m, 'check', lambda **kw: pytest.fail('should not update'))
    assert m.update_on_failure('Private video') is False


def test_youtubedl_injects_js_runtime_but_caller_wins(monkeypatch):
    seen = {}

    class FakeYDL:
        def __init__(self, opts):
            seen.update(opts)

    class FakeMod:
        YoutubeDL = FakeYDL

    monkeypatch.setattr(m, '_fresh_module', lambda: FakeMod)
    monkeypatch.setattr(m, 'js_runtime', lambda: ('node', '/usr/bin/node'))
    m.YoutubeDL({'quiet': True})
    assert seen == {'js_runtimes': {'node': {'path': '/usr/bin/node'}}, 'quiet': True}
    seen.clear()
    m.YoutubeDL({'js_runtimes': {'deno': {}}})
    assert seen['js_runtimes'] == {'deno': {}}


def test_status_route_requires_auth(anon_client):
    assert anon_client.get('/api/music/ytdlp/status').status_code == 401


def test_status_route(client, monkeypatch):
    monkeypatch.setattr(m, 'status', lambda: {'installed': '2026.8.19', 'up_to_date': True})
    body = client.get('/api/music/ytdlp/status').get_json()
    assert body['ytdlp']['installed'] == '2026.8.19'
