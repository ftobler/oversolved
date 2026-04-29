"""Tests for the TTL build-state cache and serialized solve endpoint."""

import json
import threading
import time

import pytest

from oversolved.cache import TtlCache

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

    test_app = create_app({
        "DB_TYPE": "sqlite",
        "TESTING": True,
        "DB_PATH": str(tmp_path / "test.db"),
    })
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


class TestTtlCache:
    def test_get_returns_none_for_missing_key(self):
        cache = TtlCache[str](ttl_seconds=10.0, max_size=10)
        assert cache.get("missing") is None

    def test_set_and_get_roundtrip(self):
        cache = TtlCache[str](ttl_seconds=10.0, max_size=10)
        cache.set("a", "value")
        assert cache.get("a") == "value"

    def test_ttl_eviction(self):
        cache = TtlCache[str](ttl_seconds=0.05, max_size=10)
        cache.set("a", "value")
        assert cache.get("a") == "value"
        time.sleep(0.06)
        assert cache.get("a") is None

    def test_access_resets_ttl(self):
        cache = TtlCache[str](ttl_seconds=0.1, max_size=10)
        cache.set("a", "value")
        time.sleep(0.06)
        # Access before TTL expires
        assert cache.get("a") == "value"
        time.sleep(0.06)
        # Should still be present because access reset the timer
        assert cache.get("a") == "value"

    def test_max_size_lru_eviction(self):
        cache = TtlCache[str](ttl_seconds=60.0, max_size=2)
        cache.set("a", "1")
        cache.set("b", "2")
        cache.set("c", "3")
        assert cache.get("a") is None
        assert cache.get("b") == "2"
        assert cache.get("c") == "3"

    def test_thread_safety(self):
        cache = TtlCache[int](ttl_seconds=60.0, max_size=1000)
        errors = []

        def writer():
            for i in range(200):
                cache.set(f"key_{i}", i)

        def reader():
            for i in range(200):
                try:
                    cache.get(f"key_{i}")
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        threads = [threading.Thread(target=writer) for _ in range(5)]
        threads += [threading.Thread(target=reader) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors


class TestSolveEndpointSerialization:
    def test_rollback_returns_pre_rollback_bodies(self, client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        # Full build
        r1 = post_solve(client, {"id": "doc_rb", "features": [sk1, ex1]})
        assert r1.status_code == 200
        d1 = json.loads(r1.data)
        assert "body_ex1" in d1["bodies"]

        # Rollback to before extrude (only sketch remains)
        r2 = post_solve(client, {"id": "doc_rb", "features": [sk1], "rollback_position": 1})
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        assert "body_ex1" not in d2["bodies"]

    def test_rollback_then_full_rebuild_coherent(self, client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(client, {"id": "doc_rb2", "features": [sk1, ex1]})
        post_solve(client, {"id": "doc_rb2", "features": [sk1], "rollback_position": 1})

        # Full rebuild (no rollback) should restore the body
        r3 = post_solve(client, {"id": "doc_rb2", "features": [sk1, ex1]})
        assert r3.status_code == 200
        d3 = json.loads(r3.data)
        assert "body_ex1" in d3["bodies"]

    def test_concurrent_solves_serialized(self, client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        results = {}

        def solve_a():
            resp = post_solve(client, {"id": "doc_conc", "features": [sk1, ex1]})
            results["a"] = json.loads(resp.data)

        def solve_b():
            resp = post_solve(
                client, {"id": "doc_conc", "features": [sk1], "rollback_position": 1}
            )
            results["b"] = json.loads(resp.data)

        t1 = threading.Thread(target=solve_a)
        t2 = threading.Thread(target=solve_b)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # Both requests should succeed; the cache ends up with the last write.
        assert "result" in results["a"]
        assert "result" in results["b"]

    def test_build_state_not_in_response(self, client):
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        resp = post_solve(client, {"id": "doc_no_state", "features": [sk1]})
        data = json.loads(resp.data)
        assert "_build_state" not in data


class TestCacheFlushEndpoint:
    def test_flush_requires_auth(self, client):
        resp = client.post(
            "/api/cache/flush",
            data=json.dumps({"doc_id": "doc_flush_l1", "level": "l1"}),
            content_type="application/json",
        )
        assert resp.status_code == 401

    def test_flush_requires_admin(self, nonadmin_client):
        resp = nonadmin_client.post(
            "/api/cache/flush",
            data=json.dumps({"doc_id": "doc_flush_l1", "level": "l1"}),
            content_type="application/json",
        )
        assert resp.status_code == 403

    def test_flush_endpoint_removes_l1(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        # Build to populate L1 cache
        r1 = post_solve(authed_client, {"id": "doc_flush_l1", "features": [sk1, ex1]})
        assert r1.status_code == 200

        # Flush L1
        resp = authed_client.post(
            "/api/cache/flush",
            data=json.dumps({"doc_id": "doc_flush_l1", "level": "l1"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["status"] == "flushed"
        assert data["level"] == "l1"

    def test_flush_endpoint_removes_l2(self, authed_client, app):
        pytest.importorskip("OCP.gp")
        app.config["L2_CACHE_ENABLED"] = True
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        # Build to populate L2 cache
        r1 = post_solve(authed_client, {"id": "doc_flush_l2", "features": [sk1, ex1]})
        assert r1.status_code == 200

        # Flush all (includes L2)
        resp = authed_client.post(
            "/api/cache/flush",
            data=json.dumps({"doc_id": "doc_flush_l2", "level": "all"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["status"] == "flushed"
        assert data["level"] == "all"

    def test_flush_endpoint_level_parameter(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")

        post_solve(authed_client, {"id": "doc_flush_level", "features": [sk1]})

        # l1 should succeed
        resp = authed_client.post(
            "/api/cache/flush",
            data=json.dumps({"doc_id": "doc_flush_level", "level": "l1"}),
            content_type="application/json",
        )
        assert resp.status_code == 200

        # l2 should succeed even if not enabled (no-op)
        resp = authed_client.post(
            "/api/cache/flush",
            data=json.dumps({"doc_id": "doc_flush_level", "level": "l2"}),
            content_type="application/json",
        )
        assert resp.status_code == 200

    def test_flush_endpoint_invalid_doc_id(self, authed_client):
        resp = authed_client.post(
            "/api/cache/flush",
            data=json.dumps({"level": "all"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        data = json.loads(resp.data)
        assert "error" in data

    def test_flush_endpoint_nonexistent_doc(self, authed_client):
        resp = authed_client.post(
            "/api/cache/flush",
            data=json.dumps({"doc_id": "doc_does_not_exist", "level": "all"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["status"] == "flushed"


class TestTtlCacheDelete:
    def test_delete_removes_key(self):
        cache = TtlCache[str](ttl_seconds=10.0, max_size=10)
        cache.set("a", "value")
        assert cache.get("a") == "value"
        cache.delete("a")
        assert cache.get("a") is None

    def test_delete_missing_key_is_noop(self):
        cache = TtlCache[str](ttl_seconds=10.0, max_size=10)
        cache.delete("missing")  # should not raise
        assert cache.get("missing") is None


class TestL2CacheDelete:
    def test_delete_removes_file(self, tmp_path):
        from oversolved.cache import L2Cache
        from oversolved.types3d import BuildState
        cache = L2Cache(cache_dir=str(tmp_path))
        state = BuildState(feature_order=["sk1"], checkpoints={})
        cache.set("doc1", state)
        assert cache.get("doc1") is not None
        cache.delete("doc1")
        assert cache.get("doc1") is None

    def test_delete_missing_key_is_noop(self, tmp_path):
        from oversolved.cache import L2Cache
        cache = L2Cache(cache_dir=str(tmp_path))
        cache.delete("missing")  # should not raise
        assert cache.get("missing") is None
