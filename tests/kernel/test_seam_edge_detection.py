"""Tests for seam edge detection in solid_to_edges."""

import pytest

pytest.importorskip("OCP.BRep", reason="OCP not installed")

from oversolved.kernel.geometry_tessellation import solid_to_edges, extrude_profile  # noqa: E402
from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeBox  # noqa: E402
import cadquery as cq  # noqa: E402


FRONT_PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}


def _circle_profile(radius: float = 1.0) -> list:
    return [[{
        "kind": "arc",
        "start": [radius, 0.0],
        "end": [radius, 0.0],
        "center": [0.0, 0.0],
        "radius": radius,
        "angle_start_deg": 0.0,
        "angle_end_deg": 360.0,
        "ccw": True,
    }]]


def test_cylinder_seam_edge_flagged():
    """Extruded cylinder must have exactly one seam edge and it must be a line."""
    solid = extrude_profile(_circle_profile(), FRONT_PLANE, [0.0, 0.0, 1.0], 2.0)
    result = solid_to_edges(solid)
    seam_edges = [e for e in result["edges"] if e.get("seam")]
    assert len(seam_edges) == 1, f"Expected 1 seam edge, got {len(seam_edges)}"
    assert seam_edges[0]["kind"] == "line", f"Expected seam edge to be a line, got {seam_edges[0]['kind']}"


def test_box_no_seam_edges():
    """Extruded rectangle (box) has no periodic surfaces and therefore no seam edges."""
    rect_profile = [[
        {"kind": "line", "start": [-1.0, -1.0], "end": [1.0, -1.0]},
        {"kind": "line", "start": [1.0, -1.0], "end": [1.0, 1.0]},
        {"kind": "line", "start": [1.0, 1.0], "end": [-1.0, 1.0]},
        {"kind": "line", "start": [-1.0, 1.0], "end": [-1.0, -1.0]},
    ]]
    solid = extrude_profile(rect_profile, FRONT_PLANE, [0.0, 0.0, 1.0], 2.0)
    result = solid_to_edges(solid)
    seam_edges = [e for e in result["edges"] if e.get("seam")]
    assert seam_edges == [], f"Box should have no seam edges, got {seam_edges}"


def test_sphere_seam_edge_flagged():
    """Revolved semicircle (sphere) must have seam edges flagged."""
    solid_cq = cq.Workplane("XY").add(
        cq.Solid.makeSphere(1.0)
    )
    result = solid_to_edges(solid_cq.val())
    seam_edges = [e for e in result["edges"] if e.get("seam")]
    assert len(seam_edges) >= 1, "Sphere should have at least one seam edge"


def test_non_seam_edges_not_flagged():
    """Regular boundary edges of a cylinder must not be marked as seam."""
    solid = extrude_profile(_circle_profile(), FRONT_PLANE, [0.0, 0.0, 1.0], 2.0)
    result = solid_to_edges(solid)
    non_seam = [e for e in result["edges"] if not e.get("seam")]
    # Cylinder has 2 circular edges (top/bottom) and 1 seam line -> 2 non-seam edges
    assert len(non_seam) == 2
    assert all(e["kind"] in ("circle", "arc") for e in non_seam)
