"""Shared pytest fixtures for Rainy feature tests."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from app import app as flask_app


@pytest.fixture
def app():
    flask_app.config["TESTING"] = True
    return flask_app


@pytest.fixture
def client(app):
    """A Flask test client with an authenticated session (user_id=1)."""
    c = app.test_client()
    with c.session_transaction() as sess:
        sess["user_id"] = 1
    return c


@pytest.fixture
def anon_client(app):
    """An unauthenticated Flask test client."""
    return app.test_client()
