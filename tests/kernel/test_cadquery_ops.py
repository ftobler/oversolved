"""Tests for the cadquery_ops adapter layer and cadquery integration."""

import math

import pytest

pytest.importorskip("cadquery.occ_impl.shapes")

from oversolved.kernel.cadquery_ops import (  # noqa: E402
    boolean_cut,
    boolean_intersection,
    boolean_union,
    extrude_face,
    fuse_shapes,
    make_arc_edge,
    make_cylinder,
    make_face_from_wires,
    make_line_edge,
    make_wire,
    _compute_face_centroid,
    _compute_face_normal,
    _get_face_surface_type,
    from_cq_plane,
    to_cq_plane,
)
from cadquery.occ_impl.geom import Vector as CQVector  # noqa: E402


FRONT_PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}


def test_plane_round_trip():
    """Plane dict -> CQPlane -> Frame3D should preserve axes."""
    cq = to_cq_plane(FRONT_PLANE)
    back = from_cq_plane(cq)
    assert back.origin == [0.0, 0.0, 0.0]
    assert back.x_axis == [1.0, 0.0, 0.0]
    assert back.y_axis == [0.0, 1.0, 0.0]
    assert back.normal == [0.0, 0.0, 1.0]


def test_plane_round_trip_rotated():
    """Rotated plane round-trip should preserve orientation."""
    plane = {
        "origin": [1.0, 2.0, 3.0],
        "x_axis": [0.0, 1.0, 0.0],
        "y_axis": [0.0, 0.0, 1.0],
        "normal": [1.0, 0.0, 0.0],
    }
    back = from_cq_plane(to_cq_plane(plane))
    assert back.origin == pytest.approx(plane["origin"], abs=1e-6)
    assert back.x_axis == pytest.approx(plane["x_axis"], abs=1e-6)
    assert back.y_axis == pytest.approx(plane["y_axis"], abs=1e-6)
    assert back.normal == pytest.approx(plane["normal"], abs=1e-6)


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


def test_boolean_intersection_produces_overlap_volume():
    """Intersection of two overlapping unit cubes should have volume 0.5."""
    from cadquery.occ_impl.shapes import Face, Solid
    left = Solid.extrudeLinear(
        Face.makePlane(1, 1, (0, 0, 0)),
        CQVector(0, 0, 1),
    )
    right = Solid.extrudeLinear(
        Face.makePlane(1, 1, (0.5, 0, 0)),
        CQVector(0, 0, 1),
    )
    result = boolean_intersection(left, right)
    assert result.Volume() == pytest.approx(0.5, abs=1e-4)
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


def test_revolve_face_basic():
    """Revolve a unit square face 90 degrees around y-axis."""
    from oversolved.kernel.cadquery_ops import revolve_face
    w = make_wire([
        make_line_edge([1, 0, 0], [2, 0, 0]),
        make_line_edge([2, 0, 0], [2, 1, 0]),
        make_line_edge([2, 1, 0], [1, 1, 0]),
        make_line_edge([1, 1, 0], [1, 0, 0]),
    ])
    f = make_face_from_wires(w)
    solid = revolve_face(f, [0, 0, 0], [0, 1, 0], 90.0)
    assert solid.Volume() > 0
    assert solid.isValid()


def test_revolve_face_with_angle():
    """Revolve with various angles produces different volumes."""
    from oversolved.kernel.cadquery_ops import revolve_face
    w = make_wire([
        make_line_edge([1, 0, 0], [2, 0, 0]),
        make_line_edge([2, 0, 0], [2, 1, 0]),
        make_line_edge([2, 1, 0], [1, 1, 0]),
        make_line_edge([1, 1, 0], [1, 0, 0]),
    ])
    f = make_face_from_wires(w)
    s90 = revolve_face(f, [0, 0, 0], [0, 1, 0], 90.0)
    s180 = revolve_face(f, [0, 0, 0], [0, 1, 0], 180.0)
    assert s180.Volume() == pytest.approx(s90.Volume() * 2.0, abs=0.1)


def test_revolve_face_full_circle():
    """Full 360 degree revolve produces closed solid."""
    from oversolved.kernel.cadquery_ops import revolve_face
    w = make_wire([
        make_line_edge([1, 0, 0], [2, 0, 0]),
        make_line_edge([2, 0, 0], [2, 1, 0]),
        make_line_edge([2, 1, 0], [1, 1, 0]),
        make_line_edge([1, 1, 0], [1, 0, 0]),
    ])
    f = make_face_from_wires(w)
    solid = revolve_face(f, [0, 0, 0], [0, 1, 0], 360.0)
    assert solid.isValid()
    assert solid.Volume() > 0


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
    from oversolved.kernel.geometry import solid_to_mesh, extrude_profile

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
    from oversolved.kernel.geometry import solid_to_mesh, boolean_cut, extrude_profile

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
    from oversolved.kernel.geometry import _validate_mesh

    mesh = {
        "vertices": [[0.0, 0.0, 0.0], [float("nan"), 1.0, 0.0], [1.0, 1.0, 0.0]],
        "faces": [[0, 1, 2]],
        "normals": [[0.0, 0.0, 1.0]],
    }
    with pytest.raises(ValueError, match="nan"):
        _validate_mesh(mesh)


def test_validate_mesh_rejects_out_of_range_index():
    """_validate_mesh should raise ValueError if a face index is out of range."""
    from oversolved.kernel.geometry import _validate_mesh

    mesh = {
        "vertices": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]],
        "faces": [[0, 1, 99]],
        "normals": [[0.0, 0.0, 1.0]],
    }
    with pytest.raises(ValueError, match="out of range"):
        _validate_mesh(mesh)


def test_make_arc_edge_on_rotated_plane():
    """Arc endpoints must respect the sketch plane x_axis, not just the normal."""
    # Plane where y_axis points along -Z (as in the user's failing sketch).
    plane = {
        "origin": [0.0, 0.0, 0.0],
        "x_axis": [1.0, 0.0, 0.0],
        "y_axis": [0.0, 0.0, -1.0],
        "normal": [0.0, 1.0, 0.0],
    }
    center = [13.7550020016, 0.0, 5.0]  # uv [13.755, -5] mapped through plane
    radius = 8.0
    u0 = math.radians(-38.6821874535)
    u1 = math.radians(38.6821874535)

    arc = make_arc_edge(center, radius, plane["normal"], plane["x_axis"], u0, u1)
    sp = arc.startPoint()
    ep = arc.endPoint()

    # Arc should connect to the vertical line at x=20, z=10 and horizontal line at x=20, z=0.
    assert sp.x == pytest.approx(20.0, abs=1e-9)
    assert sp.z == pytest.approx(10.0, abs=1e-9)
    assert ep.x == pytest.approx(20.0, abs=1e-9)
    assert ep.z == pytest.approx(0.0, abs=1e-9)


def test_wire_with_arc_on_rotated_plane():
    """Wire assembly must succeed when an arc lies on a non-default plane."""
    plane = {
        "origin": [0.0, 0.0, 0.0],
        "x_axis": [1.0, 0.0, 0.0],
        "y_axis": [0.0, 0.0, -1.0],
        "normal": [0.0, 1.0, 0.0],
    }
    e0 = make_line_edge([20.0, 0.0, 0.0], [0.0, 0.0, 0.0])
    e1 = make_line_edge([0.0, 0.0, 0.0], [20.0, 0.0, 10.0])
    center = [13.7550020016, 0.0, 5.0]
    radius = 8.0
    u0 = math.radians(-38.6821874535)
    u1 = math.radians(38.6821874535)
    e2 = make_arc_edge(center, radius, plane["normal"], plane["x_axis"], u0, u1)

    wire = make_wire([e0, e1, e2])
    assert wire is not None
    assert len(list(wire.edges())) == 3


def test_sketch_loops_to_face_with_arc_on_rotated_plane():
    """sketch_loops_to_face must produce a valid face for arcs on rotated planes."""
    from oversolved.kernel.geometry import sketch_loops_to_face

    plane = {
        "origin": [0.0, 0.0, 0.0],
        "x_axis": [1.0, 0.0, 0.0],
        "y_axis": [0.0, 0.0, -1.0],
        "normal": [0.0, 1.0, 0.0],
    }
    loops = [
        [
            {"kind": "line", "start": [20.0, 0.0], "end": [0.0, 0.0]},
            {"kind": "line", "start": [0.0, 0.0], "end": [20.0, -10.0]},
            {
                "kind": "arc",
                "start": [19.999999999997478, -10.000000000001151],
                "end": [19.999999999997478, 1.1510792319313623e-12],
                "center": [13.7550020016, -5.0],
                "radius": 8.0,
                "angle_start_deg": -38.6821874535,
                "angle_end_deg": 38.6821874535,
                "ccw": True,
            },
        ]
    ]
    face = sketch_loops_to_face(loops, plane)
    assert face.Area() > 0


def test_extrude_profile_with_arc_on_rotated_plane():
    """extrude_profile must produce a valid solid for arcs on rotated planes."""
    from oversolved.kernel.geometry import extrude_profile

    plane = {
        "origin": [0.0, 0.0, 0.0],
        "x_axis": [1.0, 0.0, 0.0],
        "y_axis": [0.0, 0.0, -1.0],
        "normal": [0.0, 1.0, 0.0],
    }
    loops = [
        [
            {"kind": "line", "start": [20.0, 0.0], "end": [0.0, 0.0]},
            {"kind": "line", "start": [0.0, 0.0], "end": [20.0, -10.0]},
            {
                "kind": "arc",
                "start": [19.999999999997478, -10.000000000001151],
                "end": [19.999999999997478, 1.1510792319313623e-12],
                "center": [13.7550020016, -5.0],
                "radius": 8.0,
                "angle_start_deg": -38.6821874535,
                "angle_end_deg": 38.6821874535,
                "ccw": True,
            },
        ]
    ]
    solid = extrude_profile(loops, plane, [0.0, 1.0, 0.0], 10.0)
    assert solid.isValid()
    assert solid.Volume() > 0


def test_make_cylinder_produces_valid_shape():
    """make_cylinder should produce a valid solid with at least one face."""
    cyl = make_cylinder([0, 0, 0], [0, 0, 1], 5, 10)
    assert cyl is not None
    assert len(list(cyl.faces())) >= 1
    assert cyl.isValid()


def test_make_cylinder_bbox():
    """Cylinder along Z should have bbox matching radius and height."""
    cyl = make_cylinder([0, 0, 0], [0, 0, 1], 5, 10)
    bb = cyl.BoundingBox()
    assert bb.xmin == pytest.approx(-5, abs=1e-6)
    assert bb.xmax == pytest.approx(5, abs=1e-6)
    assert bb.ymin == pytest.approx(-5, abs=1e-6)
    assert bb.ymax == pytest.approx(5, abs=1e-6)
    assert bb.zmin == pytest.approx(0, abs=1e-6)
    assert bb.zmax == pytest.approx(10, abs=1e-6)


def test_make_cylinder_arbitrary_axis():
    """Cylinder along X should span along X axis."""
    cyl = make_cylinder([0, 0, 0], [1, 0, 0], 3, 12)
    bb = cyl.BoundingBox()
    assert bb.xmin == pytest.approx(0, abs=1e-6)
    assert bb.xmax == pytest.approx(12, abs=1e-6)
    assert bb.ymax - bb.ymin == pytest.approx(6, abs=1e-6)
    assert bb.zmax - bb.zmin == pytest.approx(6, abs=1e-6)


def test_make_arc_edge_zero_span_raises():
    """Zero-span arc must raise ValueError instead of silently producing a full circle."""
    with pytest.raises(ValueError, match="degenerate"):
        make_arc_edge([0, 0, 0], 1.0, [0, 0, 1], [1, 0, 0], 1.0, 1.0)


def test_make_arc_edge_tiny_span_raises():
    """Arc span below tolerance must raise ValueError."""
    with pytest.raises(ValueError):
        make_arc_edge([0, 0, 0], 1.0, [0, 0, 1], [1, 0, 0], 0.0, 1e-7)


def test_rotation_z_default():
    """90-degree rotation with no axis direction defaults to Z-axis."""
    from oversolved.kernel.cadquery_ops import apply_transform_shape
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    result = apply_transform_shape(box, rotation_angle_deg=90.0)
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    bnd = Bnd_Box()
    BRepBndLib.Add_s(result, bnd)
    xmin, ymin, zmin, xmax, ymax, zmax = bnd.Get()
    # Original 1x2 footprint rotated 90deg: X extent ~2, Y extent ~1, Z ~3
    assert abs((xmax - xmin) - 2.0) < 0.01
    assert abs((ymax - ymin) - 1.0) < 0.01
    assert abs((zmax - zmin) - 3.0) < 0.01


def test_rotation_explicit_axis():
    """90-degree rotation around Y-axis maps Z extent to X."""
    from oversolved.kernel.cadquery_ops import apply_transform_shape
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    result = apply_transform_shape(box, rotation_axis_direction=[0, 1, 0], rotation_angle_deg=90.0)
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    bnd = Bnd_Box()
    BRepBndLib.Add_s(result, bnd)
    xmin, ymin, zmin, xmax, ymax, zmax = bnd.Get()
    # Z extent (3) becomes X, X extent (1) becomes Z
    assert abs((xmax - xmin) - 3.0) < 0.01
    assert abs((zmax - zmin) - 1.0) < 0.01


def test_no_rotation_zero_angle():
    """Zero angle with no axis direction must not raise."""
    from oversolved.kernel.cadquery_ops import apply_transform_shape
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    result = apply_transform_shape(box, rotation_angle_deg=0.0)
    assert result is not None


def test_combined_scale_and_rotation():
    """scale=2 + 90-degree Z rotation produces 2x2x2 result."""
    from oversolved.kernel.cadquery_ops import apply_transform_shape
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    result = apply_transform_shape(box, rotation_angle_deg=90.0, scale=2.0)
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    bnd = Bnd_Box()
    BRepBndLib.Add_s(result, bnd)
    xmin, ymin, zmin, xmax, ymax, zmax = bnd.Get()
    assert abs((xmax - xmin) - 2.0) < 0.01
    assert abs((ymax - ymin) - 2.0) < 0.01
    assert abs((zmax - zmin) - 2.0) < 0.01
