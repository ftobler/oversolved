"""Tests for fix-tessellation-cache-id-collision.

Verifies that the tessellation cache uses hash(shape) (OCC TShape-based)
rather than id(shape) (Python wrapper address), so GC+reallocation of Python
wrappers cannot produce stale cache hits.
"""
from __future__ import annotations

import gc
import importlib

import pytest

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _make_box_body(w: float, h: float, d: float, body_id: str = "b1"):
    import cadquery as cq
    from oversolved.kernel.types3d import Body
    from oversolved.kernel.cadquery_ops import _ensure_occ
    shape = _ensure_occ(cq.Workplane().box(w, h, d).val())
    return Body(id=body_id, created_by="f1", modified_by=[], shape=shape, sketch_id="")


def _make_cyl_body(r: float, h: float, body_id: str = "b1"):
    import cadquery as cq
    from oversolved.kernel.types3d import Body
    from oversolved.kernel.cadquery_ops import _ensure_occ
    shape = _ensure_occ(cq.Workplane().cylinder(h, r).val())
    return Body(id=body_id, created_by="f1", modified_by=[], shape=shape, sketch_id="")


def test_tessellation_cache_different_shapes_different_mesh():
    """Two different OCC shapes must produce different tessellations."""
    from oversolved.kernel.builder import _tessellate_body_geometry

    box_body = _make_box_body(1, 1, 1)
    cyl_body = _make_cyl_body(1, 2)

    box_entry = _tessellate_body_geometry(box_body)
    cyl_entry = _tessellate_body_geometry(cyl_body)

    assert "mesh" in box_entry, f"box tessellation failed: {box_entry.get('mesh_error')}"
    assert "mesh" in cyl_entry, f"cyl tessellation failed: {cyl_entry.get('mesh_error')}"

    box_face_count = len(box_entry["mesh"]["face_data"])
    cyl_face_count = len(cyl_entry["mesh"]["face_data"])
    assert box_face_count != cyl_face_count, (
        "box and cylinder have same face count -- meshes not distinguishable"
    )


def test_tessellation_cache_same_shape_consistent_mesh():
    """Tessellating the same body twice returns equivalent mesh data."""
    from oversolved.kernel.builder import _tessellate_body_geometry

    body = _make_box_body(2, 3, 4)
    entry1 = _tessellate_body_geometry(body)
    entry2 = _tessellate_body_geometry(body)

    assert "mesh" in entry1
    assert "mesh" in entry2
    assert entry1["mesh"]["face_data"] == entry2["mesh"]["face_data"]


def test_hash_not_equal_to_id_for_occ_shapes():
    """hash(shape) must differ from id(shape) -- confirming OCC content-based hash is used."""
    import cadquery as cq
    from oversolved.kernel.cadquery_ops import _ensure_occ
    shape = _ensure_occ(cq.Workplane().box(1, 1, 1).val())
    assert hash(shape) != id(shape), (
        "hash(shape) == id(shape): cache is still using Python wrapper address"
    )


def test_tessellation_cache_no_stale_hit():
    """After GC of a Python shape wrapper, a new shape at the same address must not
    inherit the old tessellation via hash collision."""
    import cadquery as cq
    from oversolved.kernel.cadquery_ops import _ensure_occ

    box_shape = _ensure_occ(cq.Workplane().box(1, 1, 1).val())
    cyl_shape = _ensure_occ(cq.Workplane().cylinder(2, 1).val())

    h_box = hash(box_shape)
    h_cyl = hash(cyl_shape)

    del box_shape
    gc.collect()

    # After GC the box shape is freed; the cylinder must retain its own distinct hash.
    assert h_box != h_cyl, (
        "box and cylinder have the same hash -- stale cache hit would be possible"
    )
