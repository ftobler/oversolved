"""Tests for CSRF protection (Origin/Referer check)."""

import pytest
from flask import Flask, jsonify
from oversolved.app import create_app
from oversolved.blueprints import require_csrf


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    db_path = str(tmp_path / "test.db")
    test_app = create_app({"DB_TYPE": "sqlite", "TESTING": True, "DB_PATH": db_path})
    return test_app


class TestRequireCsrfDecorator:

    def _make_app(self, methods=("POST",)):
        app = Flask(__name__)
        app.config["TESTING"] = False

        @app.route("/test", methods=methods)
        @require_csrf
        def view():
            return jsonify({"ok": True})

        return app

    def test_missing_origin_and_referer_accepted(self):
        """Same-origin requests without Origin/Referer are accepted (browsers always send these)."""
        app = self._make_app()
        with app.test_client() as client:
            resp = client.post("/test")
            assert resp.status_code == 200

    def test_wrong_origin_rejected(self):
        app = self._make_app()
        with app.test_client() as client:
            resp = client.post("/test", headers={"Origin": "https://evil.com"})
            assert resp.status_code == 403
            assert resp.get_json() == {"error": "Invalid CSRF token"}

    def test_wrong_referer_rejected(self):
        app = self._make_app()
        with app.test_client() as client:
            resp = client.post("/test", headers={"Referer": "https://evil.com/page"})
            assert resp.status_code == 403

    def test_matching_origin_accepted(self):
        app = self._make_app()
        with app.test_client() as client:
            resp = client.post("/test", headers={"Origin": "http://localhost"})
            assert resp.status_code == 200

    def test_get_exempt(self):
        app = self._make_app(methods=("GET",))
        with app.test_client() as client:
            resp = client.get("/test", headers={"Origin": "https://evil.com"})
            assert resp.status_code == 200
