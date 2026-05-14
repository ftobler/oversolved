"""Tests for refactored solid_to_mesh helpers."""

from unittest.mock import patch

import pytest

pytest.importorskip("OCP.BRep", reason="OCP not installed")

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: E402

from oversolved.kernel.cadquery_ops import _ensure_cq  # noqa: E402
from oversolved.kernel.geometry import (  # noqa: E402
    _init_mesh_accumulators,
    _load_shape_from_path,
    _tessellate_and_assemble_faces,
    solid_to_mesh,
)


def _make_box_shape():
    """Return a cadquery Shape wrapping a 1x1x1 OCC box."""
    topo = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    return _ensure_cq(topo)


def test_solid_to_mesh_fallback_is_detectable():
    """When tessellation fails the returned mesh must have is_fallback=True."""
    box = _make_box_shape()
    with patch(
        "oversolved.kernel.geometry._sort_shape_faces",
        side_effect=RuntimeError("simulated tessellation failure"),
    ):
        result = solid_to_mesh(box)
    assert result["is_fallback"] is True


def test_solid_to_mesh_real_mesh_not_fallback():
    """A valid box solid must produce is_fallback=False."""
    topo = BRepPrimAPI_MakeBox(2.0, 3.0, 4.0).Shape()
    result = solid_to_mesh(topo)
    assert result["is_fallback"] is False
    assert len(result["vertices"]) > 0


def test_load_shape_from_path_missing_file():
    """_load_shape_from_path must raise ValueError for a non-existent file."""
    with pytest.raises(ValueError, match="File not found"):
        _load_shape_from_path("/tmp/this_file_does_not_exist_oversolved.step")


def test_init_mesh_accumulators():
    """_init_mesh_accumulators must return six empty lists."""
    result = _init_mesh_accumulators()
    assert len(result) == 6
    for item in result:
        assert isinstance(item, list)
        assert len(item) == 0


def test_tessellate_and_assemble_faces_box():
    """_tessellate_and_assemble_faces on a real box produces non-empty output."""
    box = _make_box_shape()
    fd, t2f, fq, verts, faces, normals = _tessellate_and_assemble_faces(box, None, None)
    assert len(verts) > 0
    assert len(faces) > 0
    assert len(normals) == len(faces)


def test_tessellate_and_assemble_faces_exception():
    """When _sort_shape_faces raises, all six accumulators must be returned empty."""
    box = _make_box_shape()
    with patch(
        "oversolved.kernel.geometry._sort_shape_faces",
        side_effect=RuntimeError("simulated failure"),
    ):
        fd, t2f, fq, verts, faces, normals = _tessellate_and_assemble_faces(box, None, None)
    assert verts == []
    assert faces == []
    assert normals == []
    assert fd == []
    assert t2f == []
    assert fq == []
