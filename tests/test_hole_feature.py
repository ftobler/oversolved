from oversolved.builder import build
from oversolved.solver import solve_features
from solver_helpers import (
    rect_sketch_spec, extrude_spec, point_sketch_spec,
    hole_spec, assert_mesh_valid, assert_mesh_bbox,
)


def _box_with_holes(points, **hole_kwargs):
    return {"features": [
        rect_sketch_spec(w=50, h=50, sketch_id="sk1"),
        extrude_spec("sk1", "ex1", distance=30.0),
        point_sketch_spec(points, sketch_id="pts"),
        hole_spec("pts", "h1", **hole_kwargs),
    ]}


def test_single_hole_blind():
    doc = _box_with_holes([(25, 25)], diameter=10.0, depth=20.0)
    r = build(doc)
    assert r["result"]["h1"]["status"] == "ok"
    assert "body_ex1" in r["bodies"]
    assert_mesh_valid(r["bodies"]["body_ex1"]["mesh"])
    assert_mesh_bbox(r["bodies"]["body_ex1"]["mesh"], (0, 50), (0, 50), (0, 30))


def test_single_hole_through_all():
    doc = _box_with_holes([(25, 25)], diameter=10.0, depth_mode='through_all')
    r = build(doc)
    assert r["result"]["h1"]["status"] == "ok"
    assert "body_ex1" in r["bodies"]
    assert_mesh_valid(r["bodies"]["body_ex1"]["mesh"])


def test_multiple_holes():
    doc = _box_with_holes([(10, 10), (25, 25), (40, 40)], diameter=8.0, depth=15.0)
    r = build(doc)
    assert r["result"]["h1"]["status"] == "ok"
    assert "body_ex1" in r["bodies"]
    assert_mesh_valid(r["bodies"]["body_ex1"]["mesh"])


def test_hole_off_center():
    doc = _box_with_holes([(10, 10)], diameter=10.0, depth=20.0)
    r = build(doc)
    assert r["result"]["h1"]["status"] == "ok"
    assert_mesh_valid(r["bodies"]["body_ex1"]["mesh"])


def test_hole_reverse_direction():
    doc = _box_with_holes([(25, 25)], diameter=10.0, depth=20.0, direction='reverse')
    r = build(doc)
    assert r["result"]["h1"]["status"] == "ok"
    assert "body_ex1" in r["bodies"]
    assert_mesh_valid(r["bodies"]["body_ex1"]["mesh"])


def test_hole_no_target_defaults_to_first_body():
    doc = _box_with_holes([(25, 25)], diameter=10.0, depth=20.0)
    r = build(doc)
    assert r["result"]["h1"]["status"] == "ok"
    assert r["result"]["h1"]["body_id"] == "body_ex1"


def test_hole_explicit_target():
    doc = _box_with_holes([(25, 25)], diameter=10.0, depth=20.0, target='@body_ex1')
    r = build(doc)
    assert r["result"]["h1"]["status"] == "ok"
    assert r["result"]["h1"]["body_id"] == "body_ex1"


def test_hole_missing_sketch_raises():
    doc = {"features": [
        rect_sketch_spec(w=50, h=50, sketch_id="sk1"),
        extrude_spec("sk1", "ex1", distance=30.0),
        hole_spec("missing", "h1"),
    ]}
    r = build(doc)
    assert r["result"]["h1"]["status"] == "exception"


def test_hole_no_points_raises():
    doc = {"features": [
        rect_sketch_spec(w=50, h=50, sketch_id="sk1"),
        extrude_spec("sk1", "ex1", distance=30.0),
        {"id": "pts", "kind": "sketch", "plane": "@builtin_plane_front",
         "entities": [{"id": "l1", "kind": "line"}], "initial": {"l1": [0, 0, 10, 10]}, "constraints": []},
        hole_spec("pts", "h1"),
    ]}
    r = build(doc)
    assert r["result"]["h1"]["status"] == "exception"


def test_hole_missing_target_raises():
    doc = {"features": [
        rect_sketch_spec(w=50, h=50, sketch_id="sk1"),
        extrude_spec("sk1", "ex1", distance=30.0),
        point_sketch_spec([(25, 25)], sketch_id="pts"),
        hole_spec("pts", "h1", target='@body_missing'),
    ]}
    r = build(doc)
    assert r["result"]["h1"]["status"] == "exception"


def test_hole_result_has_hole_count():
    doc = _box_with_holes([(10, 10), (25, 25), (40, 40)])
    r = build(doc)
    assert r["result"]["h1"]["hole_count"] == 3


def test_modified_by_recorded():
    doc = _box_with_holes([(25, 25)])
    r = build(doc)
    assert "h1" in r["bodies"]["body_ex1"]["modified_by"]


def test_partial_rebuild_after_hole():
    doc = _box_with_holes([(25, 25)], diameter=10.0, depth=20.0)
    r1 = build(doc)
    assert r1["result"]["h1"]["status"] == "ok"

    # Change extrude depth upstream
    doc["features"][1]["distance"] = 40.0
    r2 = build(doc, prev_state=r1["_build_state"])
    assert r2["result"]["h1"]["status"] == "ok"
    assert_mesh_valid(r2["bodies"]["body_ex1"]["mesh"])


def test_feature_exception_includes_traceback():
    """Unhandled feature exception includes traceback in result."""
    doc = {
        "features": [
            {"id": "bad", "kind": "nonexistent"},
        ]
    }
    r = build(doc)
    assert r["result"]["bad"]["status"] == "exception"
    assert "traceback" in r["result"]["bad"], (
        f"Exception result should include traceback, got keys: {list(r['result']['bad'].keys())}"
    )


def test_hole_via_solve_features():
    """Hole through solve_features() resolves sketch ref correctly."""
    doc = _box_with_holes([(25, 25)], diameter=10.0, depth=20.0)
    r = solve_features(doc)
    # Hole is the 4th feature (index 3)
    hole_result = r["features"][3]
    assert hole_result.get("status") != "exception", (
        f"Hole failed: {hole_result.get('exception')}"
    )
