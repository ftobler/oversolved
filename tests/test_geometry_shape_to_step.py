"""Tests for geometry.shape_to_step_file function."""

import tempfile
import pytest

pytest.importorskip("cadquery.occ_impl.shapes")

from oversolved.geometry import shape_to_step_file, step_file_to_shape, solid_to_mesh  # noqa: E402
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: E402
from OCP.STEPControl import STEPControl_Reader  # noqa: E402


def test_shape_to_step_file_basic():
    """1. shape_to_step_file basic - write box to STEP, read back"""
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.step"
        shape_to_step_file(box, filepath)
        result = step_file_to_shape(filepath)
        mesh = solid_to_mesh(result)
        assert "vertices" in mesh
        assert len(mesh["vertices"]) > 0


def test_shape_to_step_file_invalid_path():
    """2. shape_to_step_file invalid path - non-writable path raises ValueError"""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    with pytest.raises(ValueError):
        shape_to_step_file(box, "/nonexistent/directory/foo.step")


def test_shape_to_step_file_preserves_geometry():
    """3. shape_to_step_file preserves geometry - box dimensions preserved after round-trip"""
    box = BRepPrimAPI_MakeBox(1.0, 2.0, 3.0).Shape()
    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = f"{tmpdir}/box.step"
        shape_to_step_file(box, filepath)
        reader = STEPControl_Reader()
        reader.ReadFile(filepath)
        reader.TransferRoots()
        shape = reader.OneShape()
        assert not shape.IsNull()
        mesh = solid_to_mesh(shape)
        xs = [v[0] for v in mesh["vertices"]]
        ys = [v[1] for v in mesh["vertices"]]
        zs = [v[2] for v in mesh["vertices"]]
        x_range = max(xs) - min(xs)
        y_range = max(ys) - min(ys)
        z_range = max(zs) - min(zs)
        assert abs(x_range - 1.0) < 0.1
        assert abs(y_range - 2.0) < 0.1
        assert abs(z_range - 3.0) < 0.1
