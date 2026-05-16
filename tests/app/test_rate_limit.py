"""Tests for login rate limiting."""

import json
import pytest
from oversolved.app import create_app
from oversolved.blueprints.auth import (
    _login_failures, _login_failures_lock,
    _LOGIN_RATE_LIMIT, _LOGIN_RATE_WINDOW,
)


@pytest.fixture(autouse=True)
def clear_rate_limit_state():
    """Reset rate limit state before each test."""
    with _login_failures_lock:
        _login_failures.clear()
    yield


@pytest.fixture
def app(pg_dsn, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


def _bad_login(client, username="attacker", remote_addr="127.0.0.1"):
    return client.post(
        "/api/auth/login",
        data=json.dumps({"username": username, "password": "wrong"}),
        content_type="application/json",
        environ_base={"REMOTE_ADDR": remote_addr},
    )


def _good_login(client):
    return client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )


class TestLoginRateLimit:

    def test_blocks_after_n_failures(self, client):
        for _ in range(_LOGIN_RATE_LIMIT):
            resp = _bad_login(client)
            assert resp.status_code == 401
        resp = _bad_login(client)
        assert resp.status_code == 429
        assert resp.get_json() == {"error": "Too many login attempts"}

    def test_different_ips_independent(self, client):
        for _ in range(_LOGIN_RATE_LIMIT):
            resp = _bad_login(client, username="alice")
            assert resp.status_code == 401
        resp = _bad_login(client, username="bob", remote_addr="10.0.0.1")
        assert resp.status_code == 401

    def test_success_resets_counter(self, client):
        for _ in range(_LOGIN_RATE_LIMIT - 1):
            resp = _bad_login(client)
            assert resp.status_code == 401
        resp = _good_login(client)
        assert resp.status_code == 200
        for _ in range(_LOGIN_RATE_LIMIT - 1):
            resp = _bad_login(client)
            assert resp.status_code == 401
        resp = _bad_login(client)
        assert resp.status_code == 401
        resp = _bad_login(client)
        assert resp.status_code == 429

    def test_window_expiry(self, client, monkeypatch):
        fake_time = [1000.0]
        monkeypatch.setattr("oversolved.rate_limit.time", lambda: fake_time[0])

        for _ in range(_LOGIN_RATE_LIMIT):
            resp = _bad_login(client)
            assert resp.status_code == 401
        resp = _bad_login(client)
        assert resp.status_code == 429

        fake_time[0] += _LOGIN_RATE_WINDOW + 1
        resp = _bad_login(client)
        assert resp.status_code == 401

    def test_login_still_works_when_not_rate_limited(self, client):
        resp = _good_login(client)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["user"]["username"] == "admin"
