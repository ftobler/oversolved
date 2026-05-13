"""Tests for the builder (formerly HTTP /api/solve, now direct build() calls)."""

import pytest
from solver_helpers import rect_sketch_spec, extrude_spec
from oversolved.app import create_app
from oversolved.kernel.builder import build


try:
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: F401
    HAS_OCC = True
except ImportError:
    HAS_OCC = False


SKETCH_FEATURE = rect_sketch_spec(w=10, h=10, sketch_id="sk1")
EXTRUDE_FEATURE = extrude_spec("sk1", "ex1", distance=5)

PLANE_FEATURE = {
    "id": "pl1",
    "kind": "plane",
    "definition": {
        "mode": "offset",
        "plane": "@builtin_plane_front",
        "offset": 10,
    },
}


@pytest.fixture
def app(pg_dsn, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app({
        "DB_TYPE": "postgres",
        "TESTING": True,
        "DB_DSN": pg_dsn,
    })
    return test_app


class TestApiSolve:

    def test_missing_features_key(self):
        result = build({"id": "x"})
        assert "result" in result

    def test_sketch_only_doc(self):
        result = build({"features": [SKETCH_FEATURE]})
        assert "result" in result
        assert "bodies" in result

    def test_plane_feature_result(self):
        result = build({"features": [PLANE_FEATURE]})
        assert "plane" in result["result"]["pl1"]

    @pytest.mark.skipif(not HAS_OCC, reason="OCP not available")
    def test_extrude_status_ok(self):
        result = build({"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        assert result["result"]["ex1"]["status"] == "ok"

    def test_extrude_has_body_id(self):
        result = build({"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        assert result["result"]["ex1"]["body_id"] == "body_ex1"

    def test_bodies_key_present(self):
        result = build({"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        assert isinstance(result["bodies"], dict)

    @pytest.mark.skipif(not HAS_OCC, reason="OCC not available")
    def test_extrude_mesh_in_bodies(self):
        result = build({"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        assert "body_ex1" in result["bodies"]
        assert "mesh" in result["bodies"]["body_ex1"]

    def test_builtin_planes_in_result(self):
        result = build({"features": []})
        assert "builtin_plane_front" in result["result"]
        assert "builtin_plane_top" in result["result"]
        assert "builtin_plane_right" in result["result"]

    def test_solve_ms_present(self):
        result = build({"features": []})
        assert isinstance(result["solve_ms"], (int, float))

    def test_build_state_in_result(self):
        result = build({"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        assert "_build_state" in result

    def test_missing_sketch_extrude(self):
        bad_extrude = {"id": "ex1", "kind": "extrude", "sketch": "$nonexistent", "distance": 5}
        result = build({"features": [bad_extrude]})
        assert result["result"]["ex1"]["status"] == "exception"

    def test_two_unsaved_docs_produce_correct_results(self):
        """Two payloads without an id field each produce geometrically correct results."""
        sk_a = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
        sk_b = rect_sketch_spec(w=10.0, h=10.0, sketch_id='sk1')

        r1 = build({'features': [sk_a]})
        geom_a = r1['result']['sk1']['geometry']

        r2 = build({'features': [sk_b]})
        assert r2['result']['sk1']['geometry'] != geom_a

        r3 = build({'features': [sk_a]})
        assert r3['result']['sk1']['geometry'] == geom_a

    @pytest.mark.skipif(not HAS_OCC, reason="OCC not available")
    def test_partial_rebuild_two_requests(self):
        import time
        payload = {"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]}

        t0 = time.perf_counter()
        r1 = build(payload)
        t1 = time.perf_counter()
        state = r1["_build_state"]
        r2 = build(payload, prev_state=state)
        t2 = time.perf_counter()

        assert r1["bodies"]["body_ex1"]["mesh"] == r2["bodies"]["body_ex1"]["mesh"]
        # Second call should be faster or within 20% tolerance
        first_ms = (t1 - t0) * 1000
        second_ms = (t2 - t1) * 1000
        assert second_ms <= first_ms * 1.2 or second_ms < 50
