"""GET /api/auth/me must enforce the same active-account gate as @require_auth.

Deactivation does not delete sessions, so a hand-rolled session->user lookup
let a deactivated user get 200 + full payload from /me while every decorated
route 401'd; the frontend bootstraps login state from /me.
"""

import json
import psycopg2
from werkzeug.security import generate_password_hash

_ME_USER_KEYS = {
    "id",
    "username",
    "email",
    "must_change_password",
    "is_admin",
    "is_active",
    "last_login_at",
}


def _create_and_login(app, username):
    """Insert a fresh user and return (client with valid session cookie, id)."""
    conn = psycopg2.connect(app.config["DB_DSN"])
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (username, password_hash, must_change_password)"
            " VALUES (%s, %s, %s) RETURNING id",
            (username, generate_password_hash("pass"), 0),
        )
        user_id = cur.fetchone()[0]
    conn.close()

    client = app.test_client()
    r = client.post(
        "/api/auth/login",
        data=json.dumps({"username": username, "password": "pass"}),
        content_type="application/json",
    )
    assert r.status_code == 200
    return client, user_id


def _set_active(app, user_id, active):
    conn = psycopg2.connect(app.config["DB_DSN"])
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("UPDATE users SET is_active = %s WHERE id = %s", (active, user_id))
    conn.close()


class TestMeActiveGate:
    def test_deactivated_user_gets_401_from_me(self, app):
        client, user_id = _create_and_login(app, "me_deactivated_user")
        # The session cookie stays technically valid across deactivation.
        _set_active(app, user_id, 0)

        r = client.get("/api/auth/me")
        assert r.status_code == 401
        assert json.loads(r.data)["code"] == "UNAUTHORIZED"

    def test_active_user_gets_200_with_documented_payload(self, app):
        client, _user_id = _create_and_login(app, "me_active_user")

        r = client.get("/api/auth/me")
        assert r.status_code == 200
        data = json.loads(r.data)
        assert set(data.keys()) == {"user"}
        assert set(data["user"].keys()) == _ME_USER_KEYS
