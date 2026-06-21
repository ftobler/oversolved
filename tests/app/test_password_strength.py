"""Tests for password strength validation."""

import json
import pytest


@pytest.fixture
def admin_headers(client):
    """Login as admin and return Cookie header."""
    resp = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    set_cookie = resp.headers.get("Set-Cookie", "")
    token = set_cookie.split("session_token=")[1].split(";")[0]
    return {"Cookie": f"session_token={token}"}


class TestPasswordStrength:

    def _create_user(self, client, headers, password="short"):
        return client.post(
            "/api/admin/users",
            data=json.dumps({"username": "newuser", "email": "new@test.com", "password": password}),
            content_type="application/json",
            headers=headers,
        )

    def _reset_password(self, client, headers, password="short"):
        return client.post(
            "/api/admin/users/1/reset",
            data=json.dumps({"password": password}),
            content_type="application/json",
            headers=headers,
        )

    def _change_password(self, client, headers, new_password="short"):
        return client.put(
            "/api/users/me",
            data=json.dumps({
                "current_password": "admin",
                "new_password": new_password,
            }),
            content_type="application/json",
            headers=headers,
        )

    def test_create_user_too_short(self, client, admin_headers):
        resp = self._create_user(client, admin_headers, password="a")
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["ok"] is False
        assert data["error"] == "Password must be at least 8 characters long"
        assert data["code"] == "VALIDATION_ERROR"

    def test_create_user_exactly_8_accepted(self, client, admin_headers):
        resp = self._create_user(client, admin_headers, password="12345678")
        assert resp.status_code == 201

    def test_create_user_long_accepted(self, client, admin_headers):
        resp = self._create_user(client, admin_headers, password="x" * 64)
        assert resp.status_code == 201

    def test_reset_password_too_short(self, client, admin_headers):
        resp = self._reset_password(client, admin_headers, password="short")
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["ok"] is False
        assert data["error"] == "Password must be at least 8 characters long"
        assert data["code"] == "VALIDATION_ERROR"

    def test_reset_password_exactly_8_accepted(self, client, admin_headers):
        resp = self._reset_password(client, admin_headers, password="12345678")
        assert resp.status_code == 200

    def test_change_password_too_short(self, client, admin_headers):
        resp = self._change_password(client, admin_headers, new_password="short")
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["ok"] is False
        assert data["error"] == "Password must be at least 8 characters long"
        assert data["code"] == "VALIDATION_ERROR"

    def test_change_password_exactly_8_accepted(self, client, admin_headers):
        resp = self._change_password(client, admin_headers, new_password="12345678")
        assert resp.status_code == 200
