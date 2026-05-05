"""Tests for cache inspector endpoints."""

import json

import pytest

from solver_helpers import extrude_spec, rect_sketch_spec


def post_solve(client, payload):
    return client.post(
        "/api/solve",
        data=json.dumps(payload),
        content_type="application/json",
    )


@pytest.fixture
def app(tmp_path, monkeypatch):
    from oversolved.app import create_app

    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app(
        {
            "DB_TYPE": "sqlite",
            "TESTING": True,
            "DB_PATH": str(tmp_path / "test.db"),
        }
    )
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def authed_client(app):
    """Create a test client logged in as admin."""
    client = app.test_client()
    response = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return client


@pytest.fixture
def nonadmin_client(app):
    """Create a test client logged in as non-admin user."""
    client = app.test_client()
    # Create user via admin
    admin = app.test_client()
    admin.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    admin.post(
        "/api/admin/users",
        data=json.dumps({"username": "user1", "password": "user1", "email": "user1@example.com"}),
        content_type="application/json",
    )
    # Login as that user
    response = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "user1", "password": "user1"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return client


class TestAuthRequired:
    """Tests that cache endpoints require admin auth."""

    def test_inspect_requires_auth(self, client):
        resp = client.get("/api/cache/inspect")
        assert resp.status_code == 401

    def test_inspect_requires_admin(self, nonadmin_client):
        resp = nonadmin_client.get("/api/cache/inspect")
        assert resp.status_code == 403


class TestInspectEndpoint:
    def test_inspect_endpoint_returns_empty_when_no_cache(self, authed_client):
        resp = authed_client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["l1"] == []

    def test_inspect_endpoint_returns_l1_entries(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(authed_client, {"id": "doc_inspect_l1", "features": [sk1, ex1]})

        resp = authed_client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        l1_ids = [e["doc_id"] for e in data["l1"]]
        assert "doc_inspect_l1" in l1_ids

    def test_inspect_endpoint_includes_stats(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")

        post_solve(authed_client, {"id": "doc_stats", "features": [sk1]})

        resp = authed_client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["l1"]) > 0
        l1 = data["l1"][0]
        assert "feature_order" in l1
        assert "checkpoint_count" in l1
        assert "accessed_at" in l1
        assert "shape_size_estimate" in l1
