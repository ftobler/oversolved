"""Tests for geometry.py 3D OCC functions."""

import math
import tempfile
import pytest
from solver_helpers import assert_mesh_valid

pytest.importorskip("OCP.gp")

from oversolved.geometry import (  # noqa: E402
    sketch_loops_to_face,
    extrude_face,
    extrude_profile,
    revolve_face,
    boolean_cut,
    boolean_union,
    solid_to_mesh,
    solid_to_edges,
    solid_to_vertices,
    step_file_to_shape,
    _validate_mesh,
)
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: E402
from OCP.STEPControl import STEPControl_Writer, STEPControl_StepModelType  # noqa: E402
from oversolved.query import make_ancestry_query  # noqa: E402


def _unwrap(shape):
    """Return the underlying TopoDS_Shape from a cadquery or raw OCC shape."""
    return shape.wrapped if hasattr(shape, "wrapped") else shape


FRONT_PLANE = {
    "origin": [0, 0, 0],
    "x_axis": [1, 0, 0],
    "y_axis": [0, 1, 0],
    "normal": [0, 0, 1],
}

TOP_PLANE = {
    "origin": [0, 0, 0],
    "x_axis": [1, 0, 0],
    "y_axis": [0, 0, 1],
    "normal": [0, 1, 0],
}


def pts_to_edge_loop(points_2d: list) -> list:
    """Convert a list of 2D UV points to a loop of line edge dicts."""
    n = len(points_2d)
    return [
        {
            "kind": "line",
            "start": list(points_2d[i]),
            "end": list(points_2d[(i + 1) % n]),
        }
        for i in range(n)
    ]


def make_polygon_face(points_2d):
    """Make a face from 2D points for testing."""
    loops = [pts_to_edge_loop(points_2d)]
    return sketch_loops_to_face(loops, FRONT_PLANE)


def test_unit_square_extrude():
    """1. unit square extrude - loops=[[[0,0],[1,0],[1,1],[0,1]]]，FRONT_PLANE，direction=[0,0,1]，distance=1.0"""
    loops = [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 1.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    zs = [v[2] for v in mesh["vertices"]]
    assert min(zs) < 0.1, "should have vertex at z≈0"
    assert max(zs) > 0.9, "should have vertex at z≈1"
    for z in zs:
        assert 0 <= z <= 1, f"z={z} should be in [0,1]"


def test_unit_circle_extrude():
    """2. unit circle extrude - 32 points，distance=2.0"""
    n = 32
    angle_step = 360 / n
    circle_points = []
    for i in range(n):
        angle = math.radians(i * angle_step)
        circle_points.append([math.cos(angle), math.sin(angle)])
    loops = [pts_to_edge_loop(circle_points)]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 2.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    assert len(mesh["vertices"]) > 60
    zs = [v[2] for v in mesh["vertices"]]
    assert abs(max(zs) - 2.0) < 0.1


def test_top_plane_extrude():
    """3. top-plane extrude - square on TOP_PLANE (normal=[0,1,0])"""
    loops = [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])]
    solid = extrude_profile(loops, TOP_PLANE, [0, 1, 0], 1.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    ys = [v[1] for v in mesh["vertices"]]
    for y in ys:
        assert 0 <= y <= 1, f"y={y} should be in [0,1]"


def test_normals_are_unit_length():
    """4. normals are unit length"""
    loops = [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 1.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    for normal in mesh["normals"]:
        mag = math.sqrt(sum(x * x for x in normal))
        assert abs(mag - 1.0) < 1e-6


def test_hole_in_profile():
    """5. hole in profile - outer [[0,0],[4,0],[4,4],[0,4]], hole [[1,1],[3,1],[3,3],[1,3]]"""
    outer = pts_to_edge_loop([[0, 0], [4, 0], [4, 4], [0, 4]])
    hole = pts_to_edge_loop([[1, 1], [3, 1], [3, 3], [1, 3]])
    loops = [outer, hole]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 1.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    assert len(mesh["faces"]) > 0


def test_zero_distance_raises():
    """6. zero distance raises ValueError"""
    loops = [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])]
    with pytest.raises(ValueError):
        extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 0.0)


def test_boolean_cut_produces_smaller_shape():
    """7. boolean_cut produces smaller shape - cut unit cube [0-1] from 2x2x2 cube"""
    loops_outer = [pts_to_edge_loop([[0, 0], [2, 0], [2, 2], [0, 2]])]
    loops_inner = [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])]
    target = extrude_profile(loops_outer, FRONT_PLANE, [0, 0, 1], 2.0)
    tool = extrude_profile(loops_inner, FRONT_PLANE, [0, 0, 1], 1.0)
    result = boolean_cut(target, tool)
    mesh = solid_to_mesh(result)
    assert_mesh_valid(mesh)


def test_face_triangle_coverage_complete_on_box():
    """Every triangle must map to a valid B-rep face and every face must have triangles."""
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    mesh = solid_to_mesh(box)

    assert len(mesh["triangle_to_face"]) == len(mesh["faces"])
    face_indices = set(mesh["triangle_to_face"])
    for face_idx in face_indices:
        assert 0 <= face_idx < len(mesh["face_data"]), f"face_idx {face_idx} out of range"
    for face_idx in range(len(mesh["face_data"])):
        assert face_idx in face_indices, f"face {face_idx} has no triangles"


def test_face_triangle_coverage_on_boolean_union_with_inside_corner():
    """Boolean union of perpendicular boxes creates inside corners; all faces covered."""
    left = [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])]
    right = [pts_to_edge_loop([[1, 0], [2, 0], [2, 1], [1, 1]])]
    solid1 = extrude_profile(left, FRONT_PLANE, [0, 0, 1], 1.0)
    solid2 = extrude_profile(right, FRONT_PLANE, [0, 0, 1], 1.0)
    result = boolean_union(solid1, solid2)
    mesh = solid_to_mesh(result)
    assert_mesh_valid(mesh)

    assert len(mesh["triangle_to_face"]) == len(mesh["faces"])
    face_indices = set(mesh["triangle_to_face"])
    for face_idx in face_indices:
        assert 0 <= face_idx < len(mesh["face_data"])
    for face_idx in range(len(mesh["face_data"])):
        assert face_idx in face_indices, f"face {face_idx} has no triangles"


def test_face_queries_complete_on_l_shape_cut():
    """Boolean cut creating concave geometry must have complete face_queries."""
    loops_outer = [pts_to_edge_loop([[0, 0], [2, 0], [2, 2], [0, 2]])]
    loops_inner = [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])]
    target = extrude_profile(loops_outer, FRONT_PLANE, [0, 0, 1], 2.0)
    tool = extrude_profile(loops_inner, FRONT_PLANE, [0, 0, 1], 1.0)
    result = boolean_cut(target, tool)
    mesh = solid_to_mesh(result, created_by="cut1")
    assert_mesh_valid(mesh)

    assert "face_queries" in mesh
    assert len(mesh["face_queries"]) == len(mesh["face_data"])
    assert len(mesh["triangle_to_face"]) == len(mesh["faces"])
    for face_idx in mesh["triangle_to_face"]:
        assert 0 <= face_idx < len(mesh["face_queries"])
    used_faces = set(mesh["triangle_to_face"])
    for face_idx in range(len(mesh["face_queries"])):
        assert face_idx in used_faces, f"face {face_idx} has no triangles"


def test_boolean_union_produces_larger_shape():
    """8. boolean_union produces larger shape - union two unit cubes side by side"""
    left = [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])]
    right = [pts_to_edge_loop([[1, 0], [2, 0], [2, 1], [1, 1]])]
    solid1 = extrude_profile(left, FRONT_PLANE, [0, 0, 1], 1.0)
    solid2 = extrude_profile(right, FRONT_PLANE, [0, 0, 1], 1.0)
    result = boolean_union(solid1, solid2)
    mesh = solid_to_mesh(result)
    assert_mesh_valid(mesh)
    xs = [v[0] for v in mesh["vertices"]]
    assert max(xs) - min(xs) > 1.5


def test_solid_to_mesh_on_cut_result():
    """9. solid_to_mesh on cut result returns valid mesh with all three keys"""
    target = extrude_profile(
        [pts_to_edge_loop([[0, 0], [2, 0], [2, 2], [0, 2]])],
        FRONT_PLANE,
        [0, 0, 1],
        2.0,
    )
    tool = extrude_profile(
        [pts_to_edge_loop([[0, 0], [1, 0], [1, 1], [0, 1]])],
        FRONT_PLANE,
        [0, 0, 1],
        1.0,
    )
    cut_result = boolean_cut(target, tool)
    mesh = solid_to_mesh(cut_result)
    assert "vertices" in mesh
    assert "faces" in mesh
    assert "normals" in mesh
    assert_mesh_valid(mesh)


def test_solid_to_mesh_includes_brep_face_metadata():
    """solid_to_mesh returns stable face metadata aligned with B-rep face order."""
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    mesh = solid_to_mesh(box)

    assert "face_data" in mesh
    assert "triangle_to_face" in mesh
    assert len(mesh["face_data"]) == 6
    assert len(mesh["triangle_to_face"]) == len(mesh["faces"])
    assert all(0 <= face_idx < len(mesh["face_data"]) for face_idx in mesh["triangle_to_face"])


def test_solid_to_mesh_generates_face_queries_from_created_by():
    """created_by should produce stable ancestry queries for each B-rep face."""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    mesh = solid_to_mesh(box, created_by="test_feature")

    assert "face_queries" in mesh
    assert len(mesh["face_queries"]) == len(mesh["face_data"]) == 6
    assert mesh["face_queries"][0] == make_ancestry_query(["@test_featureface0", "@test_feature"], "flatface")


def test_cylinder_side_face_uses_analytical_surface_normal():
    """Cylinder side faces should report a horizontal analytical normal."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder  # noqa: PLC0415

    mesh = solid_to_mesh(BRepPrimAPI_MakeCylinder(1.0, 2.0).Shape())
    side_faces = [
        face for face in mesh["face_data"] if abs(face["normal"][2]) < 0.25
    ]

    assert len(side_faces) == 1
    side_face = side_faces[0]
    assert math.isclose(side_face["centroid"][2], 1.0, abs_tol=0.05)
    assert math.sqrt(
        side_face["normal"][0] ** 2 + side_face["normal"][1] ** 2
    ) > 0.95
    assert math.sqrt(
        sum(component * component for component in side_face["normal"])
    ) == pytest.approx(1.0, abs=1e-6)


def test_revolve_face_empty_angle_fails():
    """revolve_face with angle=0 raises ValueError"""
    face = make_polygon_face([[1, 0], [2, 0], [2, 1], [1, 1]])
    with pytest.raises(ValueError):
        revolve_face(face, [0, 0, 0], [0, 1, 0], 0.0)


def test_revolve_face_90_deg():
    """90 degree revolve of rectangle creates valid solid"""
    face = make_polygon_face([[1, 0], [2, 0], [2, 1], [1, 1]])
    solid = revolve_face(face, [0, 0, 0], [0, 1, 0], 90.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)


def test_revolve_face_360_deg():
    """full 360 degree revolve creates valid solid"""
    face = make_polygon_face([[1, 0], [2, 0], [2, 1], [1, 1]])
    solid = revolve_face(face, [0, 0, 0], [0, 1, 0], 360.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)


def test_revolve_face_cylinder():
    """rectangle revolved 360 degrees around y-axis gives tube-like volume"""
    face = make_polygon_face([[1, 0], [2, 0], [2, 1], [1, 1]])
    solid = revolve_face(face, [0, 0, 0], [0, 1, 0], 360.0)
    # Volume of tube: pi * (r_outer^2 - r_inner^2) * height = pi * (4 - 1) * 1 = 3*pi
    expected_volume = 3.0 * math.pi
    assert solid.Volume() == pytest.approx(expected_volume, abs=0.5)


def test_revolve_face_cone():
    """triangle revolved 360 degrees around y-axis gives frustum-like volume"""
    # Triangle: (1,0) -> (2,0) -> (1,1)
    face = make_polygon_face([[1, 0], [2, 0], [1, 1]])
    solid = revolve_face(face, [0, 0, 0], [0, 1, 0], 360.0)
    # Volume = pi * integral from y=0 to 1 of ((2-y)^2 - 1^2) dy = 4pi/3
    expected_volume = 4.0 * math.pi / 3.0
    assert solid.Volume() == pytest.approx(expected_volume, abs=0.5)


def test_revolve_face_partial_angle():
    """partial revolve produces proportionally smaller volume"""
    face = make_polygon_face([[1, 0], [2, 0], [2, 1], [1, 1]])
    solid_360 = revolve_face(face, [0, 0, 0], [0, 1, 0], 360.0)
    solid_90 = revolve_face(face, [0, 0, 0], [0, 1, 0], 90.0)
    assert solid_90.Volume() == pytest.approx(solid_360.Volume() / 4.0, abs=0.5)


def test_step_file_to_shape_round_trip():
    """11. step_file_to_shape round-trip - write minimal STEP file, read it back"""
    face = make_polygon_face([[0, 0], [1, 0], [1, 1], [0, 1]])
    solid = extrude_face(face, [0, 0, 1], 1.0)
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/test.step"
        writer = STEPControl_Writer()
        writer.Transfer(_unwrap(solid), STEPControl_StepModelType.STEPControl_AsIs)
        writer.Write(filepath)
        result = step_file_to_shape(filepath)
        mesh = solid_to_mesh(result)
        assert_mesh_valid(mesh)


def test_step_file_to_shape_missing_file():
    """12. step_file_to_shape missing file - non-existent path raises ValueError"""
    with pytest.raises(ValueError):
        step_file_to_shape("/nonexistent/path.step")


def test_step_file_to_shape_scale():
    """13. step_file_to_shape scale - scale=2.0 produces roughly 2x bounding box"""
    face = make_polygon_face([[0, 0], [1, 0], [1, 1], [0, 1]])
    solid_normal = extrude_face(face, [0, 0, 1], 1.0)
    mesh_normal = solid_to_mesh(solid_normal)
    xs_normal = [v[0] for v in mesh_normal["vertices"]]
    size_normal = max(xs_normal) - min(xs_normal)
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/test.step"
        writer = STEPControl_Writer()
        writer.Transfer(_unwrap(solid_normal), STEPControl_StepModelType.STEPControl_AsIs)
        writer.Write(filepath)
        solid_scaled = step_file_to_shape(filepath, scale=2.0)
        mesh_scaled = solid_to_mesh(solid_scaled)
        xs_scaled = [v[0] for v in mesh_scaled["vertices"]]
        size_scaled = max(xs_scaled) - min(xs_scaled)
        assert abs(size_scaled / size_normal - 2.0) < 0.1


def test_triangular_extrude_has_five_faces():
    """Triangle extrusion must have 2 end caps (z=0, z=1) and 3 side faces."""
    # Right triangle with vertices at (0,0), (2,0), (0,1)
    loops = [pts_to_edge_loop([[0, 0], [2, 0], [0, 1]])]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 1.0)
    mesh = solid_to_mesh(solid)

    # Must have vertices at both z=0 and z=1
    zs = [v[2] for v in mesh["vertices"]]
    assert min(zs) < 0.01, f"expected vertices near z=0, got min={min(zs)}"
    assert max(zs) > 0.99, f"expected vertices near z=1, got max={max(zs)}"

    # Analyze triangles by their centroid Z coordinate
    bottom_tris = []  # z ≈ 0
    top_tris = []  # z ≈ 1
    side_tris = []  # 0 < z < 1

    for tri in mesh["faces"]:
        v0 = mesh["vertices"][tri[0]]
        v1 = mesh["vertices"][tri[1]]
        v2 = mesh["vertices"][tri[2]]
        cz = (v0[2] + v1[2] + v2[2]) / 3
        if cz < 0.01:
            bottom_tris.append(tri)
        elif cz > 0.99:
            top_tris.append(tri)
        else:
            side_tris.append(tri)

    # Triangle has 2 triangular end caps (each triangular face needs only 1 triangle)
    assert len(bottom_tris) == 1, f"expected 1 bottom triangle, got {len(bottom_tris)}"
    assert len(top_tris) == 1, f"expected 1 top triangle, got {len(top_tris)}"

    # 3 rectangular side faces (each rect is 2 triangles) = 6 side triangles
    assert len(side_tris) == 6, f"expected 6 side triangles, got {len(side_tris)}"

    # Verify bottom triangle is at z=0
    for tri in bottom_tris:
        for vi in tri:
            v = mesh["vertices"][vi]
            assert v[2] < 0.01, f"bottom vertex at wrong z: {v[2]}"

    # Verify top triangle is at z=1
    for tri in top_tris:
        for vi in tri:
            v = mesh["vertices"][vi]
            assert v[2] > 0.99, f"top vertex at wrong z: {v[2]}"

    # Verify total triangle count: 1 bottom + 1 top + 6 side = 8
    assert len(mesh["faces"]) == 8, (
        f"expected 8 triangles for triangular prism, got {len(mesh['faces'])}"
    )


def test_solid_to_edges_returns_dict_with_edge_queries():
    """solid_to_edges returns dict with edges and edge_queries when created_by provided."""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    result = solid_to_edges(box, created_by="ext1")
    assert "edges" in result
    assert "edge_queries" in result
    assert len(result["edge_queries"]) == len(result["edges"])
    for q in result["edge_queries"]:
        assert q.startswith("?")
        assert q.endswith(":straightedge")
        assert "ext1" in q


def test_solid_to_edges_no_created_by_returns_empty_queries():
    """solid_to_edges without created_by returns edges but no queries."""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    result = solid_to_edges(box)
    assert result["edge_queries"] == []
    assert len(result["edges"]) > 0


def test_solid_to_vertices_box_has_eight_vertices():
    """A unit box should have exactly 8 unique vertices."""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    result = solid_to_vertices(box)
    assert "vertices" in result
    assert "vertex_queries" in result
    assert len(result["vertices"]) == 8


def test_solid_to_vertices_generates_queries():
    """solid_to_vertices with created_by generates one query per vertex."""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    result = solid_to_vertices(box, created_by="ext1")
    assert len(result["vertex_queries"]) == 8
    for q in result["vertex_queries"]:
        assert q.startswith("?")
        assert q.endswith(":vertex")
        assert "ext1" in q


def _count_faces(shape: object) -> int:
    from OCP.TopAbs import TopAbs_FACE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415

    topo = _unwrap(shape)
    exp = TopExp_Explorer(topo, TopAbs_FACE)
    n = 0
    while exp.More():
        n += 1
        exp.Next()
    return n


def test_boolean_union_merges_coplanar_side_faces():
    """Two same-footprint boxes stacked in Z should union into a clean 6-face solid.

    Without ShapeUpgrade_UnifySameDomain the side faces are split at the shared
    z-plane, producing 10 faces instead of 6.
    """
    from OCP.gp import gp_Pnt  # noqa: PLC0415

    box_a = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 2.0, 1.0, 1.0).Shape()
    box_b = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 1), 2.0, 1.0, 1.0).Shape()
    result = boolean_union(box_a, box_b)
    assert _count_faces(result) == 6, (
        f"expected 6 faces after union of stacked boxes, got {_count_faces(result)}"
    )


def test_boolean_cut_result_is_valid():
    """boolean_cut result must pass BRepCheck_Analyzer after _cleanup_shape is applied."""
    from OCP.BRepCheck import BRepCheck_Analyzer  # noqa: PLC0415
    from OCP.gp import gp_Pnt  # noqa: PLC0415

    box_a = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 4.0, 2.0, 2.0).Shape()
    box_b = BRepPrimAPI_MakeBox(gp_Pnt(1, 0, 0), 2.0, 2.0, 1.0).Shape()
    result = boolean_cut(box_a, box_b)
    assert BRepCheck_Analyzer(_unwrap(result)).IsValid(), "cut result failed validity check"


def test_validate_mesh_accepts_valid_box():
    """_validate_mesh should pass for a valid box mesh."""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    mesh = solid_to_mesh(box)
    _validate_mesh(mesh)


def test_validate_mesh_rejects_mismatched_triangle_to_face():
    """_validate_mesh should raise when triangle_to_face length differs from faces."""
    mesh = {
        "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        "faces": [[0, 1, 2]],
        "normals": [[0, 0, 1]],
        "face_data": [{"centroid": [0.3, 0.3, 0], "normal": [0, 0, 1], "area": 0.5, "surface_type": "flatface"}],
        "triangle_to_face": [0, 0],
        "face_queries": ["?0;@testface0:test"],
    }
    with pytest.raises(ValueError, match="triangle_to_face length"):
        _validate_mesh(mesh)


def test_validate_mesh_warns_orphaned_face(caplog):
    """_validate_mesh should warn when a face has no triangles."""
    import logging
    mesh = {
        "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        "faces": [[0, 1, 2]],
        "normals": [[0, 0, 1]],
        "face_data": [
            {"centroid": [0.3, 0.3, 0], "normal": [0, 0, 1], "area": 0.5, "surface_type": "flatface"},
            {"centroid": [0.7, 0.7, 0], "normal": [0, 0, 1], "area": 0.5, "surface_type": "flatface"},
        ],
        "triangle_to_face": [0],
        "face_queries": ["?0;@testface0:test", "?0;@testface1:test"],
    }
    with caplog.at_level(logging.WARNING, logger="oversolved.geometry"):
        _validate_mesh(mesh)
    assert any("face 1 has no triangles" in record.message for record in caplog.records)


def test_validate_mesh_rejects_out_of_bounds_triangle_to_face():
    """_validate_mesh should raise when triangle_to_face index exceeds face_queries."""
    mesh = {
        "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        "faces": [[0, 1, 2]],
        "normals": [[0, 0, 1]],
        "face_data": [{"centroid": [0.3, 0.3, 0], "normal": [0, 0, 1], "area": 0.5, "surface_type": "flatface"}],
        "triangle_to_face": [2],
        "face_queries": ["?0;@testface0:test"],
    }
    with pytest.raises(ValueError, match=r"triangle_to_face\[0\]=2 out of range"):
        _validate_mesh(mesh)
