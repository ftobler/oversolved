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


def test_sketch_circle_extrudes_to_single_cylinder_face():
    """Regression: a circle sketched then extruded must yield ONE cylindrical
    side face, not two half-cylinder shells.

    The sketch layer represents a standalone circle as two 180 degree arcs;
    handed to OCC as two edges that produced two half-cylinder faces, two
    orphan vertical edges, and duplicate selection ids. sketch_loops_to_face
    now collapses a co-circular arc loop into a single full-circle edge, so OCC
    builds one cylindrical face with a proper periodic seam.
    """
    from oversolved.kernel.builder import build

    sketch = {
        "id": "sk_cyl", "kind": "sketch", "label": "circle",
        "plane": "@builtin_plane_top",
        "entities": [{"id": "circ", "kind": "circle"}],
        "initial": {"circ": [0, 0, 10]},
        "constraints": [
            {"id": "cc", "kind": "coincident", "a": "$circcenter", "b": "@builtin_origin"},
            {"id": "cd", "kind": "diameter", "target": "$circ", "value": 20, "pos": [0, 0]},
        ],
    }
    extrude = {
        "id": "ex_cyl", "kind": "extrude", "label": "extrude",
        "sketch": "$sk_cyl", "distance": 10, "direction": "normal",
    }
    r = build({"features": [sketch, extrude]})
    assert r["result"]["ex_cyl"]["status"] == "ok", (
        f"cylinder build failed: {r['result']['ex_cyl'].get('exception')}"
    )

    body = r["bodies"]["body_ex_cyl"]
    edges = body["edges"]
    line_edges = [e for e in edges if e["kind"] == "line"]
    circle_edges = [e for e in edges if e["kind"] in ("circle", "arc")]

    # One periodic seam line + two full-circle rims; no split semicircle arcs.
    assert len(line_edges) == 1, f"expected 1 seam line, got {len(line_edges)}"
    assert line_edges[0].get("seam"), "the single cylinder seam must be flagged"
    assert len(circle_edges) == 2, f"expected 2 rim edges, got {len(circle_edges)}"
    assert all(e["kind"] == "circle" for e in circle_edges), (
        "rims must be full circles, not split arcs: "
        f"{[e['kind'] for e in circle_edges]}"
    )

    eq = body.get("edge_queries", [])
    assert len(eq) == len(set(eq)), "edge queries must be unique"
    fq = body.get("mesh", {}).get("face_queries", [])
    assert len(fq) == len(set(fq)), "face queries must be unique"
    # 1 cylindrical side + 2 caps.
    assert len(fq) == 3, f"expected 3 faces (1 side + 2 caps), got {len(fq)}"
