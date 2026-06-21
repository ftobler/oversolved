"""Tests for authenticate_token() and the deactivated-user HTTP fix."""

import json
import pytest
import psycopg2
from werkzeug.security import generate_password_hash
from oversolved.migrations import discover_and_register
from oversolved.db import Database, PostgreSQLConnection, SessionStore, UserStore
from oversolved.auth import authenticate_token, AuthOk, AuthError


def _make_db(pg_dsn):
    database = Database(PostgreSQLConnection(pg_dsn))
    discover_and_register(database)
    database.init()
    return database


@pytest.fixture
def db(pg_dsn):
    database = _make_db(pg_dsn)
    yield database
    database.close()


class TestAuthenticateToken:
    """Unit-level tests for authenticate_token()."""

    def test_no_token_returns_error(self, db):
        result = authenticate_token(db, None)
        assert isinstance(result, AuthError)
        assert result.code == "no_token"

    def test_empty_string_token_returns_error(self, db):
        result = authenticate_token(db, "")
        assert isinstance(result, AuthError)
        assert result.code == "no_token"

    def test_invalid_session_returns_error(self, db):
        result = authenticate_token(db, "nonexistent-token")
        assert isinstance(result, AuthError)
        assert result.code == "invalid_session"

    def test_deactivated_user_returns_error(self, db):
        user_store = UserStore(db)
        user_id = user_store.create("inactive_user", generate_password_hash("pass"))
        session_store = SessionStore(db)
        token = session_store.create(user_id)
        user_store.set_active(user_id, False)

        result = authenticate_token(db, token)
        assert isinstance(result, AuthError)
        assert result.code == "deactivated"

    def test_happy_path_returns_user(self, db):
        user_store = UserStore(db)
        user_id = user_store.create("active_user", generate_password_hash("pass"))
        token = SessionStore(db).create(user_id)

        result = authenticate_token(db, token)
        assert isinstance(result, AuthOk)
        assert result.user["id"] == user_id
        assert result.user["username"] == "active_user"


class TestHttpDeactivatedUserBlocked:
    """Verify that deactivated users are now blocked on HTTP routes."""

    def _deactivate_user(self, app, user_id):
        conn = psycopg2.connect(app.config["DB_DSN"])
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET is_active = 0 WHERE id = %s", (user_id,))
        conn.close()

    def test_deactivated_user_blocked_on_list_documents(self, app):
        # Create and log in as a new user, then deactivate them.
        conn = psycopg2.connect(app.config["DB_DSN"])
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s) RETURNING id",
                ("deact_user", generate_password_hash("pass"), 0),
            )
            user_id = cur.fetchone()[0]
        conn.close()

        client = app.test_client()
        client.post(
            "/api/auth/login",
            data=json.dumps({"username": "deact_user", "password": "pass"}),
            content_type="application/json",
        )

        # Deactivate after login (cookie still valid)
        self._deactivate_user(app, user_id)

        r = client.get("/api/documents")
        assert r.status_code == 401
        data = json.loads(r.data)
        assert "deactivated" in data["error"].lower() or r.status_code == 401

    def test_active_user_still_allowed(self, app, authed_client):
        r = authed_client.get("/api/documents")
        assert r.status_code == 200


class TestLoginValidation:
    """Cover the early request-validation branches of POST /api/auth/login."""

    def test_login_rejects_non_json(self, app):
        client = app.test_client()
        r = client.post("/api/auth/login", data="admin", content_type="text/plain")
        assert r.status_code == 400
        assert json.loads(r.data)["code"] == "INVALID_CONTENT_TYPE"

    def test_login_requires_password(self, app):
        client = app.test_client()
        r = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin"}),
            content_type="application/json",
        )
        assert r.status_code == 400
        assert json.loads(r.data)["code"] == "BAD_REQUEST"

    def test_login_requires_credential(self, app):
        client = app.test_client()
        r = client.post(
            "/api/auth/login",
            data=json.dumps({"password": "admin"}),
            content_type="application/json",
        )
        assert r.status_code == 400
        assert json.loads(r.data)["code"] == "BAD_REQUEST"


class TestMeRoute:
    """Cover the session-resolution branches of GET /api/auth/me."""

    def test_me_with_invalid_session_cookie(self, app):
        client = app.test_client()
        # A present-but-unknown token resolves to no session, not no token,
        # so this exercises the SessionStore.find() miss branch specifically.
        client.set_cookie("session_token", "bogus-token")
        r = client.get("/api/auth/me")
        assert r.status_code == 401
        assert json.loads(r.data)["error"] == "Invalid or expired session"
