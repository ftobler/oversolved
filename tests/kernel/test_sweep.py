import importlib

import pytest

from solver_helpers import rect_sketch_spec, assert_mesh_valid, assert_mesh_bbox

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]


def _line_path_spec(sketch_id, segments, plane="@builtin_plane_top"):
    """Open polyline path sketch from a list of [x0, y0, x1, y1] line segments."""
    entities = [{"id": f"seg{i}", "kind": "line"} for i, _ in enumerate(segments)]
    initial = {f"seg{i}": list(s) for i, s in enumerate(segments)}
    return {
        "id": sketch_id, "kind": "sketch", "label": "Path", "plane": plane,
        "entities": entities, "initial": initial, "constraints": [],
    }


def _arc_path_spec(sketch_id, cx, cy, r, a0, a1, plane="@builtin_plane_top"):
    """Single-arc path sketch (angles in degrees, <=180 span)."""
    return {
        "id": sketch_id, "kind": "sketch", "label": "Path", "plane": plane,
        "entities": [{"id": "arc0", "kind": "arc"}],
        "initial": {"arc0": [cx, cy, r, a0, a1]},
        "constraints": [],
    }


def _sweep_spec(sweep_id, profile_id, path_id, operation="new", merge_target=None):
    spec = {
        "id": sweep_id, "kind": "sweep", "label": "Sweep",
        "sweep": {
            "sketch": ["$" + profile_id],
            "path": "$" + path_id,
            "operation": operation,
        },
    }
    if merge_target is not None:
        spec["sweep"]["merge_target"] = merge_target
    return spec


def test_sweep_status_ok():
    """A rectangle profile swept along a straight path produces a valid body."""
    from oversolved.kernel.builder import build

    doc = {"features": [
        rect_sketch_spec(w=2.0, h=3.0, sketch_id="prof", plane="@builtin_plane_front"),
        _line_path_spec("pth", [[0, 0, 0, 5]]),
        _sweep_spec("sw1", "prof", "pth"),
    ]}
    r = build(doc)
    assert r["result"]["sw1"]["status"] == "ok", r["result"]["sw1"]
    assert "body_sw1" in r["bodies"]
    assert_mesh_valid(r["bodies"]["body_sw1"]["mesh"])


def test_sweep_straight_bbox_is_box():
    """Straight sweep of a 2x3 profile over length 5 is a box of those dimensions."""
    from oversolved.kernel.builder import build

    doc = {"features": [
        rect_sketch_spec(w=2.0, h=3.0, sketch_id="prof", plane="@builtin_plane_front"),
        _line_path_spec("pth", [[0, 0, 0, 5]]),
        _sweep_spec("sw1", "prof", "pth"),
    ]}
    r = build(doc)
    mesh = r["bodies"]["body_sw1"]["mesh"]
    # Front-plane profile spans x[0,2] y[0,3]; top-plane path runs along world -z.
    assert_mesh_bbox(mesh, x_range=(0, 2), y_range=(0, 3), z_range=(-5, 0))


def test_sweep_polyline_path():
    """An L-shaped two-segment path sweeps without error."""
    from oversolved.kernel.builder import build

    doc = {"features": [
        rect_sketch_spec(w=1.0, h=1.0, sketch_id="prof", plane="@builtin_plane_front"),
        _line_path_spec("pth", [[0, 0, 0, 4], [0, 4, 3, 4]]),
        _sweep_spec("sw1", "prof", "pth"),
    ]}
    r = build(doc)
    assert r["result"]["sw1"]["status"] == "ok", r["result"]["sw1"]
    assert_mesh_valid(r["bodies"]["body_sw1"]["mesh"])


def test_sweep_arc_path():
    """A quarter-circle arc path (<=180 deg) sweeps without error.

    The profile sits on the right plane so its normal lines up with the arc's
    starting tangent (+x); a mismatched orientation self-intersects the sweep.
    """
    from oversolved.kernel.builder import build

    doc = {"features": [
        rect_sketch_spec(w=1.0, h=1.0, sketch_id="prof", plane="@builtin_plane_right"),
        _arc_path_spec("pth", cx=0.0, cy=5.0, r=5.0, a0=-90.0, a1=0.0),
        _sweep_spec("sw1", "prof", "pth"),
    ]}
    r = build(doc)
    assert r["result"]["sw1"]["status"] == "ok", r["result"]["sw1"]
    assert_mesh_valid(r["bodies"]["body_sw1"]["mesh"])


def test_sweep_cut_removes_volume():
    """A cut sweep subtracts material from an existing body."""
    from oversolved.kernel.builder import build

    base = rect_sketch_spec(w=6.0, h=6.0, sketch_id="base", plane="@builtin_plane_front")
    base_ext = {
        "id": "ext0", "kind": "extrude", "label": "Base",
        "extrude": {"sketch": ["$base"], "distance": -6.0, "operation": "new"},
    }
    tool_profile = rect_sketch_spec(w=2.0, h=2.0, sketch_id="prof", plane="@builtin_plane_front")
    cut = _sweep_spec("sw1", "prof", "pth", operation="cut")
    doc = {"features": [
        base, base_ext, tool_profile,
        _line_path_spec("pth", [[0, 0, 0, 6]]),
        cut,
    ]}
    r = build(doc)
    assert r["result"]["sw1"]["status"] == "ok", r["result"]["sw1"]
    assert r["result"]["sw1"]["operation"] == "cut"


def test_sweep_missing_path_returns_exception():
    """Sweep without a path reference fails loud."""
    from oversolved.kernel.builder import build

    doc = {"features": [
        rect_sketch_spec(w=2.0, h=3.0, sketch_id="prof", plane="@builtin_plane_front"),
        {"id": "sw1", "kind": "sweep", "label": "Sweep",
         "sweep": {"sketch": ["$prof"], "operation": "new"}},
    ]}
    r = build(doc)
    assert r["result"]["sw1"]["status"] == "exception"


def test_sweep_missing_profile_returns_exception():
    """Sweep without a profile reference fails loud."""
    from oversolved.kernel.builder import build

    doc = {"features": [
        _line_path_spec("pth", [[0, 0, 0, 5]]),
        {"id": "sw1", "kind": "sweep", "label": "Sweep",
         "sweep": {"path": "$pth", "operation": "new"}},
    ]}
    r = build(doc)
    assert r["result"]["sw1"]["status"] == "exception"
