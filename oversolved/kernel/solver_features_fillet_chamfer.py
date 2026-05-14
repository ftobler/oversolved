from __future__ import annotations

import logging
import math
import re
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
from oversolved.kernel.query import Repository, _parse_ancestry, make_ancestry_query
from oversolved.kernel.types3d import Body
from oversolved.kernel.cadquery_ops import _ensure_cq, _ensure_occ
from oversolved.kernel.ocp_ops import ocp_curve_info
from oversolved.kernel.geom_hash import edge_geometry_hash
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

    seen_hashes = set()
    topo_edges = []
    edge_types = []
    edge_dicts = []
    for edge in _ensure_cq(body.shape).Edges():
        h = edge.hashCode()
        if h in seen_hashes:
            continue
        seen_hashes.add(h)
        wrapped = edge.wrapped
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
    for q in edge_queries:
        edge = query_to_edge.get(q)  # type: ignore[assignment]
        if edge is None and q.startswith("?"):
            try:
                ids, _ = _parse_ancestry(q)
                for id_str in ids:
                    m = re.match(r"@([^@]+)edge(\d+)$", id_str)
                    if m:
                        eidx = int(m.group(2))
                        if 0 <= eidx < len(topo_edges):
                            edge = topo_edges[eidx]
                            break
            except Exception as exc:
                logger.warning("fillet edge index resolution failed for query %s: %s", q, exc)
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
                        logger.warning(
                            "Resolved fillet edge via body-scoped type fallback: "
                            "query=%s body=%s matched_type=%s",
                            q, body.id, edge_types[topo_edges.index(edge)] if edge in topo_edges else "?",
                        )
            except Exception as exc:
                logger.warning("fillet edge body-scoped fallback failed for query %s: %s", q, exc)
        if edge is not None:
            result.append(edge)

    return result


def _solve_transform(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.cadquery_ops import apply_transform_shape  # noqa: F811
    from oversolved.kernel.types3d import Body  # noqa: F811
    from oversolved.kernel.solver_plane import _get_point_3d, _get_edge_3d  # noqa: F811

    feature_id = feature.get("id", "")
    sub = feature.get("transform") or {}
    cfg = {**sub, **{k: v for k, v in feature.items() if k not in ("transform",)}}

    body_query = cfg.get("body", "")
    source_body = _resolve_body(body_query, body_store) if body_query else None
    if source_body is None or source_body.shape is None:
        raise ValueError(f"transform: body not found: {body_query!r}")

    translation = cfg.get("translation")
    tr_from = cfg.get("translation_from")
    tr_to = cfg.get("translation_to")
    if tr_from and tr_to:
        p0_ref = global_repo.query(tr_from, body_store=body_store)
        p1_ref = global_repo.query(tr_to, body_store=body_store)
        if p0_ref is None:
            raise ValueError(f"transform: translation_from not found: {tr_from!r}")
        if p1_ref is None:
            raise ValueError(f"transform: translation_to not found: {tr_to!r}")
        p0 = _get_point_3d(p0_ref, global_repo)
        p1 = _get_point_3d(p1_ref, global_repo)
        translation = [float(p1[i] - p0[i]) for i in range(3)]

    rotation_angle = float(cfg.get("rotation_angle", 0.0))
    rotation_axis_origin = cfg.get("rotation_axis_origin")
    rotation_axis_direction = cfg.get("rotation_axis_direction")
    axis_query = cfg.get("rotation_axis")
    if axis_query:
        edge_ref = global_repo.query(axis_query, body_store=body_store)
        if edge_ref is None:
            raise ValueError(f"transform: rotation_axis not found: {axis_query!r}")
        edge = _get_edge_3d(edge_ref, global_repo)
        if edge:
            p0, p1 = edge
            d = [float(p1[i] - p0[i]) for i in range(3)]
            length = sum(x * x for x in d) ** 0.5
            if length > 1e-10:
                rotation_axis_origin = list(p0)
                rotation_axis_direction = [x / length for x in d]

    scale = float(cfg.get("scale", 1.0))
    scale_center = cfg.get("scale_center")
    scale_center_query = cfg.get("scale_center_from")
    if scale_center_query:
        pt_ref = global_repo.query(scale_center_query, body_store=body_store)
        if pt_ref is None:
            raise ValueError(f"transform: scale_center_from not found: {scale_center_query!r}")
        scale_center = list(_get_point_3d(pt_ref, global_repo))

    new_shape = apply_transform_shape(
        source_body.shape,
        translation=translation,
        rotation_axis_origin=rotation_axis_origin,
        rotation_axis_direction=rotation_axis_direction,
        rotation_angle_deg=rotation_angle,
        scale=scale,
        scale_center=scale_center,
    )

    operation = cfg.get("operation", "new")
    if operation == "replace":
        source_body.shape = _ensure_occ(new_shape)
        source_body.modified_by = list(source_body.modified_by or []) + [feature_id]
        return {"status": "ok", "body_id": source_body.id, "operation": "replace"}
    else:
        new_body_id = "body_" + feature_id
        body_store[new_body_id] = Body(
            id=new_body_id,
            created_by=feature_id,
            modified_by=[],
            shape=_ensure_occ(new_shape),
            sketch_id=source_body.sketch_id,
        )
        return {"status": "ok", "body_id": new_body_id, "operation": "new"}


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
    from oversolved.kernel.geometry import apply_fillet  # noqa: F811

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
    from oversolved.kernel.geometry import apply_chamfer  # noqa: F811

    sub = feature.get("chamfer") or {}
    feature = {**sub, **feature}
    distance_raw = feature.get("distance")
    distance = float(distance_raw if distance_raw is not None else 1.0)
    kind = feature.get("kind", "distance")
    angle_raw = feature.get("angle")
    angle = float(angle_raw if angle_raw is not None else 45.0)
    if distance <= 0:
        raise ValueError("chamfer distance must be positive")
    return _apply_edge_feature(
        feature, body_store, "chamfer", apply_chamfer,
        distance=distance, kind=kind, angle=angle,
    )
