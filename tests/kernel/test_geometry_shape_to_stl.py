"""Tests for geometry.shape_to_stl_file function."""

import os
import tempfile
from io import BytesIO
from unittest.mock import patch

import pytest

pytest.importorskip("cadquery.occ_impl.shapes")
from oversolved.kernel.geometry import shape_to_stl_file, shape_to_stl_file_buffer, solid_to_mesh  # noqa: E402
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: E402


def test_shape_to_stl_file_basic():
    """1. shape_to_stl_file basic - write box to STL, read back as mesh"""
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.stl"
        shape_to_stl_file(box, filepath)
        mesh = solid_to_mesh(filepath)
        assert "vertices" in mesh
        assert len(mesh["vertices"]) > 0


def test_shape_to_stl_file_preserves_dimensions():
    """2. shape_to_stl_file preserves dimensions - mesh spans the box extents"""
    box = BRepPrimAPI_MakeBox(2.0, 2.0, 2.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.stl"
        shape_to_stl_file(box, filepath)
        mesh = solid_to_mesh(filepath)
        xs = [v[0] for v in mesh["vertices"]]
        ys = [v[1] for v in mesh["vertices"]]
        zs = [v[2] for v in mesh["vertices"]]
        # Box spans from 0 to 2 in each axis
        assert max(xs) > 1.5
        assert max(ys) > 1.5
        assert max(zs) > 1.5


def test_shape_to_stl_file_ascii_format():
    """3. shape_to_stl_file ASCII format - file contains 'solid' header"""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.stl"
        shape_to_stl_file(box, filepath)
        with open(filepath, "r") as f:
            content = f.read(100)
        assert "solid" in content


def test_shape_to_stl_file_tessellation_params():
    """4. shape_to_stl_file tessellation params - deflection affects mesh density"""
    box = BRepPrimAPI_MakeBox(2.0, 2.0, 2.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath_coarse = f"{tmpdir}/coarse.stl"
        filepath_fine = f"{tmpdir}/fine.stl"
        shape_to_stl_file(box, filepath_coarse, deflection=1.0, angular_deflection=0.5)
        shape_to_stl_file(box, filepath_fine, deflection=0.1, angular_deflection=0.1)
        # After reading back via STL reader, both should produce valid meshes
        mesh_coarse = solid_to_mesh(filepath_coarse)
        mesh_fine = solid_to_mesh(filepath_fine)
        assert len(mesh_fine["vertices"]) >= len(mesh_coarse["vertices"])


def test_shape_to_stl_file_produces_triangles():
    """5. shape_to_stl_file produces triangles - mesh has face data"""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.stl"
        shape_to_stl_file(box, filepath)
        mesh = solid_to_mesh(filepath)
        assert "faces" in mesh
        assert len(mesh["faces"]) > 0


def test_stl_buffer_cleans_up_on_success():
    """6. shape_to_stl_file_buffer success - temp file deleted after successful export"""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    created_path: list[str] = []
    real_ntf = tempfile.NamedTemporaryFile

    def capturing_ntf(*args, **kwargs):
        f = real_ntf(*args, **kwargs)
        created_path.append(f.name)
        return f

    with patch("oversolved.kernel.geometry_io.tempfile.NamedTemporaryFile", capturing_ntf):
        result = shape_to_stl_file_buffer(box)

    assert isinstance(result, BytesIO)
    assert len(created_path) == 1
    assert not os.path.exists(created_path[0])


def test_stl_buffer_cleans_up_on_failure():
    """7. shape_to_stl_file_buffer failure - temp file deleted even when write raises"""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    created_path: list[str] = []
    real_ntf = tempfile.NamedTemporaryFile

    def capturing_ntf(*args, **kwargs):
        f = real_ntf(*args, **kwargs)
        created_path.append(f.name)
        return f

    with patch("oversolved.kernel.geometry_io.tempfile.NamedTemporaryFile", capturing_ntf):
        with patch("oversolved.kernel.geometry_io.ocp_write_stl", side_effect=RuntimeError("write error")):
            with pytest.raises(RuntimeError, match="write error"):
                shape_to_stl_file_buffer(box)

    assert len(created_path) == 1
    assert not os.path.exists(created_path[0])
