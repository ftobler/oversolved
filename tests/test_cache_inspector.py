"""Tests for cache inspector endpoints."""

import json

import pytest

from oversolved.cache import L2Cache
from oversolved.types3d import BuildState

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
            "L2_CACHE_ENABLED": True,
            "L2_CACHE_DIR": str(tmp_path / "l2_cache"),
            "L2_CACHE_MAX_SIZE": 1024 * 1024 * 1024,
            "L2_CACHE_TTL": 86400 * 30,
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

    def test_inspect_l2_requires_auth(self, client):
        resp = client.get("/api/cache/inspect/l2/some_doc")
        assert resp.status_code == 401

    def test_inspect_l2_requires_admin(self, nonadmin_client):
        resp = nonadmin_client.get("/api/cache/inspect/l2/some_doc")
        assert resp.status_code == 403

    def test_download_requires_auth(self, client):
        resp = client.get("/api/cache/download/some_doc")
        assert resp.status_code == 401

    def test_download_requires_admin(self, nonadmin_client):
        resp = nonadmin_client.get("/api/cache/download/some_doc")
        assert resp.status_code == 403


class TestInspectEndpoint:
    def test_inspect_endpoint_returns_empty_when_no_cache(self, authed_client):
        resp = authed_client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["l1"] == []
        assert data["l2"] == []

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

    def test_inspect_endpoint_returns_l2_entries(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(authed_client, {"id": "doc_inspect_l2", "features": [sk1, ex1]})

        resp = authed_client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        l2_ids = [e["doc_id"] for e in data["l2"]]
        assert "doc_inspect_l2" in l2_ids

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

    def test_inspect_l2_entry_returns_json(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(authed_client, {"id": "doc_l2_preview", "features": [sk1, ex1]})

        resp = authed_client.get("/api/cache/inspect/l2/doc_l2_preview")
        assert resp.status_code == 200
        text = resp.data.decode("utf-8")
        assert "feature_order" in text

    def test_inspect_l2_entry_404_missing(self, authed_client):
        resp = authed_client.get("/api/cache/inspect/l2/nonexistent")
        assert resp.status_code == 404

    def test_inspect_l2_entry_truncation_returns_valid_json(self, tmp_path, monkeypatch):
        """Large L2 entries should return a valid truncated preview, not broken JSON."""
        pytest.importorskip("OCP.gp")
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        cache_dir = tmp_path / "l2_trunc"

        from oversolved.app import create_app
        app = create_app(
            {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": str(tmp_path / "test_trunc.db"),
                "L2_CACHE_ENABLED": True,
                "L2_CACHE_DIR": str(cache_dir),
            }
        )
        # Store a large entry directly in the app's L2 cache via app config
        from oversolved.cache import L2Cache
        from oversolved.types3d import BuildState, FeatureCheckpoint

        cache = L2Cache(
            ttl_seconds=86400 * 30,
            max_size=1024 * 1024,
            cache_dir=str(cache_dir),
        )
        checkpoints = {}
        for i in range(500):
            checkpoints[f"cp_{i}"] = FeatureCheckpoint(
                spec={"type": "sketch", "id": f"sk{i}"},
                result={},
                repo_snapshot={},
                body_store_snapshot={},
            )
        state = BuildState(feature_order=["sk1"], checkpoints=checkpoints)
        cache.set("doc_trunc", state)

        client = app.test_client()
        client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )

        resp = client.get("/api/cache/inspect/l2/doc_trunc")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data.get("truncated") is True
        assert "preview" in data
        assert isinstance(data["preview"], dict)

    def test_inspect_l2_entry_disabled_l2(self, authed_client, app):
        app.config["L2_CACHE_ENABLED"] = False
        resp = authed_client.get("/api/cache/inspect/l2/some_doc")
        assert resp.status_code == 400

    def test_download_l2_entry_streams_file(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(authed_client, {"id": "doc_dl", "features": [sk1, ex1]})

        resp = authed_client.get("/api/cache/download/doc_dl")
        assert resp.status_code == 200
        assert resp.headers.get("Content-Disposition", "").startswith("attachment")

    def test_download_l2_entry_404_missing(self, authed_client):
        resp = authed_client.get("/api/cache/download/nonexistent")
        assert resp.status_code == 404

    def test_download_l2_entry_disabled_l2(self, authed_client, app):
        app.config["L2_CACHE_ENABLED"] = False
        resp = authed_client.get("/api/cache/download/some_doc")
        assert resp.status_code == 400


class TestInspectWithDirectL2:
    def test_inspect_l2_includes_metadata(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        cache_dir = tmp_path / "l2_inspect"
        cache = L2Cache(
            ttl_seconds=86400 * 30,
            max_size=1024 * 1024,
            cache_dir=str(cache_dir),
        )
        state = BuildState(feature_order=["sk1"], checkpoints={})
        cache.set("doc_meta", state)

        from oversolved.app import create_app

        app = create_app(
            {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": str(tmp_path / "test.db"),
                "L2_CACHE_ENABLED": True,
                "L2_CACHE_DIR": str(cache_dir),
            }
        )
        client = app.test_client()
        # Login as admin
        response = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert response.status_code == 200

        resp = client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        l2 = data["l2"]
        assert len(l2) == 1
        assert l2[0]["doc_id"] == "doc_meta"
        assert l2[0]["file_size"] > 0
        assert "created_at" in l2[0]
        assert "modified_at" in l2[0]
