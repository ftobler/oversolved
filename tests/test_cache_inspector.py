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
def app(tmp_path):
    from oversolved.app import create_app

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


class TestInspectEndpoint:
    def test_inspect_endpoint_returns_empty_when_no_cache(self, client):
        resp = client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["l1"] == []
        assert data["l2"] == []

    def test_inspect_endpoint_returns_l1_entries(self, client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(client, {"id": "doc_inspect_l1", "features": [sk1, ex1]})

        resp = client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        l1_ids = [e["doc_id"] for e in data["l1"]]
        assert "doc_inspect_l1" in l1_ids

    def test_inspect_endpoint_returns_l2_entries(self, client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(client, {"id": "doc_inspect_l2", "features": [sk1, ex1]})

        resp = client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        l2_ids = [e["doc_id"] for e in data["l2"]]
        assert "doc_inspect_l2" in l2_ids

    def test_inspect_endpoint_includes_stats(self, client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")

        post_solve(client, {"id": "doc_stats", "features": [sk1]})

        resp = client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["l1"]) > 0
        l1 = data["l1"][0]
        assert "feature_order" in l1
        assert "checkpoint_count" in l1
        assert "accessed_at" in l1
        assert "shape_size_estimate" in l1

    def test_inspect_l2_entry_returns_json(self, client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(client, {"id": "doc_l2_preview", "features": [sk1, ex1]})

        resp = client.get("/api/cache/inspect/l2/doc_l2_preview")
        assert resp.status_code == 200
        text = resp.data.decode("utf-8")
        assert "feature_order" in text

    def test_inspect_l2_entry_404_missing(self, client):
        resp = client.get("/api/cache/inspect/l2/nonexistent")
        assert resp.status_code == 404

    def test_inspect_l2_entry_disabled_l2(self, client, app):
        app.config["L2_CACHE_ENABLED"] = False
        resp = client.get("/api/cache/inspect/l2/some_doc")
        assert resp.status_code == 400

    def test_download_l2_entry_streams_file(self, client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(client, {"id": "doc_dl", "features": [sk1, ex1]})

        resp = client.get("/api/cache/download/doc_dl")
        assert resp.status_code == 200
        assert resp.headers.get("Content-Disposition", "").startswith("attachment")

    def test_download_l2_entry_404_missing(self, client):
        resp = client.get("/api/cache/download/nonexistent")
        assert resp.status_code == 404

    def test_download_l2_entry_disabled_l2(self, client, app):
        app.config["L2_CACHE_ENABLED"] = False
        resp = client.get("/api/cache/download/some_doc")
        assert resp.status_code == 400


class TestInspectWithDirectL2:
    def test_inspect_l2_includes_metadata(self, tmp_path):
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

        resp = client.get("/api/cache/inspect")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        l2 = data["l2"]
        assert len(l2) == 1
        assert l2[0]["doc_id"] == "doc_meta"
        assert l2[0]["file_size"] > 0
        assert "created_at" in l2[0]
        assert "modified_at" in l2[0]
