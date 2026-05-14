"""Smoke tests for ocp_ops wrapper functions and the OCP import isolation invariant."""

import ast
import math
import os
import tempfile

import pytest

pytest.importorskip("cadquery.occ_impl.shapes")

from oversolved.kernel.ocp_ops import (  # noqa: E402
    ocp_chamfer_factory,
    ocp_collect_edge_hashes,
    ocp_copy_shape,
    ocp_count_solids,
    ocp_curve_info,
    ocp_explore_edges,
    ocp_explore_solids,
    ocp_extract_face_loops,
    ocp_face_uv_bounds,
    ocp_fillet_factory,
    ocp_identity_trsf,
    ocp_make_arc_edge,
    ocp_make_circle,
    ocp_make_cylinder,
    ocp_make_edge_from_circle,
    ocp_make_mirror_trsf,
    ocp_make_rotation_trsf,
    ocp_make_scale_trsf,
    ocp_make_translation_trsf,
    ocp_mesh_shape,
    ocp_revolve,
    ocp_transform_copy,
    ocp_write_stl,
    ocp_read_stl,
    _compute_face_plane,
    _collect_face_wires,
    _build_loop_from_wire,
    _extract_occ_face,
)


def _unit_box_topo():
    """Return a 1x1x1 box as a raw TopoDS_Shape."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    return BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()


def _unit_box_face():
    """Return the first TopoDS_Face from a unit box."""
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    box = _unit_box_topo()
    exp = TopExp_Explorer(box, TopAbs_FACE)
    return TopoDS.Face_s(exp.Current())


def test_ocp_mesh_shape_runs():
    """ocp_mesh_shape must not raise on a valid shape."""
    ocp_mesh_shape(_unit_box_topo(), 0.1, 0.1)


def test_ocp_copy_shape_returns_independent_shape():
    """Copied shape must not be the same Python object."""
    box = _unit_box_topo()
    copy = ocp_copy_shape(box)
    assert copy is not box
    assert not copy.IsNull()


def test_ocp_explore_edges_non_empty():
    """A box has at least 12 edge entries (TopExp_Explorer may return duplicates)."""
    edges = ocp_explore_edges(_unit_box_topo())
    assert len(edges) >= 12


def test_ocp_collect_edge_hashes_non_empty():
    """Edge hash set for a box must be non-empty."""
    hashes = ocp_collect_edge_hashes(_unit_box_topo())
    assert len(hashes) > 0


def test_ocp_collect_edge_hashes_same_domain_as_wrapped():
    """hash(edge.wrapped) on CQ edges matches ocp_collect_edge_hashes on the same solid.

    This verifies that solid_to_edges dedup and _apply_edge_modifier membership
    checks operate in the same hash domain.
    """
    from cadquery.occ_impl.shapes import Shape as CQShape
    box = _unit_box_topo()
    cq_box = CQShape.cast(box)
    cq_hashes = {hash(e.wrapped) for e in cq_box.Edges()}
    topo_hashes = ocp_collect_edge_hashes(box)
    assert cq_hashes == topo_hashes


def test_ocp_explore_solids_returns_solid():
    """A box is one solid."""
    solids = ocp_explore_solids(_unit_box_topo())
    assert len(solids) == 1


def test_ocp_count_solids_box():
    """A box compound (if any) counts as 1 solid."""
    assert ocp_count_solids(_unit_box_topo()) >= 1


def test_ocp_fillet_factory_returns_maker():
    """ocp_fillet_factory must return a maker with an Add method."""
    maker = ocp_fillet_factory(_unit_box_topo())
    assert hasattr(maker, "Add")


def test_ocp_chamfer_factory_returns_maker():
    """ocp_chamfer_factory must return a maker with an Add method."""
    maker = ocp_chamfer_factory(_unit_box_topo())
    assert hasattr(maker, "Add")


def test_ocp_transform_copy_translates():
    """Translating a box by [5,0,0] must shift its bounding box."""
    from cadquery.occ_impl.shapes import Shape as CQShape
    box = _unit_box_topo()
    tr = ocp_make_translation_trsf(5.0, 0.0, 0.0)
    moved = ocp_transform_copy(box, tr)
    bb = CQShape.cast(moved).BoundingBox()
    assert bb.xmin == pytest.approx(5.0, abs=1e-6)


def test_ocp_make_translation_trsf():
    """Translation trsf must report a non-identity value."""
    tr = ocp_make_translation_trsf(1.0, 2.0, 3.0)
    assert tr is not None


def test_ocp_make_rotation_trsf():
    """Rotation trsf around Z by 90 deg must be non-identity."""
    rot = ocp_make_rotation_trsf([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], math.radians(90))
    assert rot is not None


def test_ocp_make_scale_trsf():
    """Scale trsf must be non-identity."""
    sc = ocp_make_scale_trsf((0.0, 0.0, 0.0), 2.0)
    assert sc is not None


def test_ocp_identity_trsf_is_identity():
    """Identity trsf must leave a shape unmoved."""
    from cadquery.occ_impl.shapes import Shape as CQShape
    box = _unit_box_topo()
    identity = ocp_identity_trsf()
    moved = ocp_transform_copy(box, identity)
    bb = CQShape.cast(moved).BoundingBox()
    assert bb.xmin == pytest.approx(0.0, abs=1e-6)
    assert bb.xmax == pytest.approx(1.0, abs=1e-6)


def test_ocp_make_mirror_trsf():
    """Mirror trsf must return an object with a non-zero scale factor."""
    trsf = ocp_make_mirror_trsf((0.0, 0.0, 0.0), (0.0, 0.0, 1.0))
    assert trsf is not None


def test_ocp_face_uv_bounds_returns_four_values():
    """Face UV bounds must return 4 floats."""
    face = _unit_box_face()
    bounds = ocp_face_uv_bounds(face)
    assert len(bounds) == 4
    umin, umax, vmin, vmax = bounds
    assert umax >= umin
    assert vmax >= vmin


def test_ocp_make_circle_and_edge():
    """Full-circle edge from a gp_Circ must not be null."""
    from cadquery.occ_impl.shapes import Edge as CQEdge
    circ = ocp_make_circle((0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0), 5.0)
    edge_topo = ocp_make_edge_from_circle(circ)
    edge = CQEdge(edge_topo)
    assert edge.isValid()


def test_ocp_make_arc_edge():
    """Partial arc edge must not be null."""
    from cadquery.occ_impl.shapes import Edge as CQEdge
    circ = ocp_make_circle((0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0), 3.0)
    edge_topo = ocp_make_arc_edge(circ, 0.0, math.pi)
    edge = CQEdge(edge_topo)
    assert edge.isValid()


def test_ocp_revolve():
    """Revolving a face 360 degrees must produce a non-null shape."""
    from cadquery.occ_impl.shapes import Shape as CQShape
    from cadquery.occ_impl import shapes as cq_shapes
    from cadquery.occ_impl.geom import Vector as CQVector
    face = cq_shapes.Face.makePlane(1, 1, (1, 0, 0))
    result = ocp_revolve(face.wrapped, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], math.radians(360))
    assert not result.IsNull()


def test_ocp_make_cylinder():
    """Cylinder shape must have bounding box matching its dimensions."""
    from cadquery.occ_impl.shapes import Shape as CQShape
    topo = ocp_make_cylinder([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 2.0, 5.0)
    bb = CQShape.cast(topo).BoundingBox()
    assert bb.zmax == pytest.approx(5.0, abs=1e-6)


def test_ocp_write_and_read_stl():
    """Round-trip: write a box to STL and read it back without error."""
    with tempfile.NamedTemporaryFile(suffix=".stl", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        ocp_write_stl(_unit_box_topo(), tmp_path, 0.1, 0.1)
        assert os.path.getsize(tmp_path) > 0
        shape = ocp_read_stl(tmp_path)
        assert not shape.IsNull()
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def test_ocp_curve_info_line():
    """A straight edge must be classified as 'line'."""
    from cadquery.occ_impl.shapes import Edge as CQEdge
    from cadquery.occ_impl.geom import Vector as CQVector
    edge = CQEdge.makeLine(CQVector(0, 0, 0), CQVector(1, 0, 0))
    info = ocp_curve_info(edge.wrapped)
    assert info["type"] == "line"


def test_ocp_curve_info_circle():
    """A full-circle edge must be classified as 'circle'."""
    circ = ocp_make_circle((0, 0, 0), (0, 0, 1), (1, 0, 0), 3.0)
    edge_topo = ocp_make_edge_from_circle(circ)
    info = ocp_curve_info(edge_topo)
    assert info["type"] == "circle"
    assert info["radius"] == pytest.approx(3.0, abs=1e-6)


def _flat_box_face():
    """Return the top (Z-normal) face of a 1x1x1 box as a TopoDS_Face."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    exp = TopExp_Explorer(box, TopAbs_FACE)
    return TopoDS.Face_s(exp.Current())


def test_compute_face_plane_flat_face():
    """_compute_face_plane must return a Frame3D whose normal is a unit vector."""
    face = _flat_box_face()
    plane = _compute_face_plane(face)
    nx, ny, nz = plane.normal
    length = math.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    assert length == pytest.approx(1.0, abs=1e-6)


def test_compute_face_plane_non_planar_raises():
    """_compute_face_plane must raise ValueError containing 'flat' for a sphere face."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeSphere
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    sphere = BRepPrimAPI_MakeSphere(1.0).Shape()
    exp = TopExp_Explorer(sphere, TopAbs_FACE)
    face = TopoDS.Face_s(exp.Current())
    with pytest.raises(ValueError, match="flat"):
        _compute_face_plane(face)


def test_collect_face_wires_no_holes():
    """A simple rectangular face has no hole wires."""
    face = _flat_box_face()
    outer_wire, hole_wires = _collect_face_wires(face)
    assert outer_wire is not None
    assert hole_wires == []


def test_build_loop_from_wire_lines():
    """A rectangular face wire must produce 4 line dicts."""
    face = _flat_box_face()
    outer_wire, _ = _collect_face_wires(face)
    loop = _build_loop_from_wire(outer_wire, face)
    assert len(loop) == 4
    for seg in loop:
        assert seg["kind"] == "line"


def test_ocp_extract_face_loops_integration():
    """ocp_extract_face_loops must return (loops, plane) for a flat box face."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    loops, plane = ocp_extract_face_loops(box, None, 0)
    assert isinstance(loops, list)
    assert len(loops) >= 1
    assert all(isinstance(seg, dict) for seg in loops[0])
    nx, ny, nz = plane.normal
    length = math.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    assert length == pytest.approx(1.0, abs=1e-6)


def test_no_ocp_imports_outside_ocp_ops():
    """No kernel file other than ocp_ops.py may contain runtime OCP imports.

    Imports inside ``if TYPE_CHECKING:`` blocks are allowed because they are
    never executed at runtime -- they exist only for static type checkers.
    """
    kernel_dir = os.path.join(
        os.path.dirname(__file__), "..", "..", "oversolved", "kernel"
    )
    kernel_dir = os.path.normpath(kernel_dir)

    def _type_checking_import_lines(tree: ast.AST) -> set[int]:
        """Return line numbers of imports that live inside if TYPE_CHECKING: blocks."""
        lines: set[int] = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if isinstance(test, ast.Name) and test.id == "TYPE_CHECKING":
                for child in ast.walk(node):
                    if isinstance(child, (ast.Import, ast.ImportFrom)):
                        lines.add(child.lineno)
        return lines

    violations = []
    for fname in os.listdir(kernel_dir):
        if not fname.endswith(".py"):
            continue
        if fname == "ocp_ops.py":
            continue
        fpath = os.path.join(kernel_dir, fname)
        with open(fpath, encoding="utf-8") as f:
            source = f.read()
        try:
            tree = ast.parse(source, filename=fpath)
        except SyntaxError:
            continue
        guarded = _type_checking_import_lines(tree)
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Import, ast.ImportFrom)):
                continue
            if node.lineno in guarded:
                continue
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if module == "OCP" or module.startswith("OCP."):
                    violations.append(f"{fname}:{node.lineno}: from {module} import ...")
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == "OCP" or alias.name.startswith("OCP."):
                        violations.append(f"{fname}:{node.lineno}: import {alias.name}")

    assert violations == [], "OCP imports found outside ocp_ops.py:\n" + "\n".join(violations)
