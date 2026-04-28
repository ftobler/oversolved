"""Tests for user management feature."""

import json
import pytest
from oversolved.app import create_app


@pytest.fixture
def app(tmp_path):
    """Create a test Flask app with a file-based SQLite database."""
    db_path = str(tmp_path / "test.db")
    test_app = create_app(
        {
            "DB_TYPE": "sqlite",
            "DB_PATH": db_path,
        }
    )
    test_app.config["TESTING"] = True
    return test_app


@pytest.fixture
def client(app):
    """Create an unauthenticated test client."""
    return app.test_client()


@pytest.fixture
def admin_client(app):
    """Create a test client logged in as admin."""
    c = app.test_client()
    response = c.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return c


@pytest.fixture
def regular_client(app):
    """Create a test client logged in as a regular user."""
    c = app.test_client()
    # Create user via admin
    admin = app.test_client()
    admin.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    admin.post(
        "/api/admin/users",
        data=json.dumps({"username": "regular", "password": "regular123"}),
        content_type="application/json",
    )
    response = c.post(
        "/api/auth/login",
        data=json.dumps({"username": "regular", "password": "regular123"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return c


class TestAdminAPI:
    """Tests for admin user management endpoints."""

    def test_list_users_requires_admin(self, client, regular_client):
        response = client.get("/api/admin/users")
        assert response.status_code == 401

        response = regular_client.get("/api/admin/users")
        assert response.status_code == 403

    def test_list_users_as_admin(self, admin_client):
        response = admin_client.get("/api/admin/users")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert "users" in data
        assert len(data["users"]) >= 1
        usernames = [u["username"] for u in data["users"]]
        assert "admin" in usernames
        for user in data["users"]:
            assert "password_hash" not in user
            assert "id" in user
            assert "is_admin" in user
            assert "is_active" in user

    def test_create_user(self, admin_client):
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "newuser", "password": "password123", "is_admin": False}),
            content_type="application/json",
        )
        assert response.status_code == 201
        data = json.loads(response.data)
        assert data["username"] == "newuser"
        assert "id" in data

    def test_create_user_duplicate_username(self, admin_client):
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "dupuser", "password": "password123"}),
            content_type="application/json",
        )
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "dupuser", "password": "password123"}),
            content_type="application/json",
        )
        assert response.status_code == 409

    def test_update_user(self, admin_client):
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "toupdate", "password": "password123"}),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"is_active": False, "is_admin": True}),
            content_type="application/json",
        )
        assert response.status_code == 200

        list_resp = admin_client.get("/api/admin/users")
        users = json.loads(list_resp.data)["users"]
        updated = next(u for u in users if u["id"] == user_id)
        assert updated["is_active"] is False
        assert updated["is_admin"] is True

    def test_delete_user(self, admin_client):
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "todelete", "password": "password123"}),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.delete(f"/api/admin/users/{user_id}")
        assert response.status_code == 200

        list_resp = admin_client.get("/api/admin/users")
        users = json.loads(list_resp.data)["users"]
        assert not any(u["id"] == user_id for u in users)

    def test_delete_self_forbidden(self, admin_client):
        me_resp = admin_client.get("/api/auth/me")
        user_id = json.loads(me_resp.data)["user"]["id"]

        response = admin_client.delete(f"/api/admin/users/{user_id}")
        assert response.status_code == 403

    def test_reset_password(self, admin_client):
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "toreset", "password": "oldpassword"}),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.post(
            f"/api/admin/users/{user_id}/reset",
            data=json.dumps({"password": "newpassword"}),
            content_type="application/json",
        )
        assert response.status_code == 200

        # Verify old password no longer works
        login_resp = admin_client.post(
            "/api/auth/login",
            data=json.dumps({"username": "toreset", "password": "oldpassword"}),
            content_type="application/json",
        )
        assert login_resp.status_code == 401

        # Verify new password works
        login_resp = admin_client.post(
            "/api/auth/login",
            data=json.dumps({"username": "toreset", "password": "newpassword"}),
            content_type="application/json",
        )
        assert login_resp.status_code == 200


class TestUserProfileAPI:
    """Tests for user profile endpoints."""

    def test_get_profile(self, regular_client):
        response = regular_client.get("/api/users/me")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["user"]["username"] == "regular"
        assert "created_at" in data["user"]

    def test_update_username(self, regular_client):
        response = regular_client.put(
            "/api/users/me",
            data=json.dumps({"username": "regular2"}),
            content_type="application/json",
        )
        assert response.status_code == 200

        me_resp = regular_client.get("/api/auth/me")
        assert json.loads(me_resp.data)["user"]["username"] == "regular2"

    def test_update_password(self, regular_client):
        response = regular_client.put(
            "/api/users/me",
            data=json.dumps({"current_password": "regular123", "new_password": "newpass456"}),
            content_type="application/json",
        )
        assert response.status_code == 200

        # Old password should no longer work
        login_resp = regular_client.post(
            "/api/auth/login",
            data=json.dumps({"username": "regular", "password": "regular123"}),
            content_type="application/json",
        )
        assert login_resp.status_code == 401

        # New password should work
        login_resp = regular_client.post(
            "/api/auth/login",
            data=json.dumps({"username": "regular", "password": "newpass456"}),
            content_type="application/json",
        )
        assert login_resp.status_code == 200

    def test_update_password_wrong_current(self, regular_client):
        response = regular_client.put(
            "/api/users/me",
            data=json.dumps({"current_password": "wrong", "new_password": "newpass456"}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert "incorrect" in json.loads(response.data)["error"].lower()

    def test_deactivated_user_cannot_login(self, admin_client, app):
        # Create a user and deactivate it
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "deactivated", "password": "password123"}),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"is_active": False}),
            content_type="application/json",
        )

        # Try to login as deactivated user
        c = app.test_client()
        login_resp = c.post(
            "/api/auth/login",
            data=json.dumps({"username": "deactivated", "password": "password123"}),
            content_type="application/json",
        )
        assert login_resp.status_code == 403
        assert "deactivated" in json.loads(login_resp.data)["error"].lower()

    def test_cannot_deactivate_self(self, admin_client):
        me_resp = admin_client.get("/api/auth/me")
        user_id = json.loads(me_resp.data)["user"]["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"is_active": False}),
            content_type="application/json",
        )
        assert response.status_code == 403

    def test_cannot_remove_own_admin(self, admin_client):
        me_resp = admin_client.get("/api/auth/me")
        user_id = json.loads(me_resp.data)["user"]["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"is_admin": False}),
            content_type="application/json",
        )
        assert response.status_code == 403
