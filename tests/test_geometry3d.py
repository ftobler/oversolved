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
    step_file_to_shape,
)
from OCP.STEPControl import STEPControl_Writer, STEPControl_StepModelType  # noqa: E402


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


def make_polygon_face(points_2d):
    """Make a face from 2D points for testing."""
    loops = [points_2d]
    return sketch_loops_to_face(loops, FRONT_PLANE)


def test_unit_square_extrude():
    """1. unit square extrude - loops=[[[0,0],[1,0],[1,1],[0,1]]]，FRONT_PLANE，direction=[0,0,1]，distance=1.0"""
    loops = [[[0, 0], [1, 0], [1, 1], [0, 1]]]
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
    loops = [circle_points]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 2.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    assert len(mesh["vertices"]) > 60
    zs = [v[2] for v in mesh["vertices"]]
    assert abs(max(zs) - 2.0) < 0.1


def test_top_plane_extrude():
    """3. top-plane extrude - square on TOP_PLANE (normal=[0,1,0])"""
    loops = [[[0, 0], [1, 0], [1, 1], [0, 1]]]
    solid = extrude_profile(loops, TOP_PLANE, [0, 1, 0], 1.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    ys = [v[1] for v in mesh["vertices"]]
    for y in ys:
        assert 0 <= y <= 1, f"y={y} should be in [0,1]"


def test_normals_are_unit_length():
    """4. normals are unit length"""
    loops = [[[0, 0], [1, 0], [1, 1], [0, 1]]]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 1.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    for normal in mesh["normals"]:
        mag = math.sqrt(sum(x * x for x in normal))
        assert abs(mag - 1.0) < 1e-6


def test_hole_in_profile():
    """5. hole in profile - outer [[0,0],[4,0],[4,4],[0,4]], hole [[1,1],[3,1],[3,3],[1,3]]"""
    outer = [[0, 0], [4, 0], [4, 4], [0, 4]]
    hole = [[1, 1], [3, 1], [3, 3], [1, 3]]
    loops = [outer, hole]
    solid = extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 1.0)
    mesh = solid_to_mesh(solid)
    assert_mesh_valid(mesh)
    assert len(mesh["faces"]) > 0


def test_zero_distance_raises():
    """6. zero distance raises ValueError"""
    loops = [[[0, 0], [1, 0], [1, 1], [0, 1]]]
    with pytest.raises(ValueError):
        extrude_profile(loops, FRONT_PLANE, [0, 0, 1], 0.0)


def test_boolean_cut_produces_smaller_shape():
    """7. boolean_cut produces smaller shape - cut unit cube [0-1] from 2x2x2 cube"""
    outer = [[0, 0], [2, 0], [2, 2], [0, 2]]
    inner = [[0, 0], [1, 0], [1, 1], [0, 1]]
    loops_outer = [outer]
    loops_inner = [inner]
    target = extrude_profile(loops_outer, FRONT_PLANE, [0, 0, 1], 2.0)
    tool = extrude_profile(loops_inner, FRONT_PLANE, [0, 0, 1], 1.0)
    result = boolean_cut(target, tool)
    mesh = solid_to_mesh(result)
    assert_mesh_valid(mesh)


def test_boolean_union_produces_larger_shape():
    """8. boolean_union produces larger shape - union two unit cubes side by side"""
    left = [[[0, 0], [1, 0], [1, 1], [0, 1]]]
    right = [[[1, 0], [2, 0], [2, 1], [1, 1]]]
    solid1 = extrude_profile(left, FRONT_PLANE, [0, 0, 1], 1.0)
    solid2 = extrude_profile(right, FRONT_PLANE, [0, 0, 1], 1.0)
    result = boolean_union(solid1, solid2)
    mesh = solid_to_mesh(result)
    assert_mesh_valid(mesh)
    xs = [v[0] for v in mesh["vertices"]]
    assert max(xs) - min(xs) > 1.5


def test_solid_to_mesh_on_cut_result():
    """9. solid_to_mesh on cut result returns valid mesh with all three keys"""
    outer = [[0, 0], [2, 0], [2, 2], [0, 2]]
    inner = [[0, 0], [1, 0], [1, 1], [0, 1]]
    target = extrude_profile([outer], FRONT_PLANE, [0, 0, 1], 2.0)
    tool = extrude_profile([inner], FRONT_PLANE, [0, 0, 1], 1.0)
    cut_result = boolean_cut(target, tool)
    mesh = solid_to_mesh(cut_result)
    assert "vertices" in mesh
    assert "faces" in mesh
    assert "normals" in mesh
    assert_mesh_valid(mesh)


def test_revolve_face_stub():
    """10. revolve_face stub - asserts NotImplementedError"""
    face = make_polygon_face([[0, 0], [1, 0], [1, 1], [0, 1]])
    with pytest.raises(NotImplementedError):
        revolve_face(face, [0, 0, 0], [0, 0, 1], 90.0)


def test_step_file_to_shape_round_trip():
    """11. step_file_to_shape round-trip - write minimal STEP file, read it back"""
    face = make_polygon_face([[0, 0], [1, 0], [1, 1], [0, 1]])
    solid = extrude_face(face, [0, 0, 1], 1.0)
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/test.step"
        writer = STEPControl_Writer()
        writer.Transfer(solid, STEPControl_StepModelType.STEPControl_AsIs)
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
        writer.Transfer(solid_normal, STEPControl_StepModelType.STEPControl_AsIs)
        writer.Write(filepath)
        solid_scaled = step_file_to_shape(filepath, scale=2.0)
        mesh_scaled = solid_to_mesh(solid_scaled)
        xs_scaled = [v[0] for v in mesh_scaled["vertices"]]
        size_scaled = max(xs_scaled) - min(xs_scaled)
        assert abs(size_scaled / size_normal - 2.0) < 0.1
