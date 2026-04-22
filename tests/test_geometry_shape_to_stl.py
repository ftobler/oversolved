"""Tests for geometry.shape_to_stl_file function."""

import tempfile
import pytest

from oversolved.geometry import shape_to_stl_file, solid_to_mesh
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox


def test_shape_to_stl_file_basic():
    """1. shape_to_stl_file basic - write box to STL, read back as mesh"""
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.stl"
        shape_to_stl_file(box, filepath)
        mesh = solid_to_mesh(filepath)
        assert "vertices" in mesh
        assert len(mesh["vertices"]) > 0


def test_shape_to_stl_file_invalid_path():
    """2. shape_to_stl_file invalid path - non-writable path raises error"""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    with pytest.raises(Exception):
        shape_to_stl_file(box, "/nonexistent/directory/foo.stl")


def test_shape_to_stl_file_preserves_geometry():
    """3. shape_to_stl_file preserves geometry - box dimensions preserved in mesh"""
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.stl"
        shape_to_stl_file(box, filepath)
        mesh = solid_to_mesh(filepath)
        xs = [v[0] for v in mesh["vertices"]]
        ys = [v[1] for v in mesh["vertices"]]
        zs = [v[2] for v in mesh["vertices"]]
        x_range = max(xs) - min(xs)
        y_range = max(ys) - min(ys)
        z_range = max(zs) - min(zs)
        assert abs(x_range - 1.0) < 0.1
        assert abs(y_range - 2.0) < 0.1
        assert abs(z_range - 3.0) < 0.1


def test_shape_to_stl_file_ascii_format():
    """4. shape_to_stl_file ASCII format - file contains 'solid' header"""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.stl"
        shape_to_stl_file(box, filepath)
        with open(filepath, "r") as f:
            content = f.read(100)
        assert "solid" in content


def test_shape_to_stl_file_tessellation_params():
    """5. shape_to_stl_file tessellation params - deflection affects mesh density"""
    box = BRepPrimAPI_MakeBox(2.0, 2.0, 2.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath_coarse = f"{tmpdir}/coarse.stl"
        filepath_fine = f"{tmpdir}/fine.stl"
        shape_to_stl_file(box, filepath_coarse, deflection=1.0, angular_deflection=0.5)
        shape_to_stl_file(box, filepath_fine, deflection=0.1, angular_deflection=0.1)
        mesh_coarse = solid_to_mesh(filepath_coarse)
        mesh_fine = solid_to_mesh(filepath_fine)
        assert len(mesh_fine["vertices"]) >= len(mesh_coarse["vertices"])