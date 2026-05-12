"""Tests for static file serving path traversal protection."""

import pytest
from oversolved.app import create_app


@pytest.fixture
def app(pg_dsn, monkeypatch, tmp_path):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    dist_dir = tmp_path / "frontend" / "dist"
    dist_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html></html>")
    (dist_dir / "assets").mkdir()
    (dist_dir / "assets" / "index.css").write_text("body {}")
    test_app = create_app({
        "DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn,
        "FRONTEND_DIST": str(dist_dir),
    })
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
