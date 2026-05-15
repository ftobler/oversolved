from __future__ import annotations

import logging
import re
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Body
from oversolved.kernel.cadquery_ops import _ensure_cq, _ensure_occ
from oversolved.kernel.ocp_ops import ocp_curve_info
from oversolved.kernel.solver_features_shared import _resolve_body

logger = logging.getLogger(__name__)

__all__ = [
    "_apply_edge_feature",
    "_resolve_fillet_edges",
    "_solve_chamfer",
    "_solve_fillet",
]


def _resolve_fillet_edges(body: Body, edge_queries: list[str]) -> list[TopoDS_Shape]:
    from oversolved.kernel.geom_hash import edge_geometry_hash  # noqa: F811
    from oversolved.kernel.query import make_ancestry_query, _parse_ancestry  # noqa: F811

    if body.shape is None or not edge_queries:
        return []

    seen_edges: list[TopoDS_Shape] = []
    topo_edges = []
    edge_types = []
    edge_dicts = []
    for edge in _ensure_cq(body.shape).Edges():
        wrapped = edge.wrapped
        if any(wrapped.IsEqual(s) for s in seen_edges):
            continue
        seen_edges.append(wrapped)
        topo_edges.append(wrapped)
        gt = edge.geomType()
        edge_types.append("straightedge" if gt == "LINE" else "edge")

        curve = ocp_curve_info(wrapped)
        ed: dict = {"kind": gt.lower()}
        if curve["type"] == "line":
            sp = edge.startPoint()  # type: ignore[attr-defined]
            ep = edge.endPoint()  # type: ignore[attr-defined]
            ed["start"] = [sp.x, sp.y, sp.z]
            ed["end"] = [ep.x, ep.y, ep.z]
        elif curve["type"] == "circle":
            ed["center"] = curve["center"]
            ed["radius"] = curve["radius"]
            ed["angle_start"] = curve["angle_start"]
            ed["angle_end"] = curve["angle_end"]
        else:
            n_pts = 16
            pts = []
            for i in range(n_pts + 1):
                pt = edge.positionAt(i / n_pts)  # type: ignore[attr-defined]
                pts.append([pt.x, pt.y, pt.z])
            ed["points"] = pts
        edge_dicts.append(ed)

    query_to_edge = {}
    for idx, (te, et, ed) in enumerate(zip(topo_edges, edge_types, edge_dicts)):
        if body.created_by:
            geom_hash = edge_geometry_hash(ed)
            aq_hash = make_ancestry_query(
                [f"@{geom_hash}", f"@{body.created_by}", f"@{body.id}"], et
            )
            query_to_edge[aq_hash] = te

            aq = make_ancestry_query(
                [f"@{body.created_by}edge{idx}", f"@{body.created_by}"], et
            )
            query_to_edge[aq] = te
            aq3 = make_ancestry_query(
                [f"@{body.id}edge{idx}", f"@{body.created_by}", f"@{body.id}"], et
            )
            query_to_edge[aq3] = te
        query_to_edge[f"?{body.id}:edge:{idx}"] = te

    result: list[TopoDS_Shape] = []
    resolve_failed = 0
    fallback_used = 0
    fallback_failed = 0
    for q in edge_queries:
        edge = query_to_edge.get(q)  # type: ignore[assignment]
        if edge is None and q.startswith("?"):
            try:
                ids, _ = _parse_ancestry(q)
                for id_str in ids:
                    m = re.match(r"@([^/]+)/edge(\d+)$", id_str)
                    if m:
                        eidx = int(m.group(2))
                        if 0 <= eidx < len(topo_edges):
                            edge = topo_edges[eidx]
                            break
            except Exception as exc:
                logger.debug("fillet edge index resolution failed for query %s: %s", q, exc)
                resolve_failed += 1
        if edge is None and q.startswith("?"):
            try:
                ids, type_restriction = _parse_ancestry(q)
                body_id_from_query = None
                for id_str in ids:
                    if id_str.startswith("@body_"):
                        body_id_from_query = id_str[1:]
                        break
                if body_id_from_query and body_id_from_query == body.id:
                    matched = [
                        te for te, et in zip(topo_edges, edge_types)
                        if type_restriction is None or et == type_restriction
                    ]
                    if matched:
                        edge = matched[0]
                        logger.debug(
                            "fillet edge resolved via body-scoped type fallback: "
                            "query=%s body=%s",
                            q, body.id,
                        )
                        fallback_used += 1
            except Exception as exc:
                logger.debug("fillet edge body-scoped fallback failed for query %s: %s", q, exc)
                fallback_failed += 1
        if edge is not None:
            result.append(edge)

    if resolve_failed > 0:
        logger.warning("fillet: %d edge queries failed index resolution", resolve_failed)
    if fallback_used > 0:
        logger.warning("fillet: %d edge queries resolved via body-scoped type fallback", fallback_used)
    if fallback_failed > 0:
        logger.warning("fillet: %d edge queries failed body-scoped fallback", fallback_failed)
    return result


def _apply_edge_feature(
    feature: dict,
    body_store: dict,
    feature_kind: str,
    geometry_fn: Callable[..., TopoDS_Shape],
    **geometry_kwargs: Any,
) -> dict:
    """Shared body-resolution and edge-application logic for fillet and chamfer.

    Raises ValueError for user-facing errors; callers wrap in try/except.
    """
    feature_id = feature.get("id", "")
    edges: list[str] = feature.get("edges", [])
    if not edges:
        raise ValueError(f"{feature_kind} requires at least one edge")

    source_body = feature.get("source_body", "")
    if source_body:
        body = _resolve_body(source_body, body_store)
    else:
        if not body_store:
            raise ValueError(f"no body found for {feature_kind}")
        body = next(iter(body_store.values()))
    body_id = body.id

    if body.shape is None:
        raise ValueError(f"body {body_id} has no shape")

    # Validate the shape before passing to OCC; a corrupted shape
    # can cause SIGSEGV inside the fillet/chamfer kernel.
    try:
        if _ensure_occ(body.shape).IsNull():
            raise ValueError(f"body {body_id} shape is null")
    except Exception:
        raise ValueError(f"body {body_id} shape is invalid")

    topo_edges = _resolve_fillet_edges(body, edges)
    if not topo_edges:
        raise ValueError(f"no edges resolved for {feature_kind}")

    new_shape = geometry_fn(body.shape, edges=topo_edges, **geometry_kwargs)
    body.shape = new_shape
    body.modified_by.append(feature_id)

    return {"status": "ok", "body_id": body_id}


def _solve_fillet(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.geometry_features import apply_fillet  # noqa: F811

    sub = feature.get("fillet") or {}
    feature = {**sub, **feature}
    radius_raw = feature.get("radius")
    radius = float(radius_raw if radius_raw is not None else 1.0)
    if radius <= 0:
        raise ValueError("fillet radius must be positive")
    return _apply_edge_feature(feature, body_store, "fillet", apply_fillet, radius=radius)


def _solve_chamfer(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.geometry_features import apply_chamfer  # noqa: F811

    sub = feature.get("chamfer") or {}
    chamfer_mode = sub.get("kind", "distance")
    feature = {**sub, **feature}
    distance_raw = feature.get("distance")
    distance = float(distance_raw if distance_raw is not None else 1.0)
    kind = chamfer_mode
    angle_raw = feature.get("angle")
    angle = float(angle_raw if angle_raw is not None else 45.0)
    if distance <= 0:
        raise ValueError("chamfer distance must be positive")
    return _apply_edge_feature(
        feature, body_store, "chamfer", apply_chamfer,
        distance=distance, kind=kind, angle=angle,
    )
