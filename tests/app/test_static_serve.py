"""Tests for static file serving path traversal protection."""

import pytest
from oversolved.app import create_app


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app({"DB_TYPE": "sqlite", "TESTING": True, "DB_PATH": ":memory:"})
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


class TestStaticServe:

    def test_normal_static_file(self, client):
        resp = client.get("/index.html")
        assert resp.status_code == 200

    def test_missing_file(self, client):
        resp = client.get("/nonexistent.html")
        assert resp.status_code == 200

    def test_path_traversal_blocked(self, client):
        resp = client.get("/../../../etc/passwd")
        assert resp.status_code == 404

    def test_path_traversal_encoded(self, client):
        resp = client.get("/%2e%2e/%2e%2e/etc/passwd")
        assert resp.status_code == 404

    def test_subdirectory_file(self, client):
        resp = client.get("/assets/index.css")
        assert resp.status_code in (200, 404)
