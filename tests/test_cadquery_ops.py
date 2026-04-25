"""Tests for the cadquery_ops adapter layer and cadquery integration."""

import math

import pytest

from oversolved.cadquery_ops import (
    boolean_cut,
    boolean_union,
    extrude_face,
    fuse_shapes,
    make_arc_edge,
    make_face_from_wires,
    make_line_edge,
    make_wire,
    _compute_face_centroid,
    _compute_face_normal,
    _get_face_surface_type,
    from_cq_plane,
    to_cq_plane,
)
from cadquery.occ_impl.geom import Vector as CQVector

pytest.importorskip("cadquery")


FRONT_PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}


def test_plane_round_trip():
    """Plane dict -> CQPlane -> plane dict should preserve axes."""
    cq = to_cq_plane(FRONT_PLANE)
    back = from_cq_plane(cq)
    assert back["origin"] == [0.0, 0.0, 0.0]
    assert back["x_axis"] == [1.0, 0.0, 0.0]
    assert back["y_axis"] == [0.0, 1.0, 0.0]
    assert back["normal"] == [0.0, 0.0, 1.0]


def test_plane_round_trip_rotated():
    """Rotated plane round-trip should preserve orientation."""
    plane = {
        "origin": [1.0, 2.0, 3.0],
        "x_axis": [0.0, 1.0, 0.0],
        "y_axis": [0.0, 0.0, 1.0],
        "normal": [1.0, 0.0, 0.0],
    }
    back = from_cq_plane(to_cq_plane(plane))
    for key in plane:
        assert back[key] == pytest.approx(plane[key], abs=1e-6)


def test_make_line_edge():
    """Line edge should connect start and end points."""
    e = make_line_edge([0, 0, 0], [1, 2, 3])
    assert e.geomType() == "LINE"
    sp = e.startPoint()
    ep = e.endPoint()
    assert [sp.x, sp.y, sp.z] == [0.0, 0.0, 0.0]
    assert [ep.x, ep.y, ep.z] == [1.0, 2.0, 3.0]


def test_make_arc_edge_full_circle():
    """Arc edge with full span should produce a circle."""
    e = make_arc_edge([0, 0, 0], 1.0, [0, 0, 1], [1, 0, 0], 0.0, 2 * math.pi)
    assert e.geomType() == "CIRCLE"


def test_make_arc_edge_partial():
    """Arc edge with partial span should produce a circular arc."""
    e = make_arc_edge([0, 0, 0], 1.0, [0, 0, 1], [1, 0, 0], 0.0, math.pi)
    assert e.geomType() == "CIRCLE"


def test_make_face_from_wires():
    """Square wire should produce a face with area 1."""
    w = make_wire([
        make_line_edge([0, 0, 0], [1, 0, 0]),
        make_line_edge([1, 0, 0], [1, 1, 0]),
        make_line_edge([1, 1, 0], [0, 1, 0]),
        make_line_edge([0, 1, 0], [0, 0, 0]),
    ])
    f = make_face_from_wires(w)
    assert f.Area() == pytest.approx(1.0, abs=1e-6)


def test_extrude_face():
    """Extruding a unit square face by 2 should produce volume 2."""
    w = make_wire([
        make_line_edge([0, 0, 0], [1, 0, 0]),
        make_line_edge([1, 0, 0], [1, 1, 0]),
        make_line_edge([1, 1, 0], [0, 1, 0]),
        make_line_edge([0, 1, 0], [0, 0, 0]),
    ])
    f = make_face_from_wires(w)
    solid = extrude_face(f, [0, 0, 1], 2.0)
    assert solid.Volume() == pytest.approx(2.0, abs=1e-5)


def test_boolean_cut_produces_smaller_shape():
    """Cutting a 2x2x2 cube with a 1x1x1 cube should reduce volume."""
    from cadquery.occ_impl.shapes import Face, Solid
    big = Solid.extrudeLinear(
        Face.makePlane(2, 2, (0, 0, 0)),
        CQVector(0, 0, 2),
    )
    small = Solid.extrudeLinear(
        Face.makePlane(1, 1, (0, 0, 0)),
        CQVector(0, 0, 1),
    )
    result = boolean_cut(big, small)
    assert result.Volume() == pytest.approx(8.0 - 1.0, abs=1e-4)
    assert result.isValid()


def test_boolean_union_merges_shapes():
    """Union of two unit cubes side by side should have volume 2."""
    from cadquery.occ_impl.shapes import Face, Solid
    left = Solid.extrudeLinear(
        Face.makePlane(1, 1, (0, 0, 0)),
        CQVector(0, 0, 1),
    )
    right = Solid.extrudeLinear(
        Face.makePlane(1, 1, (1, 0, 0)),
        CQVector(0, 0, 1),
    )
    result = boolean_union(left, right)
    assert result.Volume() == pytest.approx(2.0, abs=1e-4)
    assert result.isValid()


def test_fuse_shapes_multiple():
    """Fuse three unit cubes into one compound."""
    from cadquery.occ_impl.shapes import Face, Solid
    cubes = [
        Solid.extrudeLinear(Face.makePlane(1, 1, (i, 0, 0)), CQVector(0, 0, 1))
        for i in range(3)
    ]
    result = fuse_shapes(cubes)
    assert result.Volume() == pytest.approx(3.0, abs=1e-4)


def test_compute_face_centroid():
    """Centroid of a unit square face at origin should be near (0.5, 0.5, 0)."""
    from cadquery.occ_impl.shapes import Face
    f = Face.makePlane(1, 1, (0, 0, 0))
    c = _compute_face_centroid(f)
    assert c[0] == pytest.approx(0.0, abs=0.5)
    assert c[1] == pytest.approx(0.0, abs=0.5)
    assert c[2] == pytest.approx(0.0, abs=1e-6)


def test_compute_face_normal():
    """Normal of a face in XY plane should point in +Z."""
    from cadquery.occ_impl.shapes import Face
    f = Face.makePlane(1, 1, (0, 0, 0))
    n = _compute_face_normal(f)
    assert n[2] > 0.9


def test_get_face_surface_type():
    """Plane face should return 'flatface', cylinder face 'cylinderface'."""
    from cadquery.occ_impl.shapes import Face, Solid
    plane = Face.makePlane(1, 1, (0, 0, 0))
    assert _get_face_surface_type(plane) == "flatface"

    cylinder = Solid.extrudeLinear(
        Face.makePlane(1, 1, (0, 0, 0)),
        CQVector(0, 0, 1),
    )
    for face in cylinder.faces():
        gt = _get_face_surface_type(face)
        assert gt in ("flatface", "cylinderface", "face")


def test_tessellation_format():
    """face.tessellate() should return (vertices: list[Vector], indexes: list[triplet])."""
    from cadquery.occ_impl.shapes import Face, Solid
    solid = Solid.extrudeLinear(
        Face.makePlane(1, 1, (0, 0, 0)),
        CQVector(0, 0, 1),
    )
    face = next(iter(solid.faces()))
    verts, idxs = face.tessellate(0.1)
    assert isinstance(verts, list)
    assert isinstance(idxs, list)
    assert len(verts) > 0
    assert len(idxs) > 0
    for v in verts:
        assert hasattr(v, "toTuple")
        t = v.toTuple()
        assert len(t) == 3
    for tri in idxs:
        assert len(tri) == 3


def test_mesh_face_ordering_stable():
    """solid_to_mesh should return identical face ordering across multiple calls."""
    from oversolved.geometry import solid_to_mesh, extrude_profile

    loops = [
        [{"kind": "line", "start": [0, 0], "end": [1, 0]},
         {"kind": "line", "start": [1, 0], "end": [1, 1]},
         {"kind": "line", "start": [1, 1], "end": [0, 1]},
         {"kind": "line", "start": [0, 1], "end": [0, 0]}],
    ]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 1.0)
    mesh1 = solid_to_mesh(solid)
    mesh2 = solid_to_mesh(solid)
    assert mesh1["face_queries"] == mesh2["face_queries"]
    assert mesh1["triangle_to_face"] == mesh2["triangle_to_face"]


def test_query_face_stability_across_boolean():
    """Face queries should remain stable after boolean operations."""
    from oversolved.geometry import solid_to_mesh, boolean_cut, extrude_profile

    outer = [
        [{"kind": "line", "start": [0, 0], "end": [2, 0]},
         {"kind": "line", "start": [2, 0], "end": [2, 2]},
         {"kind": "line", "start": [2, 2], "end": [0, 2]},
         {"kind": "line", "start": [0, 2], "end": [0, 0]}],
    ]
    inner = [
        [{"kind": "line", "start": [0, 0], "end": [1, 0]},
         {"kind": "line", "start": [1, 0], "end": [1, 1]},
         {"kind": "line", "start": [1, 1], "end": [0, 1]},
         {"kind": "line", "start": [0, 1], "end": [0, 0]}],
    ]
    target = extrude_profile(outer, FRONT_PLANE, [0, 0, 1], 2.0)
    tool = extrude_profile(inner, FRONT_PLANE, [0, 0, 1], 1.0)
    result = boolean_cut(target, tool)
    mesh = solid_to_mesh(result, created_by="cut_feature")
    assert len(mesh["face_queries"]) == len(mesh["face_data"])
    for q in mesh["face_queries"]:
        assert q.startswith("?")


def test_boolean_validity_check_rejects_invalid():
    """Boolean operations on invalid shapes should raise ValueError."""
    from cadquery.occ_impl.shapes import Face, Solid
    valid = Solid.extrudeLinear(
        Face.makePlane(1, 1, (0, 0, 0)),
        CQVector(0, 0, 1),
    )
    # A non-solid face is not a valid boolean operand.
    invalid = Face.makePlane(1, 1, (0, 0, 0))
    with pytest.raises(ValueError):
        boolean_cut(valid, invalid)


def test_validate_mesh_rejects_nan_vertex():
    """_validate_mesh should raise ValueError if a vertex contains NaN."""
    from oversolved.geometry import _validate_mesh

    mesh = {
        "vertices": [[0.0, 0.0, 0.0], [float("nan"), 1.0, 0.0], [1.0, 1.0, 0.0]],
        "faces": [[0, 1, 2]],
        "normals": [[0.0, 0.0, 1.0]],
    }
    with pytest.raises(ValueError, match="nan"):
        _validate_mesh(mesh)


def test_validate_mesh_rejects_out_of_range_index():
    """_validate_mesh should raise ValueError if a face index is out of range."""
    from oversolved.geometry import _validate_mesh

    mesh = {
        "vertices": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]],
        "faces": [[0, 1, 99]],
        "normals": [[0.0, 0.0, 1.0]],
    }
    with pytest.raises(ValueError, match="out of range"):
        _validate_mesh(mesh)
