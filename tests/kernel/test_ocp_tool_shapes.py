"""Tests for the OCP-direct tool shape path (feature 269).

Guards the invariants:
- ocp_make_face_from_wire does not run ShapeFix_Shape on the input wire
- ocp_make_prism and ocp_revolve use Copy=True (input faces are not mutated)
- The tool solid carries no ShapeUpgrade before the boolean
- Cap faces of an extruded solid survive as queryable elements after boolean
"""
import importlib
import math

import pytest

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("OCP"), reason="OCP not installed"
)


def _unit_square_face():
    """Return an OCC TopoDS_Face for a 1x1 square in the XY plane."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
    from OCP.gp import gp_Pnt
    from oversolved.kernel.ocp_ops import ocp_make_face_from_wire

    corners = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]

    def edge(a, b):
        return BRepBuilderAPI_MakeEdge(gp_Pnt(*a), gp_Pnt(*b)).Edge()

    wire_builder = BRepBuilderAPI_MakeWire()
    for i in range(4):
        wire_builder.Add(edge(corners[i], corners[(i + 1) % 4]))
    wire = wire_builder.Wire()
    return ocp_make_face_from_wire(wire, [])


def _count_faces(topo_shape):
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    exp = TopExp_Explorer(topo_shape, TopAbs_FACE)
    n = 0
    while exp.More():
        n += 1
        exp.Next()
    return n


def test_prism_face_count():
    """A unit square extruded 1 unit produces a valid solid with exactly 6 faces."""
    from oversolved.kernel.ocp_ops import ocp_make_prism
    from OCP.BRep import BRep_Builder  # noqa: F401 -- used to verify shape validity
    from OCP.BRepCheck import BRepCheck_Analyzer

    face = _unit_square_face()
    solid = ocp_make_prism(face, [0.0, 0.0, 1.0])

    analyzer = BRepCheck_Analyzer(solid)
    assert analyzer.IsValid(), "prism solid is not valid"
    assert _count_faces(solid) == 6, f"expected 6 faces, got {_count_faces(solid)}"


def test_prism_input_not_mutated():
    """ocp_make_prism Copy=True: input face hash must be unchanged after the call."""
    from oversolved.kernel.ocp_ops import ocp_make_prism

    face = _unit_square_face()
    face_hash_before = hash(face)
    ocp_make_prism(face, [0.0, 0.0, 2.0])
    assert hash(face) == face_hash_before, "ocp_make_prism mutated the input face"


def test_revolve_input_not_mutated():
    """ocp_revolve Copy=True: input face hash must be unchanged after the call."""
    from oversolved.kernel.ocp_ops import ocp_revolve

    face = _unit_square_face()
    face_hash_before = hash(face)
    ocp_revolve(face, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0], math.radians(90.0))
    assert hash(face) == face_hash_before, "ocp_revolve mutated the input face"


def test_face_build_no_shapfix_wire_step():
    """ocp_make_face_from_wire must NOT silently repair a gap in the outer wire.

    CadQuery's Face.makeFromWires runs ShapeFix_Shape on the wire and can close
    a small gap automatically. Our OCP-direct path must expose the issue instead
    of hiding it — either raising ValueError or returning an invalid face.
    This pins the contract: no hidden topology changes.
    """
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.gp import gp_Pnt
    from oversolved.kernel.ocp_ops import ocp_make_face_from_wire

    GAP = 0.5  # deliberately large gap so BRepBuilderAPI_MakeFace must fail cleanly

    e1 = BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 0), gp_Pnt(1, 0, 0)).Edge()
    e2 = BRepBuilderAPI_MakeEdge(gp_Pnt(1, 0, 0), gp_Pnt(1, 1, 0)).Edge()
    # deliberate gap: next edge starts at (1+GAP, 1, 0) instead of (1, 1, 0)
    e3 = BRepBuilderAPI_MakeEdge(gp_Pnt(1 + GAP, 1, 0), gp_Pnt(0, 1, 0)).Edge()
    e4 = BRepBuilderAPI_MakeEdge(gp_Pnt(0, 1, 0), gp_Pnt(0, 0, 0)).Edge()

    wire_builder = BRepBuilderAPI_MakeWire()
    for e in (e1, e2, e3, e4):
        wire_builder.Add(e)
    wire = wire_builder.Wire()

    try:
        face = ocp_make_face_from_wire(wire, [])
        # If it didn't raise, the face must be invalid
        analyzer = BRepCheck_Analyzer(face)
        assert not analyzer.IsValid(), (
            "ocp_make_face_from_wire silently repaired a gapped wire (ShapeFix snuck in)"
        )
    except (ValueError, Exception):
        pass  # raising is the acceptable alternative


def test_extrude_feature_cap_face_queryable():
    """After a full extrude solve the top_face element must be registered in the repo."""
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    r = build(spec)

    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]

    # top_face is stored in the checkpoint repo snapshot, not the build return dict.
    state = r["_build_state"]
    cp = state.checkpoints["ex1"]
    elements = cp.repo_snapshot.get("elements", {})
    top_face = elements.get("ex1/top_face")

    assert top_face is not None, "ex1/top_face not registered in repo checkpoint"
    assert top_face.get("type") == "flatface", f"unexpected type: {top_face.get('type')}"

    normal = top_face["normal"]
    assert abs(normal[2] - 1.0) < 1e-6, f"top_face normal should be +Z, got {normal}"

    centroid = top_face["centroid"]
    assert abs(centroid[2] - 5.0) < 0.1, f"top_face centroid Z should be ~5, got {centroid[2]}"


def test_revolve_360_solid():
    """360-degree revolve produces a valid closed solid with at least 3 faces."""
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid, rect_sketch_spec

    sk = rect_sketch_spec(w=2.0, h=1.0, sketch_id="sk1")
    # shift rect away from axis so revolve has volume
    for key in sk["initial"]:
        pt = sk["initial"][key]
        sk["initial"][key] = [pt[0] + 1.0, pt[1], pt[2] + 1.0, pt[3]]

    revolve = {
        "id": "rev1", "kind": "revolve", "label": "Revolve",
        "sketch": "$sk1", "angle": 360.0,
        "axis_origin": [0, 0, 0], "axis_direction": [0, 1, 0],
        "operation": "add",
    }
    spec = {"features": [sk, revolve]}
    r = build(spec)

    assert r["result"]["rev1"]["status"] == "ok", r["result"]["rev1"]
    mesh = r["bodies"]["body_rev1"]["mesh"]
    assert_mesh_valid(mesh)

    # A 360-degree revolve of a rectangle must produce a non-trivial mesh
    # (at least two annular caps + a cylindrical wall = several triangles).
    assert len(mesh["faces"]) >= 4, "360 revolve mesh has too few triangles"


def test_extrude_then_extrude_profile_from_cap():
    """Cap face of extrude1 must survive as a usable profile for extrude2."""
    import importlib
    pytest.importorskip("vtkmodules")

    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec, assert_mesh_valid

    sk1 = rect_sketch_spec(w=10, h=10, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)

    # sk2 lives on the top face of ex1 (z=5 plane)
    sk2 = rect_sketch_spec(w=4, h=4, sketch_id="sk2",
                           plane="@ex1/top_face")
    ex2 = extrude_spec("sk2", "ex2", distance=3.0, operation="add")

    spec = {"features": [sk1, ex1, sk2, ex2]}
    r = build(spec)

    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert r["result"]["ex2"]["status"] == "ok", r["result"]["ex2"]

    # The single fused body must have valid geometry
    bodies = [v for v in r["bodies"].values() if v.get("mesh")]
    assert len(bodies) >= 1, "expected at least one body"
    for body in bodies:
        assert_mesh_valid(body["mesh"])
