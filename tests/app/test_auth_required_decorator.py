"""Tests for the composite @auth_required decorator.

The decorator replaced 32 hand-spelled `@require_auth` + `@require_csrf` (+
admin / doc permission / json) stacks. Collapsing them is only safe if the
composition preserves the ORDER of the checks, because the order decides which
failure a caller is told about: a request that is both unauthenticated and
malformed must answer 401, not 400. Every test here pins one adjacent pair of
that order, so a reshuffle inside `auth_required` fails loudly.
"""

import json
import pytest
import psycopg2
from flask import Flask, jsonify
from werkzeug.security import generate_password_hash
from oversolved.blueprints import auth_required


def _create_user(app, username, password):
    """A plain non-admin user. `authed_client` is already the admin."""
    conn = psycopg2.connect(app.config["DB_DSN"])
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s)",
            (username, generate_password_hash(password), 0),
        )
    conn.close()


def _login(app, username, password):
    client = app.test_client()
    r = client.post(
        "/api/auth/login",
        data=json.dumps({"username": username, "password": password}),
        content_type="application/json",
    )
    assert r.status_code == 200
    return client


def _create_doc(authed_client, name="TestDoc"):
    r = authed_client.post(
        "/api/documents",
        data=json.dumps({"name": name}),
        content_type="application/json",
    )
    assert r.status_code == 201
    return json.loads(r.data)["uuid"]


class TestComposition:
    """Structural properties of the returned wrapper, independent of any request."""

    def test_endpoint_name_survives_every_layer(self):
        """Flask derives the endpoint name from __name__, so a broken @wraps chain
        would silently collapse two routes onto one endpoint."""
        @auth_required(admin=True, doc="edit", json=True)
        def my_view(uuid):
            return jsonify({"ok": True})

        assert my_view.__name__ == "my_view"

    def test_bare_call_actually_wraps(self):
        """`@auth_required()` with no options is the most common form. Registering
        is not enough: it must WRAP, so a session-less request never reaches the
        view. Returning `f` untouched would pass a mere registration check."""
        app = Flask(__name__)
        app.config["TESTING"] = True
        app.config["_DB_CONFIG"] = {"type": "sqlite", "path": ":memory:"}
        reached = []

        @app.route("/probe", methods=["GET"])
        @auth_required()
        def probe():
            reached.append(True)
            return jsonify({"ok": True})

        assert app.test_client().get("/probe").status_code == 401
        assert reached == []

    def test_doc_url_var_without_doc_is_refused(self):
        """A `doc_url_var=` with no `doc=` would enforce nothing at all, silently.
        That is a dropped argument, not a configuration."""
        with pytest.raises(ValueError):
            auth_required(doc_url_var="doc_id")


class TestCheckOrder:
    """Each test drives a request that fails TWO checks at once and asserts which
    of the two answered, which is exactly what the ordering decides."""

    def test_auth_precedes_json(self, client):
        """No session AND a non-JSON body: the session gate answers first."""
        r = client.post("/api/documents", data="not json", content_type="text/plain")
        assert r.status_code == 401
        assert r.get_json()["code"] == "UNAUTHORIZED"

    def test_auth_precedes_admin(self, client):
        """No session on an admin route: 401, never the 403 that would imply the
        request got as far as being identified."""
        r = client.get("/api/admin/users")
        assert r.status_code == 401
        assert r.get_json()["code"] == "UNAUTHORIZED"

    def test_auth_precedes_doc_permission(self, client, authed_client):
        """An unauthenticated caller must not be able to probe document existence."""
        uuid = _create_doc(authed_client)
        r = client.get(f"/api/documents/{uuid}")
        assert r.status_code == 401

    def test_admin_precedes_json(self, app):
        """Non-admin AND a non-JSON body on an admin route: 403, not 400. The
        content type of a request the caller may not make is not their business."""
        _create_user(app, "plain", "password123")
        client = _login(app, "plain", "password123")
        r = client.post("/api/admin/users", data="not json", content_type="text/plain")
        assert r.status_code == 403
        assert r.get_json()["code"] == "FORBIDDEN"

    def test_doc_permission_precedes_json(self, app, authed_client):
        """Someone else's document AND a non-JSON body: 403, not 400."""
        uuid = _create_doc(authed_client)
        _create_user(app, "outsider", "password123")
        other = _login(app, "outsider", "password123")
        r = other.put(f"/api/documents/{uuid}", data="not json", content_type="text/plain")
        assert r.status_code == 403

    def test_missing_document_precedes_json(self, app):
        """A document that does not exist answers 404 even when the body is junk."""
        _create_user(app, "somebody", "password123")
        client = _login(app, "somebody", "password123")
        r = client.put("/api/documents/no-such-uuid", data="not json", content_type="text/plain")
        assert r.status_code == 404


class TestChecksStillRun:
    """The order tests above all assert an EARLY check firing, so they would pass
    just as well if a later check had been dropped. These pin the later ones."""

    def test_json_enforced_once_everything_else_passes(self, authed_client):
        r = authed_client.post("/api/documents", data="not json", content_type="text/plain")
        assert r.status_code == 400
        assert r.get_json()["code"] == "INVALID_CONTENT_TYPE"

    def test_admin_enforced_for_a_plain_user(self, app):
        _create_user(app, "plain2", "password123")
        client = _login(app, "plain2", "password123")
        r = client.get("/api/admin/users")
        assert r.status_code == 403

    def test_doc_permission_enforced_for_an_outsider(self, app, authed_client):
        uuid = _create_doc(authed_client)
        _create_user(app, "outsider2", "password123")
        other = _login(app, "outsider2", "password123")
        assert other.get(f"/api/documents/{uuid}").status_code == 403

    def test_admin_route_still_serves_an_admin(self, authed_client):
        assert authed_client.get("/api/admin/users").status_code == 200

    def test_owner_still_reaches_their_own_document(self, authed_client):
        uuid = _create_doc(authed_client)
        assert authed_client.get(f"/api/documents/{uuid}").status_code == 200

    def test_doc_url_var_override_still_binds(self, authed_client):
        """`rebuild-stats` is the one route whose URL parameter is not `uuid`; the
        override has to survive the collapse or it 404s on a document that exists."""
        uuid = _create_doc(authed_client)
        assert authed_client.get(f"/api/documents/{uuid}/rebuild-stats").status_code == 200

    def _live_csrf_app(self, pg_dsn, monkeypatch):
        """An app with TESTING off, the only mode in which CSRF is observable."""
        from oversolved.app import create_app
        # Not the literal "admin": startup refuses the default password outside
        # of TESTING, which is exactly the mode this test needs.
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "not-the-default")
        return create_app({"DB_TYPE": "postgres", "TESTING": False, "DB_DSN": pg_dsn})

    def test_csrf_layer_is_present(self, pg_dsn, monkeypatch):
        """A mutating request without an Origin is refused once the session is
        accepted, which is the only proof CSRF is still in the stack at all."""
        app = self._live_csrf_app(pg_dsn, monkeypatch)
        client = app.test_client()
        r = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "not-the-default"}),
            content_type="application/json",
            headers={"Origin": "http://localhost"},
        )
        assert r.status_code == 200
        r = client.post(
            "/api/documents",
            data=json.dumps({"name": "NoOrigin"}),
            content_type="application/json",
        )
        assert r.status_code == 403
        assert r.get_json()["code"] == "CSRF_FAILED"

    def test_auth_precedes_csrf(self, pg_dsn, monkeypatch):
        """The one ordering pair the TESTING-mode fixtures are blind to, because
        CSRF self-exempts there. No session AND no Origin must answer 401: a 403
        would tell an unauthenticated caller the endpoint exists."""
        app = self._live_csrf_app(pg_dsn, monkeypatch)
        r = app.test_client().post(
            "/api/documents",
            data=json.dumps({"name": "NoSession"}),
            content_type="application/json",
        )
        assert r.status_code == 401
        assert r.get_json()["code"] == "UNAUTHORIZED"
