"""Tests for user management feature."""

import json
import pytest
from oversolved.app import create_app


@pytest.fixture
def app(pg_dsn, monkeypatch):
    """Create a test Flask app with a PostgreSQL database."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app(
        {
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
            "DEBUG": False,
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

    def test_update_profile_requires_json(self, admin_client):
        """PUT with a non-JSON body is rejected before any field is read."""
        response = admin_client.put(
            "/api/users/me", data="not json", content_type="text/plain"
        )
        assert response.status_code == 400
        assert json.loads(response.data)["code"] == "INVALID_CONTENT_TYPE"

    def test_update_username(self, admin_client):
        """A non-empty username is trimmed and persisted."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"username": "  renamed_admin  "}),
            content_type="application/json",
        )
        assert response.status_code == 200
        me = json.loads(admin_client.get("/api/auth/me").data)
        assert me["user"]["username"] == "renamed_admin"

    def test_update_username_to_taken_name_returns_409(self, admin_client):
        """Renaming onto another account's username is a conflict, not a 500."""
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "takenname", "password": "password123",
                "email": "takenname@example.com"
            }),
            content_type="application/json",
        )
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"username": "takenname"}),
            content_type="application/json",
        )
        assert response.status_code == 409

    def test_update_username_to_own_name_is_allowed(self, admin_client):
        """Re-submitting the caller's own username is not a conflict."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"username": "admin"}),
            content_type="application/json",
        )
        assert response.status_code == 200

    def test_update_email_to_taken_address_returns_409(self, admin_client):
        """Claiming another account's email is a conflict, not a 500."""
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "mailowner", "password": "password123",
                "email": "mailowner@example.com"
            }),
            content_type="application/json",
        )
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"email": "mailowner@example.com"}),
            content_type="application/json",
        )
        assert response.status_code == 409

    def test_update_email_to_own_email_is_allowed(self, admin_client):
        """Re-submitting the caller's own email is not a conflict."""
        first = admin_client.put(
            "/api/users/me",
            data=json.dumps({"email": "keepmine@example.com"}),
            content_type="application/json",
        )
        assert first.status_code == 200
        second = admin_client.put(
            "/api/users/me",
            data=json.dumps({"email": "keepmine@example.com"}),
            content_type="application/json",
        )
        assert second.status_code == 200

    def test_update_username_non_string_is_rejected(self, admin_client):
        """A numeric username must be a 400, not an unhandled 500 on .strip()."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"username": 123}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_update_email_non_string_is_rejected(self, admin_client):
        """A numeric email must be a 400, not an unhandled 500 on .strip()."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"email": 42}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_change_password_requires_current(self, admin_client):
        """Supplying new_password without current_password is rejected."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"new_password": "newpassword123"}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert "current password" in json.loads(response.data)["error"].lower()

    def test_change_password_weak_new(self, admin_client):
        """A new password shorter than the minimum length is rejected."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"current_password": "admin", "new_password": "short"}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert json.loads(response.data)["code"] == "VALIDATION_ERROR"

    def test_change_password_wrong_current(self, admin_client):
        """An incorrect current_password blocks the change."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps(
                {"current_password": "wrongpass", "new_password": "newpassword123"}
            ),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert "incorrect" in json.loads(response.data)["error"].lower()

    def test_change_password_numeric_new_password_is_rejected(self, admin_client):
        """A numeric new_password must be a 400, not an unhandled 500 on len()."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"current_password": "admin", "new_password": 123}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_change_password_non_string_current_password_is_rejected(self, admin_client):
        """A non-string current_password must be a 400, not an unhandled 500 in hash checking."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps({"current_password": [], "new_password": "newpassword123"}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_change_password_success(self, app, admin_client):
        """A valid password change persists and lets the user log in anew."""
        response = admin_client.put(
            "/api/users/me",
            data=json.dumps(
                {"current_password": "admin", "new_password": "newpassword123"}
            ),
            content_type="application/json",
        )
        assert response.status_code == 200

        fresh = app.test_client()
        login = fresh.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "newpassword123"}),
            content_type="application/json",
        )
        assert login.status_code == 200


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

    def test_admin_update_null_username_is_rejected(self, admin_client):
        """A null username must be a 400, not an unhandled 500 on .strip()."""
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "nulluser", "password": "password123",
                "email": "nulluser@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"username": None}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_admin_update_duplicate_username_returns_409(self, admin_client):
        """An existing username on the update path conflicts like it does on create."""
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "occupied", "password": "password123",
                "email": "occupied@example.com"
            }),
            content_type="application/json",
        )
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "renamer", "password": "password123",
                "email": "renamer@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"username": "occupied"}),
            content_type="application/json",
        )
        assert response.status_code == 409

    def test_admin_update_same_username_is_allowed(self, admin_client):
        """Submitting the user's unchanged username is not a conflict."""
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "unchanged", "password": "password123",
                "email": "unchanged@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"username": "unchanged"}),
            content_type="application/json",
        )
        assert response.status_code == 200

    def test_admin_update_duplicate_email_returns_409(self, admin_client):
        """An existing email on the update path conflicts like it does on create."""
        admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "holder", "password": "password123",
                "email": "holder@example.com"
            }),
            content_type="application/json",
        )
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "retagger", "password": "password123",
                "email": "retagger@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"email": "holder@example.com"}),
            content_type="application/json",
        )
        assert response.status_code == 409

    def test_admin_update_same_email_is_allowed(self, admin_client):
        """Submitting the user's unchanged email is not a conflict."""
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "sameemail", "password": "password123",
                "email": "sameemail@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"email": "sameemail@example.com"}),
            content_type="application/json",
        )
        assert response.status_code == 200

    def test_admin_update_numeric_username_is_rejected(self, admin_client):
        """A numeric username must be a 400, not an unhandled 500 on .strip()."""
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "numrename", "password": "password123",
                "email": "numrename@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"username": 123}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_admin_update_numeric_email_is_rejected(self, admin_client):
        """A numeric email must be a 400, not an unhandled 500 on .strip()."""
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "nummail", "password": "password123",
                "email": "nummail@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"email": 42}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_create_user_numeric_username_is_rejected(self, admin_client):
        """A numeric username on create must be a 400, not an unhandled 500."""
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": 7, "password": "password123",
                "email": "numuser@example.com"
            }),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_create_user_numeric_email_is_rejected(self, admin_client):
        """A numeric email on create must be a 400, not an unhandled 500 on .strip()."""
        response = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "numaddress", "password": "password123",
                "email": 9
            }),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_admin_reset_numeric_password_is_rejected(self, admin_client):
        """A numeric reset password must be a 400, not an unhandled 500 on len()."""
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "numpass", "password": "password123",
                "email": "numpass@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.post(
            f"/api/admin/users/{user_id}/reset",
            data=json.dumps({"password": 123}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_admin_update_blank_username_is_rejected(self, admin_client):
        """Whitespace-only usernames are rejected the same way as null."""
        create_resp = admin_client.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "blankuser", "password": "password123",
                "email": "blankuser@example.com"
            }),
            content_type="application/json",
        )
        user_id = json.loads(create_resp.data)["id"]

        response = admin_client.put(
            f"/api/admin/users/{user_id}",
            data=json.dumps({"username": "   "}),
            content_type="application/json",
        )
        assert response.status_code == 400


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

    def test_update_preferences_requires_json(self, admin_client):
        """PUT preferences with a non-JSON body is rejected."""
        response = admin_client.put(
            "/api/users/me/preferences", data="x", content_type="text/plain"
        )
        assert response.status_code == 400
        assert json.loads(response.data)["code"] == "INVALID_CONTENT_TYPE"

    def test_update_preferences_null_value(self, admin_client):
        """A null document_sort must be a 400, not an unhandled 500 on .strip()."""
        response = admin_client.put(
            "/api/users/me/preferences",
            data=json.dumps({"document_sort": None}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_update_preferences_non_string_value(self, admin_client):
        """A numeric document_sort must be rejected as a client error."""
        response = admin_client.put(
            "/api/users/me/preferences",
            data=json.dumps({"document_sort": 5}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_update_preferences_missing_value(self, admin_client):
        """An empty document_sort is rejected as required."""
        response = admin_client.put(
            "/api/users/me/preferences",
            data=json.dumps({"document_sort": "   "}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert "required" in json.loads(response.data)["error"].lower()


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

    def test_backup_empty_returns_valid_zip(self, admin_client):
        resp = admin_client.get("/api/admin/backup")
        assert resp.status_code == 200
        import zipfile
        import io
        zf = zipfile.ZipFile(io.BytesIO(resp.data))
        assert len(zf.filelist) == 0

    def test_backup_includes_all_documents(self, admin_client):
        for i in range(5):
            admin_client.post(
                "/api/documents",
                data=json.dumps({"name": f"backup_doc_{i}"}),
                content_type="application/json",
            )
        resp = admin_client.get("/api/admin/backup")
        assert resp.status_code == 200
        import zipfile
        import io
        zf = zipfile.ZipFile(io.BytesIO(resp.data))
        yaml_names = [n for n in zf.filelist if n.filename.endswith(".yaml")]
        assert len(yaml_names) == 5

    def test_backup_pagination(self, admin_client):
        for i in range(250):
            admin_client.post(
                "/api/documents",
                data=json.dumps({"name": f"page_doc_{i}"}),
                content_type="application/json",
            )
        resp = admin_client.get("/api/admin/backup")
        assert resp.status_code == 200
        import zipfile
        import io
        zf = zipfile.ZipFile(io.BytesIO(resp.data))
        yaml_names = [n for n in zf.filelist if n.filename.endswith(".yaml")]
        assert len(yaml_names) == 250


class TestAuthSecurity:
    """Tests for auth security hardening."""

    def test_admin_password_from_env_var(self, monkeypatch, pg_dsn):
        """OVERSOLVED_ADMIN_PASSWORD env var sets admin password."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "custom-admin-pass")
        app = create_app({
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
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

    def test_admin_password_env_var_wrong_password(self, monkeypatch, pg_dsn):
        """Wrong password against env-var-admin returns 401."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "custom-admin-pass")
        app = create_app({
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        })
        c = app.test_client()
        resp = c.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 401

    def test_session_cookie_secure_default(self, monkeypatch, pg_dsn):
        """session_token cookie does NOT have secure flag by default."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        app = create_app({
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
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

    def test_session_cookie_secure_enabled(self, monkeypatch, pg_dsn):
        """session_token cookie has secure flag when OVERSOLVED_SESSION_COOKIE_SECURE is True."""
        monkeypatch.setenv("OVERSOLVED_SESSION_COOKIE_SECURE", "true")
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        app = create_app({
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
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
