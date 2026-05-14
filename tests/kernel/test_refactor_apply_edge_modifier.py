"""Tests for the refactored _apply_edge_modifier and EdgeModifierResult."""

import pytest

pytest.importorskip("OCP.BRep", reason="OCP not installed")

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: E402
from OCP.TopoDS import TopoDS_Shape  # noqa: E402

from oversolved.kernel.geometry import (  # noqa: E402
    EdgeModifierResult,
    _apply_edge_modifier,
    _check_null_shape,
    _try_add_edge,
    _try_build_shape,
    _try_collect_edge_hashes,
    _try_create_maker,
    apply_fillet,
)
from oversolved.kernel.ocp_ops import ocp_explore_edges, ocp_fillet_factory  # noqa: E402


def _make_box() -> TopoDS_Shape:
    return BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Shape()


def test_apply_edge_modifier_result_structure() -> None:
    """Result of _apply_edge_modifier is an EdgeModifierResult with all expected fields."""
    box = _make_box()
    result = _apply_edge_modifier(
        box, None,
        maker_factory=ocp_fillet_factory,
        add_edge_fn=lambda maker, e: maker.Add(0.5, e),
    )
    assert isinstance(result, EdgeModifierResult)
    assert hasattr(result, "shape")
    assert hasattr(result, "success")
    assert hasattr(result, "reason")
    assert hasattr(result, "successful_count")
    assert hasattr(result, "failed_count")
    assert hasattr(result, "skipped_count")
    assert hasattr(result, "failed_indices")
    assert hasattr(result, "skipped_indices")


def test_apply_edge_modifier_null_shape() -> None:
    """Passing a null TopoDS_Shape returns failure with reason 'null_shape'."""
    null_shape: TopoDS_Shape = TopoDS_Shape()
    result = _apply_edge_modifier(
        null_shape, None,
        maker_factory=ocp_fillet_factory,
        add_edge_fn=lambda maker, e: maker.Add(0.5, e),
    )
    assert isinstance(result, EdgeModifierResult)
    assert result.success is False
    assert result.reason == "null_shape"
    assert result.successful_count == 0


def test_apply_edge_modifier_no_edges_applied() -> None:
    """When add_edge_fn always raises, result has reason 'no_edges_applied'."""
    box = _make_box()

    def _always_fail(maker: object, edge: TopoDS_Shape) -> None:
        raise RuntimeError("intentional failure")

    result = _apply_edge_modifier(
        box, None,
        maker_factory=ocp_fillet_factory,
        add_edge_fn=_always_fail,
    )
    assert isinstance(result, EdgeModifierResult)
    assert result.success is False
    assert result.reason == "no_edges_applied"
    assert result.successful_count == 0


def test_apply_fillet_still_returns_shape() -> None:
    """apply_fillet returns a TopoDS_Shape for backward compatibility."""
    box = _make_box()
    result = apply_fillet(box, 0.5)
    assert isinstance(result, TopoDS_Shape)
    assert not result.IsNull()


def test_apply_edge_modifier_all_edges_path() -> None:
    """With no explicit edges list, all shape edges are processed and success is True."""
    box = _make_box()
    result = _apply_edge_modifier(
        box, None,
        maker_factory=ocp_fillet_factory,
        add_edge_fn=lambda maker, e: maker.Add(0.5, e),
    )
    assert isinstance(result, EdgeModifierResult)
    assert result.success is True
    assert result.successful_count > 0
    assert result.reason is None
