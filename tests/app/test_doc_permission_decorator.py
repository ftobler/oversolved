"""Tests for @require_doc_permission decorator and its application across routes."""

import json
import pytest
import psycopg2
from werkzeug.security import generate_password_hash
from oversolved.app import create_app
from oversolved.db import Database, PostgreSQLConnection, DocumentStore, UserStore


def _make_db(pg_dsn):
    from oversolved.migrations import discover_and_register
    database = Database(PostgreSQLConnection(pg_dsn))
    discover_and_register(database)
    database.init()
    return database


@pytest.fixture
def app(pg_dsn, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    return create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})


@pytest.fixture
def authed_client(app):
    client = app.test_client()
    r = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert r.status_code == 200
    return client


def _create_user(app, username, password):
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
    client.post(
        "/api/auth/login",
        data=json.dumps({"username": username, "password": password}),
        content_type="application/json",
    )
    return client


def _create_doc(authed_client, name="TestDoc"):
    r = authed_client.post(
        "/api/documents",
        data=json.dumps({"name": name}),
        content_type="application/json",
    )
    assert r.status_code == 201
    return json.loads(r.data)["uuid"]


class TestPermissionDecoratorUnit:
    """Unit tests for _permission_at_least helper."""

    def test_none_always_fails(self):
        from oversolved.blueprints import _permission_at_least
        assert _permission_at_least(None, "view") is False
        assert _permission_at_least(None, "edit") is False
        assert _permission_at_least(None, "owner") is False

    def test_view_only_passes_view(self):
        from oversolved.blueprints import _permission_at_least
        assert _permission_at_least("view", "view") is True
        assert _permission_at_least("view", "edit") is False
        assert _permission_at_least("view", "owner") is False

    def test_edit_passes_view_and_edit(self):
        from oversolved.blueprints import _permission_at_least
        assert _permission_at_least("edit", "view") is True
        assert _permission_at_least("edit", "edit") is True
        assert _permission_at_least("edit", "owner") is False

    def test_owner_passes_all(self):
        from oversolved.blueprints import _permission_at_least
        assert _permission_at_least("owner", "view") is True
        assert _permission_at_least("owner", "edit") is True
        assert _permission_at_least("owner", "owner") is True


class TestDecoratorIntegration:
    """Integration tests for the decorator via real HTTP routes."""

    def test_missing_doc_returns_404(self, app, authed_client):
        r = authed_client.get("/api/documents/00000000-0000-0000-0000-000000000000")
        assert r.status_code == 404

    def test_view_user_blocked_on_owner_route(self, app, authed_client):
        _create_user(app, "viewer", "viewpass")
        uuid = _create_doc(authed_client)
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "viewer", "permission": "view"}),
            content_type="application/json",
        )

        viewer = _login(app, "viewer", "viewpass")
        # PATCH rename requires "owner" - view user must get 403
        r = viewer.patch(
            f"/api/documents/{uuid}",
            data=json.dumps({"name": "Renamed"}),
            content_type="application/json",
        )
        assert r.status_code == 403

    def test_edit_user_blocked_on_owner_route(self, app, authed_client):
        _create_user(app, "editor", "editpass")
        uuid = _create_doc(authed_client)
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "editor", "permission": "edit"}),
            content_type="application/json",
        )

        editor = _login(app, "editor", "editpass")
        r = editor.patch(
            f"/api/documents/{uuid}",
            data=json.dumps({"name": "Renamed"}),
            content_type="application/json",
        )
        assert r.status_code == 403

    def test_owner_passes_edit_level_route(self, app, authed_client):
        _create_user(app, "editor", "editpass")
        uuid = _create_doc(authed_client)
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "editor", "permission": "edit"}),
            content_type="application/json",
        )

        editor = _login(app, "editor", "editpass")
        r = editor.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 2\n"}),
            content_type="application/json",
        )
        assert r.status_code == 200

    def test_view_allows_public_doc(self, app, authed_client):
        _create_user(app, "stranger", "stpass")
        uuid = _create_doc(authed_client)
        # Make public
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({}),
            content_type="application/json",
        )

        stranger = _login(app, "stranger", "stpass")
        r = stranger.get(f"/api/documents/{uuid}")
        assert r.status_code == 200
        data = json.loads(r.data)
        assert data["permission"] == "view"

    def test_stranger_blocked_on_private_doc(self, app, authed_client):
        _create_user(app, "stranger", "stpass")
        uuid = _create_doc(authed_client)

        stranger = _login(app, "stranger", "stpass")
        r = stranger.get(f"/api/documents/{uuid}")
        assert r.status_code == 403

    def test_g_document_populated(self, app, authed_client):
        uuid = _create_doc(authed_client, name="PopulatedDoc")
        r = authed_client.get(f"/api/documents/{uuid}")
        assert r.status_code == 200
        data = json.loads(r.data)
        assert data["name"] == "PopulatedDoc"
        assert data["permission"] == "owner"

    def test_rebuild_stats_requires_view_permission(self, app, authed_client):
        _create_user(app, "stranger2", "stpass2")
        uuid = _create_doc(authed_client)

        stranger = _login(app, "stranger2", "stpass2")
        r = stranger.get(f"/api/documents/{uuid}/rebuild-stats")
        assert r.status_code == 403

    def test_rebuild_stats_accessible_to_view_user(self, app, authed_client):
        _create_user(app, "viewer2", "viewpass2")
        uuid = _create_doc(authed_client)
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "viewer2", "permission": "view"}),
            content_type="application/json",
        )

        viewer = _login(app, "viewer2", "viewpass2")
        r = viewer.get(f"/api/documents/{uuid}/rebuild-stats")
        assert r.status_code == 200

    def test_rebuild_stats_missing_doc_returns_404(self, app, authed_client):
        r = authed_client.get("/api/documents/00000000-0000-0000-0000-000000000000/rebuild-stats")
        assert r.status_code == 404


class TestRouteRegressionMatrix:
    """Regression matrix: verify authorization behaves identically to before refactor."""

    def setup_method(self):
        self._uuid = None

    def _setup(self, app, authed_client):
        _create_user(app, "regrviewer", "p")
        _create_user(app, "regreditor", "p")
        uuid = _create_doc(authed_client, "RegrDoc")
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "regrviewer", "permission": "view"}),
            content_type="application/json",
        )
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "regreditor", "permission": "edit"}),
            content_type="application/json",
        )
        return uuid

    @pytest.mark.parametrize("role,expected", [
        ("owner", 200),
        ("regrviewer", 403),
        ("regreditor", 403),
    ])
    def test_rename_authz(self, app, authed_client, role, expected):
        uuid = self._setup(app, authed_client)
        if role == "owner":
            client = authed_client
        else:
            client = _login(app, role, "p")
        r = client.patch(
            f"/api/documents/{uuid}",
            data=json.dumps({"name": "NewName"}),
            content_type="application/json",
        )
        assert r.status_code == expected

    @pytest.mark.parametrize("role,expected", [
        ("owner", 200),
        ("regrviewer", 200),
        ("regreditor", 200),
    ])
    def test_get_document_authz(self, app, authed_client, role, expected):
        uuid = self._setup(app, authed_client)
        if role == "owner":
            client = authed_client
        else:
            client = _login(app, role, "p")
        r = client.get(f"/api/documents/{uuid}")
        assert r.status_code == expected

    @pytest.mark.parametrize("role,expected", [
        ("owner", 200),
        ("regrviewer", 403),
        ("regreditor", 200),
    ])
    def test_update_document_authz(self, app, authed_client, role, expected):
        uuid = self._setup(app, authed_client)
        if role == "owner":
            client = authed_client
        else:
            client = _login(app, role, "p")
        r = client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 2\n"}),
            content_type="application/json",
        )
        assert r.status_code == expected

    @pytest.mark.parametrize("role,expected", [
        ("owner", 200),
        ("regrviewer", 403),
        ("regreditor", 403),
    ])
    def test_delete_document_authz(self, app, authed_client, role, expected):
        uuid = self._setup(app, authed_client)
        if role == "owner":
            client = authed_client
        else:
            client = _login(app, role, "p")
        r = client.delete(f"/api/documents/{uuid}")
        assert r.status_code == expected
