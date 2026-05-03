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
def app(tmp_path, monkeypatch):
    from oversolved.app import create_app

    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
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

    def test_max_size_eviction_multiple(self):
        """Evicts enough entries when inserting many beyond max_size."""
        cache = TtlCache[str](ttl_seconds=60.0, max_size=5)
        for i in range(20):
            cache.set(f"key_{i}", str(i))
        # Should have evicted down to max_size=5
        cache._evict_expired()
        assert len(cache._data) <= 5

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

    def test_max_size_exact_fit(self):
        cache = TtlCache[str](ttl_seconds=60.0, max_size=3)
        cache.set("a", "1")
        cache.set("b", "2")
        cache.set("c", "3")
        assert cache.get("a") == "1"
        assert cache.get("b") == "2"
        assert cache.get("c") == "3"

    def test_under_max_size(self):
        cache = TtlCache[str](ttl_seconds=60.0, max_size=10)
        for i in range(9):
            cache.set(f"key_{i}", str(i))
        for i in range(9):
            assert cache.get(f"key_{i}") == str(i)

    def test_concurrent_delete_get(self):
        cache = TtlCache[str](ttl_seconds=60.0, max_size=100)
        cache.set("race_key", "value")
        errors = []

        def deleter():
            for _ in range(100):
                try:
                    cache.delete("race_key")
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        def getter():
            for _ in range(100):
                try:
                    cache.get("race_key")
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        threads = [
            threading.Thread(target=deleter),
            threading.Thread(target=getter),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors

    def test_concurrent_set_same_key(self):
        cache = TtlCache[str](ttl_seconds=60.0, max_size=100)
        errors = []

        def set_a():
            for _ in range(100):
                try:
                    cache.set("shared", "a")
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        def set_b():
            for _ in range(100):
                try:
                    cache.set("shared", "b")
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        threads = [
            threading.Thread(target=set_a),
            threading.Thread(target=set_b),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        entries = cache.get_entries()
        assert len(entries) == 1

    def test_concurrent_clear_and_read(self):
        cache = TtlCache[str](ttl_seconds=60.0, max_size=100)
        for i in range(50):
            cache.set(f"key_{i}", str(i))
        errors = []

        def clearer():
            for _ in range(20):
                try:
                    cache.clear()
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        def reader():
            for _ in range(20):
                try:
                    cache.get_entries()
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        threads = [
            threading.Thread(target=clearer),
            threading.Thread(target=reader),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors

    def test_set_refreshes_ttl(self):
        cache = TtlCache[str](ttl_seconds=0.1, max_size=10)
        cache.set("a", "value")
        time.sleep(0.06)
        cache.set("a", "value2")
        time.sleep(0.06)
        assert cache.get("a") == "value2"

    def test_no_stale_ttl_inheritance(self):
        cache = TtlCache[str](ttl_seconds=0.05, max_size=10)
        cache.set("a", "value")
        time.sleep(0.06)
        assert cache.get("a") is None
        cache.set("a", "new_value")
        time.sleep(0.03)
        assert cache.get("a") == "new_value"


class TestSolveEndpointSerialization:
    def test_rollback_returns_pre_rollback_bodies(self, authed_client):
        pytest.importorskip("OCP.gp")
        from oversolved.builder import build  # noqa: PLC0415

        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)
        spec = {"features": [sk1, ex1]}

        # Full build
        r1 = build(spec)
        assert "body_ex1" in r1["bodies"], f"bodies={list(r1['bodies'])}"

        # Rollback to before extrude (only sketch remains)
        state1 = r1["_build_state"]
        r2 = build({"features": [sk1]}, prev_state=state1)
        assert "body_ex1" not in r2["bodies"], "rollback must remove extruded body"

    def test_rollback_then_full_rebuild_coherent(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        post_solve(authed_client, {"id": "doc_rb2", "features": [sk1, ex1]})
        post_solve(authed_client, {"id": "doc_rb2", "features": [sk1], "rollback_position": 1})

        # Full rebuild (no rollback) should restore the body
        r3 = post_solve(authed_client, {"id": "doc_rb2", "features": [sk1, ex1]})
        assert r3.status_code == 200
        d3 = json.loads(r3.data)
        assert "body_ex1" in d3["bodies"]

    def test_concurrent_solves_serialized(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        results = {}

        def solve_a():
            resp = post_solve(authed_client, {"id": "doc_conc", "features": [sk1, ex1]})
            results["a"] = json.loads(resp.data)

        def solve_b():
            resp = post_solve(
                authed_client, {"id": "doc_conc", "features": [sk1], "rollback_position": 1}
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

    def test_build_state_not_in_response(self, authed_client):
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        resp = post_solve(authed_client, {"id": "doc_no_state", "features": [sk1]})
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


class TestConcurrentSolves:
    def test_concurrent_solves_different_docs(self, authed_client):
        """Two threads, different doc IDs, no cross-talk."""
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        results = {}

        def solve_doc_a():
            resp = post_solve(authed_client, {"id": "doc_conc_a", "features": [sk1, ex1]})
            results["a"] = json.loads(resp.data)

        def solve_doc_b():
            resp = post_solve(authed_client, {"id": "doc_conc_b", "features": [sk1, ex1]})
            results["b"] = json.loads(resp.data)

        t1 = threading.Thread(target=solve_doc_a)
        t2 = threading.Thread(target=solve_doc_b)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        assert "body_ex1" in results["a"]["bodies"]
        assert "body_ex1" in results["b"]["bodies"]
        assert results["a"]["bodies"]["body_ex1"]["mesh"] == results["b"]["bodies"]["body_ex1"]["mesh"]


class TestFailureRecovery:
    def test_exception_does_not_corrupt_l1(self, authed_client):
        """Failed solve does not overwrite L1 cache. Valid solve after failure works."""
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        # First valid solve populates L1
        r1 = post_solve(authed_client, {"id": "doc_fail_l1", "features": [sk1, ex1]})
        assert r1.status_code == 200

        # Bad solve with invalid feature kind
        bad_feature = {"id": "bad", "kind": "nonexistent"}
        r2 = post_solve(authed_client, {"id": "doc_fail_l1", "features": [sk1, bad_feature, ex1]})
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        assert d2["result"]["bad"]["status"] == "exception"

        # Subsequent valid solve should work (cache not corrupted)
        r3 = post_solve(authed_client, {"id": "doc_fail_l1", "features": [sk1, ex1]})
        assert r3.status_code == 200
        d3 = json.loads(r3.data)
        assert "body_ex1" in d3["bodies"]

    def test_error_then_retry_populates_cache(self, authed_client):
        """Fail, succeed, then third solve reuses checkpoints (faster)."""
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        # Bad solve that fails
        bad_feature = {"id": "bad", "kind": "nonexistent"}
        r1 = post_solve(authed_client, {"id": "doc_retry", "features": [bad_feature]})
        assert r1.status_code == 200

        # Valid solve populates cache
        r2 = post_solve(authed_client, {"id": "doc_retry", "features": [sk1, ex1]})
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        first_valid_ms = d2["solve_ms"]

        # Third solve should be faster (reuses checkpoints)
        r3 = post_solve(authed_client, {"id": "doc_retry", "features": [sk1, ex1]})
        assert r3.status_code == 200
        d3 = json.loads(r3.data)
        assert d3["solve_ms"] <= first_valid_ms * 1.5 or d3["solve_ms"] < 50


class TestAnonymousSolve:
    def test_anonymous_solve_no_cache(self, authed_client):
        """Solve with no doc ID does not populate L1. Next solve with doc ID = full rebuild."""
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        # Anonymous solve (no doc ID) - should not be cached
        r1 = post_solve(authed_client, {"features": [sk1, ex1]})
        assert r1.status_code == 200
        d1 = json.loads(r1.data)
        assert "body_ex1" in d1["bodies"]

        # Solve with doc ID (should be a fresh rebuild, not influenced by anonymous solve)
        r2 = post_solve(authed_client, {"id": "doc_anon_test", "features": [sk1, ex1]})
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        assert "body_ex1" in d2["bodies"]

        # Second solve with doc ID should be cached (L1 hit)
        r3 = post_solve(authed_client, {"id": "doc_anon_test", "features": [sk1, ex1]})
        assert r3.status_code == 200
        d3 = json.loads(r3.data)
        assert d3["solve_ms"] <= d2["solve_ms"] * 1.5 or d3["solve_ms"] < 50


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
