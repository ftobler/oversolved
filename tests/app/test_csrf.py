"""Tests for CSRF protection."""

import json
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


def test_csrf_token_set_on_login(app):
    client = app.test_client()
    resp = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert resp.status_code == 200, resp.get_json()
    # Collect ALL Set-Cookie headers
    csrf_found = False
    for k, v in resp.headers:
        if k == "Set-Cookie" and "XSRF-TOKEN=" in v:
            csrf_found = True
    assert csrf_found


class TestRequireCsrfDecorator:

    def _make_app(self, methods=("POST",)):
        app = Flask(__name__)
        app.config["TESTING"] = False

        @app.route("/test", methods=methods)
        @require_csrf
        def view():
            return jsonify({"ok": True})

        return app

    def test_missing_header_rejected(self):
        app = self._make_app()
        with app.test_client() as client:
            resp = client.post("/test")
            assert resp.status_code == 403
            assert resp.get_json() == {"error": "Invalid CSRF token"}

    def test_wrong_token_rejected(self):
        app = self._make_app()
        with app.test_client() as client:
            resp = client.post(
                "/test",
                headers={"X-XSRF-TOKEN": "wrong", "Cookie": "XSRF-TOKEN=real"},
            )
            assert resp.status_code == 403

    def test_matching_token_accepted(self):
        app = self._make_app()
        with app.test_client() as client:
            client.set_cookie("XSRF-TOKEN", "abc123")
            resp = client.post("/test", headers={"X-XSRF-TOKEN": "abc123"})
            assert resp.status_code == 200

    def test_get_exempt(self):
        app = self._make_app(methods=("GET",))
        with app.test_client() as client:
            resp = client.get("/test")
            assert resp.status_code == 200
