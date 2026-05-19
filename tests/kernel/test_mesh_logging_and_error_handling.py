"""Tests for mesh logging and error handling improvements."""

import importlib
import logging
import unittest.mock as mock
import pytest

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]


def _make_box_shape():
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    return BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()


def test_solid_to_mesh_uses_module_level_logger(caplog):
    """Module-level logger is used, not a per-call local."""
    from oversolved.kernel import geometry_tessellation
    from oversolved.kernel.geometry_tessellation import solid_to_mesh

    shape = _make_box_shape()

    # BRepMesh_IncrementalMesh is a local import inside solid_to_mesh; patch at OCP level.
    with mock.patch("OCP.BRepMesh.BRepMesh_IncrementalMesh", side_effect=RuntimeError("mock tessellation error")):
        with caplog.at_level(logging.WARNING, logger="oversolved.kernel.geometry_tessellation"):
            result = solid_to_mesh(shape)

    assert len(caplog.records) >= 1
    assert caplog.records[0].name == geometry_tessellation.__name__
    assert "tessellation" in caplog.records[0].message.lower() or "unit cube" in caplog.records[0].message.lower()

    # Should still return a valid fallback mesh (any non-empty vertex list).
    assert len(result["vertices"]) > 0


def test_solid_to_mesh_logs_on_tessellation_failure(caplog):
    """solid_to_mesh logs a warning when BRepMesh_IncrementalMesh raises."""
    from oversolved.kernel.geometry_tessellation import solid_to_mesh

    shape = _make_box_shape()

    with mock.patch("OCP.BRepMesh.BRepMesh_IncrementalMesh", side_effect=RuntimeError("boom")):
        with caplog.at_level(logging.WARNING, logger="oversolved.kernel.geometry_tessellation"):
            solid_to_mesh(shape)

    messages = [r.message for r in caplog.records]
    assert any("brepmesh" in m.lower() or "tessellation" in m.lower() for m in messages)


def test_extrude_occ_exception_sets_status_exception():
    """OCC failure in _solve_extrude sets status=exception, not mesh_warning."""
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)

    with mock.patch("oversolved.kernel.solver_features_brep._ep", side_effect=RuntimeError("occ failure")):
        result = build(spec)

    body_result = result.get("result", {}).get("ex1") or {}
    assert body_result.get("status") == "exception", (
        f"expected status=exception, got: {body_result}"
    )
    assert "mesh_warning" not in body_result


def test_revolve_occ_exception_sets_status_exception():
    """OCC failure in _solve_revolve sets status=exception, not mesh_warning."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec

    sk = rect_sketch_spec(w=2.0, h=1.0)
    # Shift sketch right so it doesn't cross the revolve axis.
    for key in sk["initial"]:
        v = sk["initial"][key]
        sk["initial"][key] = [v[0] + 1.0, v[1], v[2] + 1.0, v[3]]
    spec = {
        "features": [
            sk,
            {
                "id": "rev1",
                "kind": "revolve",
                "label": "Revolve",
                "sketch": "$sk1",
                "axis_origin": [0, 0, 0],
                "axis_direction": [0, 1, 0],
                "angle": 360,
                "operation": "add",
            },
        ]
    }

    with mock.patch("oversolved.kernel.solver_features_brep.sketch_loops_to_face",
                    side_effect=RuntimeError("occ failure")):
        result = build(spec)

    body_result = result.get("result", {}).get("rev1") or {}
    assert body_result.get("status") == "exception", (
        f"expected status=exception, got: {body_result}"
    )
    assert "mesh_warning" not in body_result
