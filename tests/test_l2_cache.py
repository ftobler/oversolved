"""Tests for backend L2 (persistent BREP) cache."""

import json
import threading
import time

import pytest

from oversolved.cache import L2Cache
from oversolved.serialization import (
    deserialize_build_state,
    serialize_build_state,
    shape_to_step_base64,
    step_base64_to_shape,
)
from oversolved.types3d import Body, BuildState, FeatureCheckpoint
from solver_helpers import extrude_spec, rect_sketch_spec


def post_solve(client, payload):
    return client.post(
        "/api/solve",
        data=json.dumps(payload),
        content_type="application/json",
    )


def logged_in_client(app):
    """Create a test client and log in as admin."""
    c = app.test_client()
    resp = c.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    return c


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
            "L2_CACHE_MAX_SIZE": 1024 * 1024 * 1024,  # 1 GB for tests
            "L2_CACHE_TTL": 86400 * 30,
        }
    )
    return test_app


@pytest.fixture
def authed_client(app):
    c = app.test_client()
    resp = c.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    return c


class TestSerialization:
    def test_serialize_empty_build_state(self):
        state = BuildState(feature_order=[], checkpoints={})
        data = serialize_build_state(state)
        restored = deserialize_build_state(data)
        assert restored is not None
        assert restored.feature_order == []
        assert restored.checkpoints == {}

    def test_serialize_with_shapes(self):
        pytest.importorskip("OCP.gp")
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

        shape = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
        body = Body(
            id="body_0",
            created_by="ex1",
            modified_by=[],
            shape=shape,
            sketch_id="sk1",
        )
        checkpoint = FeatureCheckpoint(
            spec={"id": "ex1", "kind": "extrude"},
            result={"status": "ok"},
            repo_snapshot={"elements": {}, "anchestral": {}},
            body_store_snapshot={"body_0": body},
        )
        state = BuildState(feature_order=["sk1", "ex1"], checkpoints={"ex1": checkpoint})
        data = serialize_build_state(state)
        restored = deserialize_build_state(data)
        assert restored is not None
        assert restored.feature_order == ["sk1", "ex1"]
        assert "ex1" in restored.checkpoints
        restored_body = restored.checkpoints["ex1"].body_store_snapshot["body_0"]
        assert restored_body.shape is not None

    def test_shape_to_step_base64(self):
        pytest.importorskip("OCP.gp")
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from oversolved.geometry import solid_to_mesh

        shape = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
        encoded = shape_to_step_base64(shape)
        assert isinstance(encoded, str)
        assert len(encoded) > 0
        restored = step_base64_to_shape(encoded)
        mesh1 = solid_to_mesh(shape)
        mesh2 = solid_to_mesh(restored)
        assert len(mesh1["vertices"]) == len(mesh2["vertices"])

    def test_deserialize_invalid_step(self):
        pytest.importorskip("OCP.gp")
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

        shape = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
        body = Body(
            id="body_0",
            created_by="ex1",
            modified_by=[],
            shape=shape,
            sketch_id="sk1",
        )
        checkpoint = FeatureCheckpoint(
            spec={"id": "ex1", "kind": "extrude"},
            result={"status": "ok"},
            repo_snapshot={"elements": {}, "anchestral": {}},
            body_store_snapshot={"body_0": body},
        )
        state = BuildState(feature_order=["ex1"], checkpoints={"ex1": checkpoint})
        data = serialize_build_state(state)
        # Corrupt the STEP base64
        data["checkpoints"]["ex1"]["body_store"]["body_0"]["shape_step"] = "invalid=="
        restored = deserialize_build_state(data)
        assert restored is None


class TestL2Cache:
    def test_l2_cache_get_miss(self, tmp_path):
        cache = L2Cache(cache_dir=str(tmp_path / "empty"))
        assert cache.get("missing") is None

    def test_l2_cache_set_and_get(self, tmp_path):
        pytest.importorskip("OCP.gp")
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

        cache = L2Cache(
            ttl_seconds=86400 * 30,
            max_size=1024 * 1024,
            cache_dir=str(tmp_path / "l2"),
        )
        shape = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
        body = Body(
            id="body_0",
            created_by="ex1",
            modified_by=[],
            shape=shape,
            sketch_id="sk1",
        )
        checkpoint = FeatureCheckpoint(
            spec={"id": "ex1", "kind": "extrude"},
            result={"status": "ok"},
            repo_snapshot={"elements": {}, "anchestral": {}},
            body_store_snapshot={"body_0": body},
        )
        state = BuildState(feature_order=["ex1"], checkpoints={"ex1": checkpoint})
        cache.set("doc1", state)
        restored = cache.get("doc1")
        assert restored is not None
        assert restored.feature_order == ["ex1"]
        restored_body = restored.checkpoints["ex1"].body_store_snapshot["body_0"]
        assert restored_body.shape is not None

    def test_l2_cache_eviction_by_ttl(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=0.05, max_size=1000000, cache_dir=str(tmp_path / "ttl")
        )
        state = BuildState(feature_order=["sk1"], checkpoints={})
        cache.set("doc1", state)
        assert cache.get("doc1") is not None
        time.sleep(0.06)
        assert cache.get("doc1") is None

    def test_l2_cache_eviction_by_size(self, tmp_path):
        cache_dir = tmp_path / "size"
        cache = L2Cache(
            ttl_seconds=60.0, max_size=50, cache_dir=str(cache_dir)
        )
        # Two small files exceed max_size=50 bytes, so the older one is evicted.
        state1 = BuildState(feature_order=["x"], checkpoints={})
        state2 = BuildState(feature_order=["y"], checkpoints={})
        cache.set("doc1", state1)
        cache.set("doc2", state2)
        assert cache.get("doc1") is None
        assert cache.get("doc2") is not None

    def test_l2_cache_concurrent_read(self, tmp_path):
        pytest.importorskip("OCP.gp")
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

        cache = L2Cache(
            ttl_seconds=86400 * 30,
            max_size=1024 * 1024,
            cache_dir=str(tmp_path / "concurrent"),
        )
        shape = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
        body = Body(
            id="body_0",
            created_by="ex1",
            modified_by=[],
            shape=shape,
            sketch_id="sk1",
        )
        checkpoint = FeatureCheckpoint(
            spec={"id": "ex1", "kind": "extrude"},
            result={"status": "ok"},
            repo_snapshot={"elements": {}, "anchestral": {}},
            body_store_snapshot={"body_0": body},
        )
        state = BuildState(feature_order=["ex1"], checkpoints={"ex1": checkpoint})
        cache.set("doc1", state)

        results = []

        def reader():
            for _ in range(50):
                results.append(cache.get("doc1") is not None)

        threads = [threading.Thread(target=reader) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert all(results)

    def test_l2_cache_directory_cleanup(self, tmp_path):
        cache_dir = tmp_path / "cleanup"
        cache = L2Cache(
            ttl_seconds=0.05, max_size=1000000, cache_dir=str(cache_dir)
        )
        state = BuildState(feature_order=["sk1"], checkpoints={})
        cache.set("old_doc", state)
        time.sleep(0.06)
        # Trigger eviction by writing a new key
        cache.set("new_doc", state)
        files = list(cache_dir.glob("*.json"))
        assert all("new_doc" in f.name for f in files)

    def test_l2_cache_concurrent_read_write(self, tmp_path):
        """Concurrent read/write on same key does not crash."""
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "conc_rw")
        )
        state = BuildState(feature_order=["sk1"], checkpoints={})
        cache.set("race_doc", state)

        errors = []

        def writer():
            for _ in range(20):
                try:
                    cache.set("race_doc", state)
                except Exception as e:
                    errors.append(e)

        def deleter():
            for _ in range(20):
                try:
                    cache.delete("race_doc")
                except Exception as e:
                    errors.append(e)

        def reader():
            for _ in range(50):
                try:
                    cache.get("race_doc")
                except Exception as e:
                    errors.append(e)

        threads = [
            threading.Thread(target=writer),
            threading.Thread(target=deleter),
        ]
        threads += [threading.Thread(target=reader) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors


class TestSolveWithL2Cache:
    def test_solve_with_l2_cache_hit(self, tmp_path):
        pytest.importorskip("OCP.gp")
        from oversolved.app import create_app

        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)
        cache_dir = str(tmp_path / "l2_hit")

        app1 = create_app(
            {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": str(tmp_path / "test1.db"),
                "L2_CACHE_ENABLED": True,
                "L2_CACHE_DIR": cache_dir,
            }
        )
        client1 = logged_in_client(app1)

        # First solve stores to L1 and L2
        r1 = post_solve(client1, {"id": "doc_l2", "features": [sk1, ex1]})
        assert r1.status_code == 200
        d1 = json.loads(r1.data)
        assert "body_ex1" in d1["bodies"]
        solve_ms_1 = d1["solve_ms"]

        # Create new app with same L2 dir but fresh L1 (simulates restart)
        app2 = create_app(
            {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": str(tmp_path / "test2.db"),
                "L2_CACHE_ENABLED": True,
                "L2_CACHE_DIR": cache_dir,
            }
        )
        client2 = logged_in_client(app2)

        # Second solve should hit L2, restoring L1
        r2 = post_solve(client2, {"id": "doc_l2", "features": [sk1, ex1]})
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        assert "body_ex1" in d2["bodies"]
        # L2 hit should be fast (no full re-solve)
        assert d2["solve_ms"] < solve_ms_1 * 0.5

    def test_solve_with_l2_cache_miss(self, tmp_path):
        pytest.importorskip("OCP.gp")
        from oversolved.app import create_app

        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        app = create_app(
            {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": str(tmp_path / "test.db"),
                "L2_CACHE_ENABLED": False,
            }
        )
        client = logged_in_client(app)

        r1 = post_solve(client, {"id": "doc_l2_miss", "features": [sk1, ex1]})
        assert r1.status_code == 200
        d1 = json.loads(r1.data)
        assert "body_ex1" in d1["bodies"]

    def test_solve_rebuild_after_feature_edit(self, authed_client, app):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        sk2 = rect_sketch_spec(w=5.0, h=5.0, sketch_id="sk2")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        # Full build
        r1 = post_solve(
            authed_client, {"id": "doc_edit", "features": [sk1, sk2, ex1]}
        )
        assert r1.status_code == 200

        # Edit sk2 label (keeps L1 alive)
        sk2_v2 = {**sk2, "label": "changed"}
        r2 = post_solve(
            authed_client, {"id": "doc_edit", "features": [sk1, sk2_v2, ex1]}
        )
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        assert "body_ex1" in d2["bodies"]

    def test_l2_cache_preserves_queries(self, tmp_path):
        pytest.importorskip("OCP.gp")
        from oversolved.app import create_app

        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)
        cache_dir = str(tmp_path / "l2_query")

        app1 = create_app(
            {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": str(tmp_path / "test1.db"),
                "L2_CACHE_ENABLED": True,
                "L2_CACHE_DIR": cache_dir,
            }
        )
        client1 = logged_in_client(app1)

        r1 = post_solve(client1, {"id": "doc_query", "features": [sk1, ex1]})
        assert r1.status_code == 200
        d1 = json.loads(r1.data)
        face_query = d1["bodies"]["body_ex1"]["mesh"]["face_queries"][0]

        # Create new app with same L2 dir but fresh L1
        app2 = create_app(
            {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": str(tmp_path / "test2.db"),
                "L2_CACHE_ENABLED": True,
                "L2_CACHE_DIR": cache_dir,
            }
        )
        client2 = logged_in_client(app2)

        # Add a plane feature that depends on the face query
        plane = {
            "id": "pl1",
            "kind": "plane",
            "definition": {"mode": "on_face", "face": face_query},
        }
        r2 = post_solve(
            client2, {"id": "doc_query", "features": [sk1, ex1, plane]}
        )
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        assert d2["result"]["pl1"]["status"] == "ok"
