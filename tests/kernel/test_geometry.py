"""Tests for exact OCC curve types produced by sketch_loops_to_face / extrude_profile."""

import math
import pytest

pytest.importorskip("OCP.BRep", reason="OCP not installed")

from oversolved.kernel.geometry_tessellation import extrude_profile, solid_to_edges, solid_to_vertices  # noqa: E402
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder  # noqa: E402


FRONT_PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}


def edge_curve_types(shape):
    """Return a list of cadquery geomType strings for all edges in a shape."""
    return [e.geomType() for e in shape.edges()]


def test_circle_profile_produces_circle_edges():
    """Full-circle arc boundary should produce at least one CIRCLE edge."""
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
    assert any(t == "CIRCLE" for t in types), (
        f"expected at least one circle edge, got types: {types}"
    )


def test_rect_profile_produces_line_edges_only():
    """Rectangle boundary (all line edges) should produce only LINE edges."""
    loop = [
        {"kind": "line", "start": [0.0, 0.0], "end": [2.0, 0.0]},
        {"kind": "line", "start": [2.0, 0.0], "end": [2.0, 1.0]},
        {"kind": "line", "start": [2.0, 1.0], "end": [0.0, 1.0]},
        {"kind": "line", "start": [0.0, 1.0], "end": [0.0, 0.0]},
    ]
    solid = extrude_profile([loop], FRONT_PLANE, [0.0, 0.0, 1.0], 1.0)
    types = edge_curve_types(solid)
    assert all(t == "LINE" for t in types), (
        f"expected only line edges, got types: {types}"
    )


def test_arc_profile_produces_arc_edges():
    """Partial arc plus two radial lines should produce at least one CIRCLE edge."""
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
    assert any(t == "CIRCLE" for t in types), (
        f"expected at least one circle/arc edge, got types: {types}"
    )


def test_profile_solid_is_valid():
    """cadquery isValid should report valid for both circle and rect extrusions."""
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
        assert solid.isValid(), f"{name} solid failed isValid"


def test_solid_to_edges_dedup_consistent():
    """solid_to_edges must return the same unique edge count regardless of hash method.

    A box has 12 unique edges; dedup via hash(edge.wrapped) must not over- or under-count.
    """
    solid = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    edges = solid_to_edges(solid)["edges"]
    assert len(edges) == 12, f"expected 12 unique edges, got {len(edges)}"


def test_solid_to_vertices_dedup_consistent():
    """solid_to_vertices must return the same unique vertex count regardless of hash method.

    A box has 8 unique vertices; dedup via hash(v.wrapped) must not over- or under-count.
    """
    solid = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    vertices = solid_to_vertices(solid)["vertices"]
    assert len(vertices) == 8, f"expected 8 unique vertices, got {len(vertices)}"


def test_solid_to_edges_box():
    """A box solid must yield exactly 12 unique line edges."""
    solid = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    edges = solid_to_edges(solid)["edges"]
    line_edges = [e for e in edges if e["kind"] == "line"]
    assert len(line_edges) == 12, f"expected 12 line edges, got {len(line_edges)}"


def test_solid_to_edges_cylinder():
    """A cylinder solid must yield exactly 2 circle edges and 1 line (seam)."""
    solid = BRepPrimAPI_MakeCylinder(1.0, 2.0).Shape()
    edges = solid_to_edges(solid)["edges"]
    circle_edges = [e for e in edges if e["kind"] == "circle"]
    line_edges = [e for e in edges if e["kind"] == "line"]
    assert len(circle_edges) == 2, f"expected 2 circle edges, got {len(circle_edges)}"
    assert len(line_edges) == 1, f"expected 1 line edge, got {len(line_edges)}"


def test_solid_to_edges_circle_fields():
    """A circle edge must have all required keys and radius > 0."""
    solid = BRepPrimAPI_MakeCylinder(1.5, 1.0).Shape()
    edges = solid_to_edges(solid)["edges"]
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
    edges = solid_to_edges(solid)["edges"]
    line_edges = [e for e in edges if e["kind"] == "line"]
    assert line_edges, "no line edges found"
    e = line_edges[0]
    assert "start" in e and "end" in e
    assert len(e["start"]) == 3
    assert len(e["end"]) == 3
    assert e["start"] != e["end"]


def test_solid_to_edges_spline():
    """A solid with spline edges should return spline points without error."""
    from cadquery.occ_impl import shapes as cq_shapes
    from cadquery.occ_impl.geom import Vector

    pts = [Vector(0, 0, 0), Vector(1, 1, 0), Vector(2, 0, 0)]
    e = cq_shapes.Edge.makeSpline(pts)
    close = cq_shapes.Edge.makeLine(pts[-1], pts[0])
    w = cq_shapes.Wire.assembleEdges([e, close])
    f = cq_shapes.Face.makeFromWires(w)
    solid = cq_shapes.Solid.extrudeLinear(f, Vector(0, 0, 1))
    edges = solid_to_edges(solid)["edges"]
    spline_edges = [e for e in edges if e["kind"] == "spline"]
    assert len(spline_edges) == 2, (
        f"expected 2 spline edges, got {len(spline_edges)}"
    )
    se = spline_edges[0]
    assert len(se["points"]) == 17  # n_pts + 1
    for coord in se["points"][0]:
        assert math.isfinite(coord)
    for coord in se["points"][-1]:
        assert math.isfinite(coord)


def test_builder_body_has_edges():
    """Builder output for an extrude body must include a non-empty edges list."""
    import sys
    import os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec  # noqa: PLC0415

    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    result = build(spec)
    bodies = result.get("bodies", {})
    assert bodies, "no bodies in builder result"
    body = next(iter(bodies.values()))
    assert "edges" in body, "body missing 'edges' key"
    assert len(body["edges"]) > 0, "body edges list is empty"


def test_solid_to_edges_null_shape():
    """A null TopoDS_Shape returns an empty edge dict without raising."""
    from OCP.TopoDS import TopoDS_Shape

    result = solid_to_edges(TopoDS_Shape())
    assert result == {"edges": [], "edge_queries": []}


def test_solid_to_vertices_null_shape():
    """A null TopoDS_Shape returns an empty vertex dict without raising."""
    from OCP.TopoDS import TopoDS_Shape

    result = solid_to_vertices(TopoDS_Shape())
    assert result == {"vertices": [], "vertex_queries": []}


def test_apply_edge_modifier_warns_once(caplog):
    """Multiple failing edges produce exactly one aggregate WARNING, not one per edge."""
    import logging
    import unittest.mock as mock
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from oversolved.kernel.geometry_features import _apply_edge_modifier

    box = BRepPrimAPI_MakeBox(5.0, 5.0, 5.0).Shape()

    def always_fail(maker: object, edge: object) -> None:
        raise RuntimeError("simulated edge failure")

    with caplog.at_level(logging.WARNING, logger="oversolved.kernel.geometry_features"):
        _apply_edge_modifier(box, None, lambda s: mock.MagicMock(), always_fail)

    warning_records = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warning_records) == 1, (
        f"expected 1 aggregate WARNING, got {len(warning_records)}: "
        + str([r.message for r in warning_records])
    )
    assert "edges failed" in warning_records[0].message
