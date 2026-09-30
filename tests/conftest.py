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


def sign_in(test_client, user_id):
    """Sign a test client in as user_id with a real server-side session row."""
    from models.session import SessionModel
    token = SessionModel.create(user_id, 3600)
    with test_client.session_transaction() as sess:
        sess["user_id"] = user_id
        sess["sid"] = token
    return token


@pytest.fixture
def client(app):
    """A Flask test client with an authenticated session (user_id=1)."""
    c = app.test_client()
    sign_in(c, 1)
    return c


@pytest.fixture
def anon_client(app):
    """An unauthenticated Flask test client."""
    return app.test_client()
