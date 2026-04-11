"""Tests for the upgraded /api/solve endpoint (builder-backed)."""

import json
import pytest
from solver_helpers import rect_sketch_spec, extrude_spec
from oversolved.app import create_app


try:
    from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: F401
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
def app(tmp_path):
    test_app = create_app({"DB_TYPE": "sqlite", "DB_PATH": str(tmp_path / "test.db")})
    test_app.config["TESTING"] = True
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


def post_solve(client, payload):
    return client.post(
        "/api/solve",
        data=json.dumps(payload),
        content_type="application/json",
    )


class TestApiSolve:

    def test_empty_body_returns_400(self, client):
        resp = client.post("/api/solve", data="", content_type="application/json")
        assert resp.status_code == 400

    def test_missing_features_key(self, client):
        resp = post_solve(client, {"id": "x"})
        assert resp.status_code == 400
        assert "features required" in json.loads(resp.data)["error"]

    def test_sketch_only_doc(self, client):
        resp = post_solve(client, {"features": [SKETCH_FEATURE]})
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert "result" in data
        assert "bodies" in data

    def test_plane_feature_result(self, client):
        resp = post_solve(client, {"features": [PLANE_FEATURE]})
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert "plane" in data["result"]["pl1"]

    def test_extrude_status_ok(self, client):
        resp = post_solve(client, {"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["result"]["ex1"]["status"] == "ok"

    def test_extrude_has_body_id(self, client):
        resp = post_solve(client, {"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        data = json.loads(resp.data)
        assert data["result"]["ex1"]["body_id"] == "body_ex1"

    def test_bodies_key_present(self, client):
        resp = post_solve(client, {"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        data = json.loads(resp.data)
        assert isinstance(data["bodies"], dict)

    @pytest.mark.skipif(not HAS_OCC, reason="OCC not available")
    def test_extrude_mesh_in_bodies(self, client):
        resp = post_solve(client, {"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        data = json.loads(resp.data)
        assert "body_ex1" in data["bodies"]
        assert "mesh" in data["bodies"]["body_ex1"]

    def test_builtin_planes_in_result(self, client):
        resp = post_solve(client, {"features": []})
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert "builtin_plane_front" in data["result"]
        assert "builtin_plane_top" in data["result"]
        assert "builtin_plane_right" in data["result"]

    def test_solve_ms_present(self, client):
        resp = post_solve(client, {"features": []})
        data = json.loads(resp.data)
        assert isinstance(data["solve_ms"], (int, float))

    def test_build_state_not_in_response(self, client):
        resp = post_solve(client, {"features": [SKETCH_FEATURE, EXTRUDE_FEATURE]})
        data = json.loads(resp.data)
        assert "_build_state" not in data

    def test_missing_sketch_extrude(self, client):
        bad_extrude = {"id": "ex1", "kind": "extrude", "sketch": "$nonexistent", "distance": 5}
        resp = post_solve(client, {"features": [bad_extrude]})
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["result"]["ex1"]["status"] == "exception"

    @pytest.mark.skipif(not HAS_OCC, reason="OCC not available")
    def test_partial_rebuild_two_requests(self, client):
        import time
        payload = {"id": "doc_partial", "features": [SKETCH_FEATURE, EXTRUDE_FEATURE]}

        t0 = time.perf_counter()
        resp1 = post_solve(client, payload)
        t1 = time.perf_counter()
        resp2 = post_solve(client, payload)
        t2 = time.perf_counter()

        d1 = json.loads(resp1.data)
        d2 = json.loads(resp2.data)

        assert d1["bodies"]["body_ex1"]["mesh"] == d2["bodies"]["body_ex1"]["mesh"]
        # Second call should be faster or within 20% tolerance
        first_ms = (t1 - t0) * 1000
        second_ms = (t2 - t1) * 1000
        assert second_ms <= first_ms * 1.2 or second_ms < 50
