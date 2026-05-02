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
            "TESTING": True,
            "DB_PATH": db_path,
        }
    )
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
        data=json.dumps({"username": "regular", "password": "regular123", "email": "regular@example.com"}),
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
            assert "last_login_at" in user

    def test_create_user(self, admin_client):
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "newuser", "password": "password123",
                "email": "newuser@example.com", "is_admin": False,
            }),
            content_type="application/json",
        )
        assert response.status_code == 201
        data = json.loads(response.data)
        assert data["username"] == "newuser"
        assert "id" in data

    def test_create_user_duplicate_username(self, admin_client):
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "dupuser", "password": "password123", "email": "dupuser@example.com"}),
            content_type="application/json",
        )
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "dupuser", "password": "password123", "email": "dupuser2@example.com"}),
            content_type="application/json",
        )
        assert response.status_code == 409

    def test_update_user(self, admin_client):
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "toupdate", "password": "password123", "email": "toupdate@example.com"}),
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
            data=json.dumps({"username": "todelete", "password": "password123", "email": "todelete@example.com"}),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.delete(f"/api/admin/users/{user_id}")
        assert response.status_code == 200

        list_resp = admin_client.get("/api/admin/users")
        users = json.loads(list_resp.data)["users"]
        assert not any(u["id"] == user_id for u in users)

    def test_reset_password(self, admin_client):
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "toreset", "password": "oldpassword", "email": "toreset@example.com"}),
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

    def test_deactivated_user_cannot_login(self, admin_client, app):
        # Create a user and deactivate it
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "deactivated", "password": "password123", "email": "deactivated@example.com"}),
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

    def test_last_login_null_for_never_logged_in(self, admin_client):
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "neverlogin", "password": "password123", "email": "neverlogin@example.com"}),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        list_resp = admin_client.get("/api/admin/users")
        users = json.loads(list_resp.data)["users"]
        user = next(u for u in users if u["id"] == user_id)
        assert user["last_login_at"] is None


class TestLoginWithCredential:
    """Tests for login with email/nickname."""

    def test_login_by_email(self, app, admin_client):
        # Create a user with email
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "byemail", "password": "password123",
                "email": "byemail@example.com"
            }),
            content_type="application/json",
        )

        # Login with email
        c = app.test_client()
        response = c.post(
            "/api/auth/login",
            data=json.dumps({"credential": "byemail@example.com", "password": "password123"}),
            content_type="application/json",
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["user"]["username"] == "byemail"

    def test_login_by_username_still_works(self, app):
        c = app.test_client()
        response = c.post(
            "/api/auth/login",
            data=json.dumps({"credential": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert response.status_code == 200

    def test_login_case_insensitive_email(self, app, admin_client):
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "caseuser", "password": "password123",
                "email": "CaseUser@Example.COM"
            }),
            content_type="application/json",
        )

        c = app.test_client()
        response = c.post(
            "/api/auth/login",
            data=json.dumps({"credential": "caseuser@example.com", "password": "password123"}),
            content_type="application/json",
        )
        assert response.status_code == 200

    def test_login_invalid_credential(self, app):
        c = app.test_client()
        response = c.post(
            "/api/auth/login",
            data=json.dumps({"credential": "nonexistent@example.com", "password": "password123"}),
            content_type="application/json",
        )
        assert response.status_code == 401

    def test_login_returns_email(self, app, admin_client):
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "fulluser", "password": "password123",
                "email": "full@example.com"
            }),
            content_type="application/json",
        )

        c = app.test_client()
        response = c.post(
            "/api/auth/login",
            data=json.dumps({"credential": "fulluser", "password": "password123"}),
            content_type="application/json",
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["user"]["email"] == "full@example.com"


class TestProfile:
    """Tests for profile endpoints."""

    def test_update_email(self, admin_client):
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"email": "admin_new@example.com"}),
            content_type="application/json",
        )
        assert response.status_code == 200

        me_resp = admin_client.get("/api/auth/me")
        data = json.loads(me_resp.data)
        assert data["user"]["email"] == "admin_new@example.com"


class TestAdminCreateUserWithEmail:
    """Tests for admin user creation with email."""

    def test_create_user_with_email(self, admin_client):
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "withemail", "password": "password123",
                "email": "withemail@example.com"
            }),
            content_type="application/json",
        )
        assert response.status_code == 201
        data = json.loads(response.data)
        assert data["email"] == "withemail@example.com"

    def test_create_user_requires_email(self, admin_client):
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({"username": "noemail", "password": "password123"}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert "email" in json.loads(response.data)["error"].lower()

    def test_create_user_duplicate_email(self, admin_client):
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "email1", "password": "password123",
                "email": "duplicate@example.com"
            }),
            content_type="application/json",
        )
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "email2", "password": "password123",
                "email": "duplicate@example.com"
            }),
            content_type="application/json",
        )
        assert response.status_code == 409

    def test_admin_update_email(self, admin_client):
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "updatemail", "password": "password123",
                "email": "old@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"email": "new@example.com"}),
            content_type="application/json",
        )
        assert response.status_code == 200


class TestUserPreferences:
    """Tests for user preferences API endpoints."""

    def test_get_preferences_default(self, admin_client):
        response = admin_client.get("/api/users/me/preferences")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["document_sort"] == "alphabetical"

    def test_update_preferences_valid(self, admin_client):
        response = admin_client.put(
            "/api/users/me/preferences",
            data=json.dumps({"document_sort": "date_newest_first"}),
            content_type="application/json",
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "updated"
        assert data["document_sort"] == "date_newest_first"

    def test_update_preferences_persists(self, admin_client):
        admin_client.put(
            "/api/users/me/preferences",
            data=json.dumps({"document_sort": "date_oldest_first"}),
            content_type="application/json",
        )
        response = admin_client.get("/api/users/me/preferences")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["document_sort"] == "date_oldest_first"

    def test_update_preferences_invalid(self, admin_client):
        response = admin_client.put(
            "/api/users/me/preferences",
            data=json.dumps({"document_sort": "invalid_value"}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_update_preferences_requires_auth(self, client):
        response = client.put(
            "/api/users/me/preferences",
            data=json.dumps({"document_sort": "alphabetical"}),
            content_type="application/json",
        )
        assert response.status_code == 401

    def test_get_preferences_requires_auth(self, client):
        response = client.get("/api/users/me/preferences")
        assert response.status_code == 401


class TestBackupEndpoint:
    """Tests for the backup endpoint."""

    def test_backup_requires_auth(self, client):
        """Unauthenticated users cannot access backup."""
        response = client.get("/api/admin/backup")
        assert response.status_code == 401

    def test_backup_requires_admin(self, app, regular_client):
        """Non-admin authenticated users cannot access backup."""
        response = regular_client.get("/api/admin/backup")
        assert response.status_code == 403

    def test_backup_admin_can_download(self, admin_client):
        """Admin users can download backup as zip file."""
        response = admin_client.get("/api/admin/backup")
        assert response.status_code == 200
        assert response.content_type == 'application/zip'
        assert response.headers.get('Content-Disposition', '').startswith('attachment')


class TestAuthSecurity:
    """Tests for auth security hardening."""

    def test_admin_password_from_env_var(self, monkeypatch, tmp_path):
        """OVERSOLVED_ADMIN_PASSWORD env var sets admin password."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "custom-admin-pass")
        db_path = str(tmp_path / "test_custom_admin.db")
        app = create_app({
            "DB_TYPE": "sqlite",
            "TESTING": True,
            "DB_PATH": db_path,
        })
        c = app.test_client()
        resp = c.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "custom-admin-pass"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["user"]["username"] == "admin"

    def test_admin_password_env_var_wrong_password(self, monkeypatch, tmp_path):
        """Wrong password against env-var-admin returns 401."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "custom-admin-pass")
        db_path = str(tmp_path / "test_custom_admin2.db")
        app = create_app({
            "DB_TYPE": "sqlite",
            "TESTING": True,
            "DB_PATH": db_path,
        })
        c = app.test_client()
        resp = c.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 401

    def test_session_cookie_secure_default(self, tmp_path):
        """session_token cookie does NOT have secure flag by default."""
        db_path = str(tmp_path / "test_secure_default.db")
        app = create_app({
            "DB_TYPE": "sqlite",
            "TESTING": True,
            "DB_PATH": db_path,
        })
        c = app.test_client()
        resp = c.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        set_cookie = resp.headers.get("Set-Cookie", "")
        assert "Secure" not in set_cookie

    def test_session_cookie_secure_enabled(self, monkeypatch, tmp_path):
        """session_token cookie has secure flag when OVERSOLVED_SESSION_COOKIE_SECURE is True."""
        monkeypatch.setenv("OVERSOLVED_SESSION_COOKIE_SECURE", "true")
        db_path = str(tmp_path / "test_secure_on.db")
        app = create_app({
            "DB_TYPE": "sqlite",
            "TESTING": True,
            "DB_PATH": db_path,
        })
        c = app.test_client()
        resp = c.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        set_cookie = resp.headers.get("Set-Cookie", "")
        assert "Secure" in set_cookie
