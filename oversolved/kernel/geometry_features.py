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
    # Per-entity lineage for the output shape: subshape hash → entity tokens.
    # Populated when the caller supplies line_age_source.
    face_lineage: dict[str, list[str]] | None = None
    edge_lineage: dict[str, list[str]] | None = None


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
    lineage_source: dict | None = None,
) -> EdgeModifierResult:
    """Shared OCC edge-modifier kernel used by apply_fillet and apply_chamfer.

    If lineage_source is provided, tracks per-entity lineage through the operation.
    lineage_source keys:
      - "face_lineage": body's pre-op face_lineage dict
      - "edge_lineage": body's pre-op edge_lineage dict
      - "filleted_edges": list of TopoDS_Edge being filleted
    """
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

    applied_edges: list[Any] = []  # track edges that were successfully added

    if edges is not None:
        for idx, edge in enumerate(edges):
            if shape_edge_set is not None and hash(_ensure_occ(edge)) not in shape_edge_set:
                skipped_count += 1
                skipped_indices.append(idx)
                continue
            if _try_add_edge(maker, edge, idx, add_edge_fn):
                successful_count += 1
                applied_edges.append(edge)
            else:
                failed_count += 1
                failed_indices.append(idx)
    else:
        try:
            for idx, edge in enumerate(ocp_explore_edges(topo_shape)):
                if _try_add_edge(maker, edge, idx, add_edge_fn):
                    successful_count += 1
                    applied_edges.append(edge)
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

    new_face_lineage: dict[str, list[str]] | None = None
    new_edge_lineage: dict[str, list[str]] | None = None
    if lineage_source is not None:
        new_face_lineage, new_edge_lineage = _extract_edge_modifier_lineage(
            maker, topo_shape, built, applied_edges, lineage_source,
        )

    return EdgeModifierResult(
        shape=built,
        success=True,
        reason=None,
        successful_count=successful_count,
        failed_count=failed_count,
        skipped_count=skipped_count,
        failed_indices=failed_indices,
        skipped_indices=skipped_indices,
        face_lineage=new_face_lineage,
        edge_lineage=new_edge_lineage,
    )


def _extract_edge_modifier_lineage(
    maker: Any,
    old_shape: TopoDS_Shape,
    new_shape: TopoDS_Shape,
    filleted_edges: list[TopoDS_Shape],
    lineage_source: dict,
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Build face_lineage and edge_lineage for the new shape after a fillet/chamfer.

    Uses OCC history (maker.Generated, maker.Modified) to track how original
    faces/edges map to the output, and transfers the pre-op lineage tokens.
    """
    import cadquery.occ_impl.shapes as cq_shapes  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer, TopExp  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape  # noqa: PLC0415
    from oversolved.kernel.ocp_ops import ocp_face_area  # noqa: PLC0415
    from oversolved.kernel.cadquery_ops import _compute_face_centroid, _compute_face_normal  # noqa: PLC0415

    old_face_lineage: dict[str, list[str]] = lineage_source.get("face_lineage", {}) or {}
    old_edge_lineage: dict[str, list[str]] = lineage_source.get("edge_lineage", {}) or {}

    # Map: output face hash → entity tokens
    new_face_lineage: dict[str, list[str]] = {}

    # ── Step 1: Walk old faces, map to output via OCC history ──
    # Collect new-shape faces for geometry matching of unchanged faces.
    new_faces_geom: list = []
    exp = TopExp_Explorer(new_shape, TopAbs_FACE)
    while exp.More():
        f = exp.Current()
        cq_f = cq_shapes.Shape.cast(f)
        c = list(_compute_face_centroid(cq_f))
        n = list(_compute_face_normal(cq_f))
        a = ocp_face_area(f)
        new_faces_geom.append((f, c, a, n))
        exp.Next()

    def _face_geom_key(c: list, a: float, n: list) -> tuple:
        return (round(c[0], 6), round(c[1], 6), round(c[2], 6),
                round(a, 6),
                round(n[0], 6), round(n[1], 6), round(n[2], 6))

    def _find_output_face(geom_c, geom_a, geom_n) -> "Any | None":
        key = _face_geom_key(geom_c, geom_a, geom_n)
        for f, fc, fa, fn in new_faces_geom:
            if _face_geom_key(fc, fa, fn) == key:
                return f
        # Fallback: closest match
        best = None
        best_score = float("inf")
        for f, fc, fa, fn in new_faces_geom:
            dc = sum((geom_c[i] - fc[i]) ** 2 for i in range(3)) ** 0.5
            ar = abs(geom_a - fa) / max(geom_a, fa, 1e-12)
            dn = 1.0 - abs(sum(geom_n[i] * fn[i] for i in range(3)))
            score = dc + 0.01 * ar + 0.001 * dn
            if score < best_score:
                best_score = score
                best = f
        return best if best is not None and best_score < 1.0 else None

    old_faces: list = []
    exp = TopExp_Explorer(old_shape, TopAbs_FACE)
    while exp.More():
        f = exp.Current()
        cq_f = cq_shapes.Shape.cast(f)
        old_faces.append((f, list(_compute_face_centroid(cq_f)), ocp_face_area(f), list(_compute_face_normal(cq_f))))
        exp.Next()

    for old_f, old_c, old_a, old_n in old_faces:
        old_fh = str(hash(old_f))
        tokens = old_face_lineage.get(old_fh)
        if not tokens:
            continue
        try:
            if maker.IsDeleted(old_f):
                continue
        except Exception:
            pass
        mods = maker.Modified(old_f)
        if mods.Size() > 0:
            for i in range(mods.Size()):
                out_f = mods.Value(i + 1)
                new_face_lineage[str(hash(out_f))] = list(tokens)
        else:
            out_f = _find_output_face(old_c, old_a, old_n)
            if out_f is not None:
                new_face_lineage[str(hash(out_f))] = list(tokens)

    # ── Step 2: Filleted edges → generated faces ──
    for edge in filleted_edges:
        eh = str(hash(edge))
        edge_tokens = old_edge_lineage.get(eh)
        if not edge_tokens:
            continue
        try:
            generated = maker.Generated(edge)
            if not generated.IsNull():
                gen_exp = TopExp_Explorer(generated, TopAbs_FACE)
                while gen_exp.More():
                    gen_face = gen_exp.Current()
                    new_face_lineage.setdefault(str(hash(gen_face)), edge_tokens)
                    gen_exp.Next()
        except Exception:
            pass

    # ── Step 3: Build edge_lineage from face adjacency ──
    e2f = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(new_shape, TopAbs_EDGE, TopAbs_FACE, e2f)
    new_edge_lineage: dict[str, list[str]] = {}
    edge_exp = TopExp_Explorer(new_shape, TopAbs_EDGE)
    while edge_exp.More():
        se = edge_exp.Current()
        sh = str(hash(se))
        eids: list[str] = []
        seen: set[str] = set()
        for face in e2f.FindFromKey(se):
            fh = str(hash(face))
            for eid in new_face_lineage.get(fh, []):
                if eid not in seen:
                    seen.add(eid)
                    eids.append(eid)
        if eids:
            new_edge_lineage[sh] = eids
        edge_exp.Next()

    return new_face_lineage, new_edge_lineage


def apply_fillet(shape: TopoDS_Shape, radius: float, edges: list[TopoDS_Shape] | None = None) -> TopoDS_Shape:
    """Apply a fillet (round) to edges of a shape.

    Returns the filleted shape, or the original shape if filleting fails.
    """
    return _apply_edge_modifier(
        shape, edges,
        maker_factory=ocp_fillet_factory,
        add_edge_fn=lambda maker, e: maker.Add(radius, e),
    ).shape


def apply_fillet_with_lineage(
    shape: TopoDS_Shape, radius: float, edges: list[TopoDS_Shape],
    body_face_lineage: dict[str, list[str]] | None = None,
    body_edge_lineage: dict[str, list[str]] | None = None,
) -> tuple[TopoDS_Shape, dict[str, list[str]] | None, dict[str, list[str]] | None]:
    """Apply a fillet and track per-entity lineage through the operation.

    Returns (filleted_shape, new_face_lineage, new_edge_lineage).
    """
    result = _apply_edge_modifier(
        shape, edges,
        maker_factory=ocp_fillet_factory,
        add_edge_fn=lambda maker, e: maker.Add(radius, e),
        lineage_source={
            "face_lineage": body_face_lineage or {},
            "edge_lineage": body_edge_lineage or {},
            "filleted_edges": edges,
        },
    )
    return result.shape, result.face_lineage, result.edge_lineage


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


def apply_chamfer_with_lineage(
    shape: TopoDS_Shape, distance: float, edges: list[TopoDS_Shape],
    kind: str = "distance", angle: float = 45.0,
    body_face_lineage: dict[str, list[str]] | None = None,
    body_edge_lineage: dict[str, list[str]] | None = None,
) -> tuple[TopoDS_Shape, dict[str, list[str]] | None, dict[str, list[str]] | None]:
    """Apply a chamfer and track per-entity lineage through the operation.

    Returns (chamfered_shape, new_face_lineage, new_edge_lineage).
    """
    def _add(maker: Any, edge: TopoDS_Shape) -> None:
        if kind == "angle_distance":
            maker.AddDA(distance, angle, edge)
        else:
            maker.Add(distance, edge)

    result = _apply_edge_modifier(
        shape, edges,
        maker_factory=ocp_chamfer_factory,
        add_edge_fn=_add,
        lineage_source={
            "face_lineage": body_face_lineage or {},
            "edge_lineage": body_edge_lineage or {},
            "filleted_edges": edges,
        },
    )
    return result.shape, result.face_lineage, result.edge_lineage


def transform_copy(shape: TopoDS_Shape, trsf: gp_Trsf) -> TopoDS_Shape:
    """Return a new shape that is `shape` with OCC gp_Trsf applied."""
    return ocp_transform_copy(_ensure_occ(shape), trsf)


def make_translation_trsf(dx: float, dy: float, dz: float) -> gp_Trsf:
    return ocp_make_translation_trsf(dx, dy, dz)


def make_rotation_trsf(
    origin: list[float], direction: list[float], angle_rad: float
) -> gp_Trsf:
    return ocp_make_rotation_trsf(origin, direction, angle_rad)
