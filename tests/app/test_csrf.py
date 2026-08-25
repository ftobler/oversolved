"""Tests for CSRF protection (Origin/Referer check)."""

import json

import pytest
from flask import Flask, jsonify
from oversolved.blueprints import require_csrf


class TestRequireCsrfDecorator:

    def _make_app(self, methods=("POST",)):
        app = Flask(__name__)
        app.config["TESTING"] = False

        @app.route("/test", methods=methods)
        @require_csrf
        def view():
            return jsonify({"ok": True})

        return app

    def test_missing_origin_and_referer_rejected(self):
        """Mutating requests must carry an Origin or Referer. Browsers always send
        one on a state-changing request, so a request missing both is treated as a
        CSRF risk and rejected (see CSRF hardening in require_csrf)."""
        app = self._make_app()
        with app.test_client() as client:
            resp = client.post("/test")
            assert resp.status_code == 403
            data = resp.get_json()
            assert data["code"] == "CSRF_FAILED"

    def test_wrong_origin_rejected(self):
        app = self._make_app()
        with app.test_client() as client:
            resp = client.post("/test", headers={"Origin": "https://evil.com"})
            assert resp.status_code == 403
            data = resp.get_json()
            assert data["ok"] is False
            assert data["error"] == "Request blocked for security reasons. Please reload the page."
            assert data["code"] == "CSRF_FAILED"

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


class TestLoginRouteCsrf:
    """Login must carry the same Origin/Referer gate as every other mutating
    route; without it a cross-site form could silently log the victim into an
    attacker-chosen account (login CSRF)."""

    @pytest.fixture
    def client(self, pg_dsn, monkeypatch):
        # A non-default admin password keeps create_app from refusing to boot
        # outside TESTING mode.
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "csrf-admin-pass")
        from oversolved.app import create_app

        app = create_app({
            "DB_TYPE": "postgres",
            "TESTING": False,
            "DB_DSN": pg_dsn,
        })
        return app.test_client()

    @staticmethod
    def _login(client, **kwargs):
        return client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "csrf-admin-pass"}),
            content_type="application/json",
            **kwargs,
        )

    def test_login_without_origin_rejected(self, client):
        resp = self._login(client)
        assert resp.status_code == 403
        data = resp.get_json()
        assert data["code"] == "CSRF_FAILED"

    def test_login_cross_origin_rejected(self, client):
        resp = self._login(client, headers={"Origin": "https://evil.com"})
        assert resp.status_code == 403
        assert resp.get_json()["code"] == "CSRF_FAILED"

    def test_login_same_origin_accepted(self, client):
        resp = self._login(client, headers={"Origin": "http://localhost"})
        assert resp.status_code == 200
        assert resp.get_json()["user"]["username"] == "admin"
