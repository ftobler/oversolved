"""Tests for HTTP security headers."""

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


REQUIRED_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "0",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


class TestSecurityHeaders:

    def test_security_headers_present(self, client):
        resp = client.get("/api/auth/me")
        for header, expected in REQUIRED_HEADERS.items():
            assert resp.headers.get(header) == expected, f"Missing or wrong {header}"

    def test_cors_headers_not_set(self, client):
        resp = client.get("/api/auth/me")
        assert resp.headers.get("Access-Control-Allow-Origin") is None

    def test_hsts_not_set_when_secure_disabled(self, client):
        resp = client.get("/api/auth/me")
        assert resp.headers.get("Strict-Transport-Security") is None

    def test_hsts_set_when_secure_enabled(self, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        app = create_app({
            "DB_TYPE": "sqlite", "TESTING": True, "DB_PATH": ":memory:",
            "SESSION_COOKIE_SECURE": True,
        })
        client = app.test_client()
        resp = client.get("/api/auth/me")
        assert resp.headers.get("Strict-Transport-Security") == "max-age=31536000; includeSubDomains"
