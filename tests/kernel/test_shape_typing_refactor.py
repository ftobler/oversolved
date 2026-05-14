"""Tests for the shape-typing refactor (feature #108).

Verifies that _ensure_occ correctly normalises both cq.Shape and raw
TopoDS_Shape inputs, that _copy_shape always returns TopoDS_Shape, and that
boundary functions (boolean ops, fillet) still return usable cq.Shape objects.
"""

import pytest

pytest.importorskip("cadquery.occ_impl.shapes")

from cadquery.occ_impl import shapes as cq_shapes  # noqa: E402
from oversolved.kernel.cadquery_ops import (  # noqa: E402
    _ensure_occ,
    boolean_cut,
    boolean_union,
    extrude_face,
    make_face_from_wires,
    make_line_edge,
    make_wire,
    apply_transform_shape,
)


def _make_unit_box() -> cq_shapes.Solid:
    edges = [
        make_line_edge([0, 0, 0], [1, 0, 0]),
        make_line_edge([1, 0, 0], [1, 1, 0]),
        make_line_edge([1, 1, 0], [0, 1, 0]),
        make_line_edge([0, 1, 0], [0, 0, 0]),
    ]
    wire = make_wire(edges)
    face = make_face_from_wires(wire)
    return extrude_face(face, [0, 0, 1], 1.0)


def test_ensure_occ_passes_through_raw_topoDS():
    """_ensure_occ must be idempotent on a raw TopoDS_Shape."""
    box = _make_unit_box()
    raw = box.wrapped  # TopoDS_Shape
    result = _ensure_occ(raw)
    assert result is raw


def test_ensure_occ_unwraps_cq_shape():
    """_ensure_occ must return the .wrapped attribute of a cq.Shape."""
    box = _make_unit_box()
    result = _ensure_occ(box)
    assert result is box.wrapped


def test_ensure_occ_round_trip_preserves_topology():
    """Unwrapping and re-wrapping must preserve face/edge counts."""
    box = _make_unit_box()
    raw = _ensure_occ(box)
    rewrapped = cq_shapes.Shape.cast(raw)
    assert len(list(rewrapped.faces())) == len(list(box.faces()))
    assert len(list(rewrapped.edges())) == len(list(box.edges()))


def test_copy_shape_returns_topoDS():
    """_copy_shape from builder must always return a raw TopoDS_Shape, not a cq.Shape."""
    from oversolved.kernel.builder import _copy_shape
    box = _make_unit_box()
    copied = _copy_shape(box)
    assert hasattr(copied, "IsNull")
    assert not hasattr(copied, "edges")


def test_apply_transform_shape_returns_topoDS():
    """apply_transform_shape must always return a raw TopoDS_Shape."""
    box = _make_unit_box()
    result = apply_transform_shape(box, translation=[1.0, 0.0, 0.0])
    assert hasattr(result, "IsNull")
    assert not hasattr(result, "edges")


def test_apply_transform_shape_accepts_raw_topoDS():
    """apply_transform_shape must handle a raw TopoDS_Shape input without error."""
    box = _make_unit_box()
    raw = _ensure_occ(box)
    result = apply_transform_shape(raw, translation=[2.0, 0.0, 0.0])
    assert not result.IsNull()


def test_boolean_cut_via_cq_and_raw_inputs():
    """boolean_cut must accept mixed cq.Shape / TopoDS_Shape inputs."""
    box = _make_unit_box()
    cutter_edges = [
        make_line_edge([0.25, 0.25, -0.5], [0.75, 0.25, -0.5]),
        make_line_edge([0.75, 0.25, -0.5], [0.75, 0.75, -0.5]),
        make_line_edge([0.75, 0.75, -0.5], [0.25, 0.75, -0.5]),
        make_line_edge([0.25, 0.75, -0.5], [0.25, 0.25, -0.5]),
    ]
    cutter_face = make_face_from_wires(make_wire(cutter_edges))
    cutter = extrude_face(cutter_face, [0, 0, 1], 2.0)
    result = boolean_cut(_ensure_occ(box), cutter)
    assert result.isValid()


def test_boolean_union_accepts_topoDS_input():
    """boolean_union must handle a raw TopoDS_Shape as the first argument."""
    box = _make_unit_box()
    raw = _ensure_occ(box)
    edges2 = [
        make_line_edge([0.9, 0, 0], [1.9, 0, 0]),
        make_line_edge([1.9, 0, 0], [1.9, 1, 0]),
        make_line_edge([1.9, 1, 0], [0.9, 1, 0]),
        make_line_edge([0.9, 1, 0], [0.9, 0, 0]),
    ]
    box2 = extrude_face(make_face_from_wires(make_wire(edges2)), [0, 0, 1], 1.0)
    result = boolean_union(raw, box2)
    assert result.isValid()
