"""Unknown /api/* paths must get the JSON error envelope, not the SPA fallback."""

import json
import pytest
from oversolved.app import create_app


@pytest.fixture
def client(pg_dsn, monkeypatch, tmp_path):
    """Client on an app whose SPA dist really exists, like in production."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    dist_dir = tmp_path / "frontend" / "dist"
    dist_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html>spa</html>")
    app = create_app({
        "DB_TYPE": "postgres",
        "TESTING": True,
        "DB_DSN": pg_dsn,
        "FRONTEND_DIST": str(dist_dir),
    })
    return app.test_client()


class TestApiUnknownPathJson404:

    def test_unknown_api_path_returns_json_envelope(self, client):
        resp = client.get("/api/definitely/not/an/api/route")
        assert resp.status_code == 404
        assert resp.content_type == "application/json"
        body = json.loads(resp.data)
        assert body["ok"] is False
        assert body["error"] == "not found"
        assert body["code"] == "NOT_FOUND"

    def test_unknown_non_api_path_still_serves_spa(self, client):
        resp = client.get("/some/unknown/non/api/path")
        assert resp.status_code == 200
        assert resp.content_type.startswith("text/html")
        # The handler falls through to send_from_directory(index.html).
        assert b"<html>spa</html>" in resp.data

    def test_real_api_route_still_answers(self, client):
        resp = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.content_type == "application/json"
        assert resp.json["user"]["username"] == "admin"
