"""geometry_features.py - Edge modifiers (fillet/chamfer) and transform operations."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
    from OCP.gp import gp_Trsf

from oversolved.kernel.cadquery_ops import _ensure_occ
from oversolved.kernel.ocp_ops import (
    ocp_chamfer_factory,
    ocp_collect_edge_hashes,
    ocp_explore_edges,
    ocp_fillet_factory,
    ocp_make_rotation_trsf,
    ocp_make_translation_trsf,
    ocp_transform_copy,
)

logger = logging.getLogger(__name__)


@dataclass
class EdgeModifierResult:
    shape: TopoDS_Shape
    success: bool
    reason: str | None  # null_shape / maker_failed / no_edges_applied / build_failed / ok
    successful_count: int
    failed_count: int
    skipped_count: int
    failed_indices: list[int]
    skipped_indices: list[int]


def _check_null_shape(topo_shape: TopoDS_Shape) -> bool:
    """Return True if shape is null; logs warning on exception."""
    try:
        return bool(topo_shape.IsNull())
    except Exception as exc:
        logger.warning("_apply_edge_modifier: null check failed: %s", exc)
        return True


def _try_collect_edge_hashes(topo_shape: TopoDS_Shape) -> set[int] | None:
    """Collect edge hashes for membership testing; returns None on failure."""
    try:
        return ocp_collect_edge_hashes(topo_shape)
    except Exception as exc:
        logger.warning("_apply_edge_modifier: edge hash collection failed: %s", exc)
        return None


def _try_create_maker(maker_factory: Callable[[TopoDS_Shape], Any], topo_shape: TopoDS_Shape) -> Any | None:
    """Create maker object; returns None on failure."""
    try:
        return maker_factory(topo_shape)
    except Exception as exc:
        logger.warning("_apply_edge_modifier: maker factory failed: %s", exc)
        return None


def _try_add_edge(maker: Any, edge: TopoDS_Shape, idx: int, add_edge_fn: Callable[[Any, TopoDS_Shape], None]) -> bool:
    """Add edge to maker; returns True on success."""
    try:
        add_edge_fn(maker, edge)
        return True
    except Exception as exc:
        logger.debug("_apply_edge_modifier: adding edge %d failed: %s", idx, exc)
        return False


def _try_build_shape(maker: Any) -> tuple[TopoDS_Shape | None, str | None]:
    """Call maker.Build() and return (Shape, None) or (None, reason)."""
    try:
        maker.Build()
        return maker.Shape(), None
    except Exception as exc:
        logger.warning("_apply_edge_modifier: build failed: %s", exc)
        return None, "build_failed"


def _apply_edge_modifier(
    shape: TopoDS_Shape,
    edges: list[TopoDS_Shape] | None,
    maker_factory: Callable[[TopoDS_Shape], Any],
    add_edge_fn: Callable[[Any, TopoDS_Shape], None],
) -> EdgeModifierResult:
    """Shared OCC edge-modifier kernel used by apply_fillet and apply_chamfer."""
    topo_shape = _ensure_occ(shape)

    def _fail(reason: str) -> EdgeModifierResult:
        return EdgeModifierResult(
            shape=shape, success=False, reason=reason,
            successful_count=0, failed_count=0, skipped_count=0,
            failed_indices=[], skipped_indices=[],
        )

    if _check_null_shape(topo_shape):
        return _fail("null_shape")

    shape_edge_set: set[int] | None = None
    if edges is not None and len(edges) > 0:
        shape_edge_set = _try_collect_edge_hashes(topo_shape)

    maker = _try_create_maker(maker_factory, topo_shape)
    if maker is None:
        return _fail("maker_failed")

    successful_count = 0
    failed_count = 0
    skipped_count = 0
    failed_indices: list[int] = []
    skipped_indices: list[int] = []

    if edges is not None:
        for idx, edge in enumerate(edges):
            if shape_edge_set is not None and hash(_ensure_occ(edge)) not in shape_edge_set:
                skipped_count += 1
                skipped_indices.append(idx)
                continue
            if _try_add_edge(maker, edge, idx, add_edge_fn):
                successful_count += 1
            else:
                failed_count += 1
                failed_indices.append(idx)
    else:
        try:
            for idx, edge in enumerate(ocp_explore_edges(topo_shape)):
                if _try_add_edge(maker, edge, idx, add_edge_fn):
                    successful_count += 1
                else:
                    failed_count += 1
                    failed_indices.append(idx)
        except Exception as exc:
            logger.warning("_apply_edge_modifier: explore edges failed: %s", exc)
            return _fail("explore_failed")

    if failed_count > 0:
        logger.warning(
            "_apply_edge_modifier: %d of %d edges failed to apply",
            failed_count, failed_count + successful_count,
        )

    if successful_count == 0:
        return _fail("no_edges_applied")

    built, build_reason = _try_build_shape(maker)
    if built is None:
        return _fail(build_reason or "build_failed")

    return EdgeModifierResult(
        shape=built,
        success=True,
        reason=None,
        successful_count=successful_count,
        failed_count=failed_count,
        skipped_count=skipped_count,
        failed_indices=failed_indices,
        skipped_indices=skipped_indices,
    )


def apply_fillet(shape: TopoDS_Shape, radius: float, edges: list[TopoDS_Shape] | None = None) -> TopoDS_Shape:
    """Apply a fillet (round) to edges of a shape.

    Returns the filleted shape, or the original shape if filleting fails.
    """
    return _apply_edge_modifier(
        shape, edges,
        maker_factory=ocp_fillet_factory,
        add_edge_fn=lambda maker, e: maker.Add(radius, e),
    ).shape


def apply_chamfer(shape: TopoDS_Shape, distance: float, kind: str = "distance",
                  angle: float = 45.0, edges: list[TopoDS_Shape] | None = None) -> TopoDS_Shape:
    """Apply a chamfer (bevel) to edges of a shape.

    kind: "distance" or "angle_distance".
    Returns the chamfered shape, or the original shape if chamfering fails.
    """
    def _add(maker: Any, edge: TopoDS_Shape) -> None:
        if kind == "angle_distance":
            maker.AddDA(distance, angle, edge)
        else:
            maker.Add(distance, edge)

    return _apply_edge_modifier(shape, edges, maker_factory=ocp_chamfer_factory, add_edge_fn=_add).shape


def transform_copy(shape: TopoDS_Shape, trsf: gp_Trsf) -> TopoDS_Shape:
    """Return a new shape that is `shape` with OCC gp_Trsf applied."""
    return ocp_transform_copy(_ensure_occ(shape), trsf)


def make_translation_trsf(dx: float, dy: float, dz: float) -> gp_Trsf:
    return ocp_make_translation_trsf(dx, dy, dz)


def make_rotation_trsf(
    origin: list[float], direction: list[float], angle_rad: float
) -> gp_Trsf:
    return ocp_make_rotation_trsf(origin, direction, angle_rad)
