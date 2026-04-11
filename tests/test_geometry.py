"""Tests for exact OCC curve types produced by sketch_loops_to_face / extrude_profile."""

import math
import pytest

pytest.importorskip("OCP.BRep", reason="OCP not installed")

from oversolved.geometry import extrude_profile, solid_to_edges  # noqa: E402
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder  # noqa: E402
from OCP.BRepAdaptor import BRepAdaptor_Curve  # noqa: E402
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Line  # noqa: E402
from OCP.TopAbs import TopAbs_EDGE  # noqa: E402
from OCP.TopExp import TopExp_Explorer  # noqa: E402
from OCP.BRepCheck import BRepCheck_Analyzer  # noqa: E402


FRONT_PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}


def edge_curve_types(shape):
    """Return a list of GeomAbs curve type integers for all edges in a shape."""
    from OCP.TopoDS import TopoDS  # noqa: PLC0415

    types = []
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp.More():
        edge = TopoDS.Edge_s(exp.Current())
        adaptor = BRepAdaptor_Curve(edge)
        types.append(adaptor.GetType())
        exp.Next()
    return types


def test_circle_profile_produces_circle_edges():
    """Full-circle arc boundary should produce at least one GeomAbs_Circle edge."""
    loop = [
        {
            "kind": "arc",
            "start": [1.0, 0.0],
            "end": [1.0, 0.0],
            "center": [0.0, 0.0],
            "radius": 1.0,
            "angle_start_deg": 0.0,
            "angle_end_deg": 360.0,
            "ccw": True,
        }
    ]
    solid = extrude_profile([loop], FRONT_PLANE, [0.0, 0.0, 1.0], 2.0)
    types = edge_curve_types(solid)
    assert any(t == GeomAbs_Circle for t in types), (
        f"expected at least one circle edge, got types: {types}"
    )


def test_rect_profile_produces_line_edges_only():
    """Rectangle boundary (all line edges) should produce only GeomAbs_Line edges."""
    loop = [
        {"kind": "line", "start": [0.0, 0.0], "end": [2.0, 0.0]},
        {"kind": "line", "start": [2.0, 0.0], "end": [2.0, 1.0]},
        {"kind": "line", "start": [2.0, 1.0], "end": [0.0, 1.0]},
        {"kind": "line", "start": [0.0, 1.0], "end": [0.0, 0.0]},
    ]
    solid = extrude_profile([loop], FRONT_PLANE, [0.0, 0.0, 1.0], 1.0)
    types = edge_curve_types(solid)
    assert all(t == GeomAbs_Line for t in types), (
        f"expected only line edges, got types: {types}"
    )


def test_arc_profile_produces_arc_edges():
    """Partial arc plus two radial lines should produce at least one GeomAbs_Circle edge."""
    r = 1.0
    # 90-degree arc from 0 to 90 degrees, closed by two radial lines and a chord.
    start_uv = [r * math.cos(0.0), r * math.sin(0.0)]
    end_uv = [r * math.cos(math.pi / 2), r * math.sin(math.pi / 2)]
    loop = [
        {"kind": "line", "start": [0.0, 0.0], "end": start_uv},
        {
            "kind": "arc",
            "start": start_uv,
            "end": end_uv,
            "center": [0.0, 0.0],
            "radius": r,
            "angle_start_deg": 0.0,
            "angle_end_deg": 90.0,
            "ccw": True,
        },
        {"kind": "line", "start": end_uv, "end": [0.0, 0.0]},
    ]
    solid = extrude_profile([loop], FRONT_PLANE, [0.0, 0.0, 1.0], 1.0)
    types = edge_curve_types(solid)
    assert any(t == GeomAbs_Circle for t in types), (
        f"expected at least one circle/arc edge, got types: {types}"
    )


def test_profile_solid_is_valid():
    """BRepCheck_Analyzer should report valid for both circle and rect extrusions."""
    circle_loop = [
        {
            "kind": "arc",
            "start": [1.0, 0.0],
            "end": [1.0, 0.0],
            "center": [0.0, 0.0],
            "radius": 1.0,
            "angle_start_deg": 0.0,
            "angle_end_deg": 360.0,
            "ccw": True,
        }
    ]
    rect_loop = [
        {"kind": "line", "start": [0.0, 0.0], "end": [2.0, 0.0]},
        {"kind": "line", "start": [2.0, 0.0], "end": [2.0, 1.0]},
        {"kind": "line", "start": [2.0, 1.0], "end": [0.0, 1.0]},
        {"kind": "line", "start": [0.0, 1.0], "end": [0.0, 0.0]},
    ]
    for loop, name in [(circle_loop, "circle"), (rect_loop, "rect")]:
        solid = extrude_profile([loop], FRONT_PLANE, [0.0, 0.0, 1.0], 1.0)
        checker = BRepCheck_Analyzer(solid)
        assert checker.IsValid(), f"{name} solid failed BRepCheck_Analyzer"


def test_solid_to_edges_box():
    """A box solid must yield exactly 12 unique line edges."""
    solid = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    edges = solid_to_edges(solid)
    line_edges = [e for e in edges if e["kind"] == "line"]
    assert len(line_edges) == 12, f"expected 12 line edges, got {len(line_edges)}"


def test_solid_to_edges_cylinder():
    """A cylinder solid must yield exactly 2 circle edges and 1 line (seam)."""
    solid = BRepPrimAPI_MakeCylinder(1.0, 2.0).Shape()
    edges = solid_to_edges(solid)
    circle_edges = [e for e in edges if e["kind"] == "circle"]
    line_edges = [e for e in edges if e["kind"] == "line"]
    assert len(circle_edges) == 2, f"expected 2 circle edges, got {len(circle_edges)}"
    assert len(line_edges) == 1, f"expected 1 line edge, got {len(line_edges)}"


def test_solid_to_edges_circle_fields():
    """A circle edge must have all required keys and radius > 0."""
    solid = BRepPrimAPI_MakeCylinder(1.5, 1.0).Shape()
    edges = solid_to_edges(solid)
    circle_edges = [e for e in edges if e["kind"] == "circle"]
    assert circle_edges, "no circle edges found"
    e = circle_edges[0]
    for key in ("center", "radius", "axis", "x_axis", "angle_start", "angle_end"):
        assert key in e, f"missing key {key!r}"
    assert e["radius"] > 0
    assert len(e["center"]) == 3
    assert len(e["axis"]) == 3
    assert len(e["x_axis"]) == 3


def test_solid_to_edges_line_fields():
    """A line edge must have start and end, each a 3-element float list, start != end."""
    solid = BRepPrimAPI_MakeBox(2.0, 3.0, 4.0).Shape()
    edges = solid_to_edges(solid)
    line_edges = [e for e in edges if e["kind"] == "line"]
    assert line_edges, "no line edges found"
    e = line_edges[0]
    assert "start" in e and "end" in e
    assert len(e["start"]) == 3
    assert len(e["end"]) == 3
    assert e["start"] != e["end"]


def test_builder_body_has_edges():
    """Builder output for an extrude body must include a non-empty edges list."""
    import sys
    import os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec  # noqa: PLC0415

    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    result = build(spec)
    bodies = result.get("bodies", {})
    assert bodies, "no bodies in builder result"
    body = next(iter(bodies.values()))
    assert "edges" in body, "body missing 'edges' key"
    assert len(body["edges"]) > 0, "body edges list is empty"
