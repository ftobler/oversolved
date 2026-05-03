"""Tests for backend L2 (persistent BREP) cache."""

import json
import os
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
            repo_snapshot={"elements": {}, "ancestral": {}},
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
            repo_snapshot={"elements": {}, "ancestral": {}},
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
            repo_snapshot={"elements": {}, "ancestral": {}},
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
            repo_snapshot={"elements": {}, "ancestral": {}},
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

    def test_l2_cache_concurrent_set_get_overlapping_keys(self, tmp_path):
        """2 writers + 4 readers on overlapping keys. No raises, no partial JSON."""
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "conc_keys")
        )
        state = BuildState(feature_order=["sk1"], checkpoints={})
        errors = []

        def writer(wid):
            for i in range(30):
                key = f"doc_{wid}_{i}"
                try:
                    cache.set(key, state)
                except Exception as e:
                    errors.append(e)

        def reader():
            for wid in range(2):
                for i in range(30):
                    key = f"doc_{wid}_{i}"
                    try:
                        cache.get(key)
                    except Exception as e:
                        errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(2)]
        threads += [threading.Thread(target=reader) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors

    def test_l2_cache_eviction_races_with_concurrent_writes(self, tmp_path):
        """Large entry triggers eviction while others write. No OSError races."""
        cache_dir = tmp_path / "evict_race"
        cache = L2Cache(
            ttl_seconds=60.0, max_size=500, cache_dir=str(cache_dir)
        )
        state = BuildState(feature_order=["sk1"], checkpoints={})
        errors = []

        def writer(wid):
            for i in range(50):
                key = f"doc_{wid}_{i}"
                try:
                    cache.set(key, state)
                except Exception as e:
                    errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        entries = list(cache_dir.glob("*.json"))
        assert len(entries) > 0

    # ─── A. TTL Edge Cases ───

    def test_ttl_access_at_boundary(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=0.1, max_size=1000000, cache_dir=str(tmp_path / "ttl_boundary")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        time.sleep(0.1)
        cache.get("doc1")  # Should not crash

    def test_ttl_future_mtime(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "future_mtime")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        path = str(tmp_path / "future_mtime" / "doc1.json")
        future = time.time() + 3600
        os.utime(path, (future, future))
        assert cache.get("doc1") is not None

    def test_ttl_clock_jump_forward(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "clock_jump")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        path = str(tmp_path / "clock_jump" / "doc1.json")
        past = time.time() - 61.0
        os.utime(path, (past, past))
        assert cache.get("doc1") is None

    def test_ttl_zero(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=0.0, max_size=1000000, cache_dir=str(tmp_path / "zero_ttl")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        result = cache.get("doc1")
        # TTL=0: now - mtime > 0 on any real system, so entry expires immediately.
        assert result is None

    # ─── B. Error Handling ───

    def test_permission_denied_on_read(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "permread")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        path = str(tmp_path / "permread" / "doc1.json")
        os.chmod(path, 0o000)
        result = cache.get("doc1")
        assert result is None
        assert os.path.exists(path)
        os.chmod(path, 0o644)

    def test_permission_denied_on_write(self, tmp_path):
        cache_dir = tmp_path / "permwrite"
        cache_dir.mkdir()
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(cache_dir)
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        os.chmod(cache_dir, 0o444)
        with pytest.raises(OSError):
            cache.set("doc1", state)
        tmp_files = list(cache_dir.glob("*.tmp"))
        assert len(tmp_files) == 0
        os.chmod(cache_dir, 0o755)

    def test_permission_denied_on_unlink_during_eviction(self, tmp_path, monkeypatch):
        cache = L2Cache(
            ttl_seconds=0.05, max_size=1000000, cache_dir=str(tmp_path / "permunlink")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        cache.set("doc2", state)

        original_unlink = os.unlink

        def failing_unlink(path, *args, **kwargs):
            if "doc1" in path:
                raise OSError(13, "Permission denied")
            return original_unlink(path, *args, **kwargs)

        monkeypatch.setattr(os, "unlink", failing_unlink)

        time.sleep(0.06)
        cache.set("doc3", state)  # Should not crash

        path = str(tmp_path / "permunlink" / "doc1.json")
        assert os.path.exists(path)

    def test_disk_full_during_serialization(self, tmp_path, monkeypatch):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "dfull")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        assert cache.get("doc1") is not None

        def failing_dump(*args, **kwargs):
            raise OSError(28, "No space left on device")

        monkeypatch.setattr(json, "dump", failing_dump)
        with pytest.raises(OSError):
            cache.set("doc1", state)
        assert cache.get("doc1") is not None

    # ─── C. File Corruption ───

    def test_corrupt_json(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "corrupt")
        )
        path = str(tmp_path / "corrupt" / "doc1.json")
        with open(path, "w") as f:
            f.write("not json")
        assert cache.get("doc1") is None

    def test_empty_file(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "emptyf")
        )
        path = str(tmp_path / "emptyf" / "doc1.json")
        with open(path, "w") as f:
            f.write("")
        assert cache.get("doc1") is None

    def test_orphan_tmp_file(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "orphan")
        )
        path = str(tmp_path / "orphan" / "doc1.json.tmp")
        with open(path, "w") as f:
            f.write("some data")
        assert cache.get("doc1") is None

    # ─── D. LRU by Size ───

    def test_size_eviction_single_entry_exceeds_max(self, tmp_path):
        cache = L2Cache(ttl_seconds=60.0, max_size=50, cache_dir=str(tmp_path / "big"))
        state = BuildState(feature_order=["x" * 50], checkpoints={})
        small = BuildState(feature_order=["y"], checkpoints={})
        cache.set("doc1", state)
        cache.set("doc2", small)
        assert cache.get("doc1") is None

    def test_size_eviction_many_tiny_entries(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=500, cache_dir=str(tmp_path / "tiny")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        for i in range(100):
            cache.set(f"doc{i}", state)
        assert cache.get("doc0") is None  # Oldest evicted
        survivors = [i for i in range(100) if cache.get(f"doc{i}") is not None]
        assert len(survivors) > 0
        assert len(survivors) < 100

    def test_size_eviction_zero_max_size(self, tmp_path):
        cache = L2Cache(ttl_seconds=60.0, max_size=0, cache_dir=str(tmp_path / "zero"))
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        assert cache.get("doc1") is None

    def test_size_eviction_exact_boundary(self, tmp_path):
        cache = L2Cache(
            ttl_seconds=60.0, max_size=100, cache_dir=str(tmp_path / "boundary")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        cache.set("doc2", state)
        cache.set("doc3", state)
        assert cache.get("doc1") is None
        remaining = [cache.get(f"doc{i}") for i in [2, 3]]
        assert all(r is not None for r in remaining)

    def test_size_eviction_same_mtime_tiebreaker(self, tmp_path):
        cache_dir = tmp_path / "tie"
        cache = L2Cache(ttl_seconds=60.0, max_size=100, cache_dir=str(cache_dir))
        state = BuildState(feature_order=["x"], checkpoints={})
        # Manually write two files to avoid eviction during set
        data = {"feature_order": ["x"], "checkpoints": {}}
        for name in ("a_doc", "b_doc"):
            with open(str(cache_dir / f"{name}.json"), "w") as f:
                json.dump(data, f)
        now = time.time()
        os.utime(str(cache_dir / "b_doc.json"), (now, now))
        os.utime(str(cache_dir / "a_doc.json"), (now, now))
        cache.set("c_doc", state)
        assert cache.get("a_doc") is None
        assert cache.get("b_doc") is not None
        assert cache.get("c_doc") is not None

    # ─── E. Base-Class Refactor ───

    def test_polymorphic_interface(self, tmp_path):

        def do_something(cache):
            cache.delete("nonexistent")
            cache.clear()

        cache = L2Cache(cache_dir=str(tmp_path / "poly"))
        do_something(cache)

    def test_subclass_override_set(self, tmp_path):
        class PrefixedCache(L2Cache):
            def __init__(self, prefix, **kwargs):
                super().__init__(**kwargs)
                self._prefix = prefix

            def set(self, key, state):
                super().set(f"{self._prefix}_{key}", state)

        cache = PrefixedCache(
            prefix="ns",
            ttl_seconds=0.05,
            max_size=1000000,
            cache_dir=str(tmp_path / "pref"),
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        assert cache.get("ns_doc1") is not None
        time.sleep(0.06)
        assert cache.get("ns_doc1") is None

    def test_subclass_override_get(self, tmp_path):
        class CountingCache(L2Cache):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                self.get_count = 0

            def get(self, key):
                self.get_count += 1
                return super().get(key)

        cache = CountingCache(
            ttl_seconds=60.0, max_size=1000000, cache_dir=str(tmp_path / "count")
        )
        state = BuildState(feature_order=["x"], checkpoints={})
        cache.set("doc1", state)
        assert cache.get("doc1") is not None
        assert cache.get_count == 1
        assert cache.get("doc1") is not None
        assert cache.get_count == 2


class TestSolveWithL2Cache:
    def test_solve_with_l2_cache_hit(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
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
        assert d2["solve_ms"] < solve_ms_1 * 0.6

    def test_solve_with_l2_cache_miss(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
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

    def test_l2_cache_miss_full_rebuild(self, tmp_path, monkeypatch):
        """L2 miss (first solve) should be slower than L2 hit (fresh L1, same L2 dir)."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        pytest.importorskip("OCP.gp")
        from oversolved.app import create_app

        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)
        cache_dir = str(tmp_path / "l2_miss")

        app1 = create_app({
            "DB_TYPE": "sqlite", "TESTING": True, "DB_PATH": str(tmp_path / "test1.db"),
            "L2_CACHE_ENABLED": True, "L2_CACHE_DIR": cache_dir,
        })
        client1 = logged_in_client(app1)

        # First solve - L2 miss, full rebuild
        r1 = post_solve(client1, {"id": "doc_timing", "features": [sk1, ex1]})
        assert r1.status_code == 200
        d1 = json.loads(r1.data)
        assert "body_ex1" in d1["bodies"]
        miss_ms = d1["solve_ms"]

        # New app with fresh L1, same L2 dir
        app2 = create_app({
            "DB_TYPE": "sqlite", "TESTING": True, "DB_PATH": str(tmp_path / "test2.db"),
            "L2_CACHE_ENABLED": True, "L2_CACHE_DIR": cache_dir,
        })
        client2 = logged_in_client(app2)

        # Second solve - L2 hit (restored from L2 to L1)
        r2 = post_solve(client2, {"id": "doc_timing", "features": [sk1, ex1]})
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        assert "body_ex1" in d2["bodies"]
        hit_ms = d2["solve_ms"]

        # L2 hit must be faster than L2 miss (same threshold as test_solve_with_l2_cache_hit)
        assert hit_ms < miss_ms * 0.6


class TestL2FailureRecovery:
    def test_exception_does_not_corrupt_l2(self, tmp_path, monkeypatch):
        """Failed solve does not overwrite L2 cache. Subsequent valid solve works."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        pytest.importorskip("OCP.gp")
        from oversolved.app import create_app

        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)
        cache_dir = str(tmp_path / "l2_fail")

        app1 = create_app({
            "DB_TYPE": "sqlite", "TESTING": True, "DB_PATH": str(tmp_path / "test1.db"),
            "L2_CACHE_ENABLED": True, "L2_CACHE_DIR": cache_dir,
        })
        client1 = logged_in_client(app1)

        # Valid solve populates L2
        r1 = post_solve(client1, {"id": "doc_l2_fail", "features": [sk1, ex1]})
        assert r1.status_code == 200

        # Bad solve with invalid feature kind
        bad_feature = {"id": "bad", "kind": "nonexistent"}
        r2 = post_solve(client1, {"id": "doc_l2_fail", "features": [sk1, bad_feature, ex1]})
        assert r2.status_code == 200
        d2 = json.loads(r2.data)
        assert d2["result"]["bad"]["status"] == "exception"

        # Create new app (fresh L1) to test L2 was not corrupted by failed solve
        app2 = create_app({
            "DB_TYPE": "sqlite", "TESTING": True, "DB_PATH": str(tmp_path / "test2.db"),
            "L2_CACHE_ENABLED": True, "L2_CACHE_DIR": cache_dir,
        })
        client2 = logged_in_client(app2)

        # Valid solve should work from L2 (not corrupted)
        r3 = post_solve(client2, {"id": "doc_l2_fail", "features": [sk1, ex1]})
        assert r3.status_code == 200
        d3 = json.loads(r3.data)
        assert "body_ex1" in d3["bodies"]

    def test_l2_cache_preserves_queries(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
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
