"""Tests for the About info API (/api/server/about)."""

import re
from pathlib import Path

from utils import about


def test_about_requires_auth(anon_client):
    r = anon_client.get("/api/server/about")
    assert r.status_code in (401, 403, 302)


def test_about(client):
    r = client.get("/api/server/about")
    assert r.status_code == 200
    data = r.get_json()
    assert data["version"] == about.VERSION
    assert re.fullmatch(r"\d+\.\d+\.\d+", data["version"])
    assert data["author"] == "Rainer Technologies"
    flask = next(c for c in data["components"] if c["name"] == "Flask")
    assert flask["license"] == "BSD-3-Clause"
    assert flask["version"]  # installed here, so its real version is reported


def test_optional_component_without_install_has_no_version(monkeypatch):
    def missing(_name):
        raise about.metadata.PackageNotFoundError
    monkeypatch.setattr(about.metadata, "version", missing)
    assert all(c["version"] is None for c in about.about_info()["components"])


def test_every_component_is_in_the_notices_file():
    notices = (Path(__file__).parent.parent / "THIRD_PARTY_NOTICES.md").read_text()
    missing = [name for name, *_ in about.COMPONENTS if name.lower() not in notices.lower()]
    assert missing == []
