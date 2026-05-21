from __future__ import annotations

import logging
import re
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Body
from oversolved.kernel.cadquery_ops import _ensure_cq, _ensure_occ, _compute_face_centroid, _compute_face_normal, _triangle_area
from oversolved.kernel.ocp_ops import ocp_curve_info
from oversolved.kernel.geom_hash import edge_geometry_hash, face_geometry_hash
from oversolved.kernel.query import make_ancestry_query, _parse_ancestry
from oversolved.kernel.geometry_features import apply_fillet, apply_chamfer
from oversolved.kernel.solver_features_shared import _resolve_body

logger = logging.getLogger(__name__)

__all__ = [
    "_apply_edge_feature",
    "_resolve_fillet_edges",
    "_solve_chamfer",
    "_solve_fillet",
    "ALL_KEYS",
]

ALL_KEYS: frozenset[str] = frozenset({
    "fillet", "chamfer", "edges", "radius", "distance", "source_body",
})


def _resolve_fillet_edges(body: Body, edge_queries: list[str]) -> list[TopoDS_Shape]:
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
    seen_edge_hashes: set[int] = set()
    resolve_failed = 0
    fallback_used = 0
    fallback_failed = 0

    def _add_edge_unique(e: TopoDS_Shape) -> None:
        h = hash(e)
        if h not in seen_edge_hashes:
            seen_edge_hashes.add(h)
            result.append(e)

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
        # Face query: resolve to all edges of that face
        if edge is None and 'gface_' in q:
            try:
                face_edges = _resolve_face_to_edges(q, body)
                for fe in face_edges:
                    _add_edge_unique(fe)
                if face_edges:
                    logger.debug("fillet: resolved face query %s to %d edges", q, len(face_edges))
            except Exception as exc:
                logger.debug("fillet face-to-edges resolution failed for query %s: %s", q, exc)

        if edge is not None:
            _add_edge_unique(edge)

    if resolve_failed > 0:
        logger.warning("fillet: %d edge queries failed index resolution", resolve_failed)
    if fallback_used > 0:
        logger.warning("fillet: %d edge queries resolved via body-scoped type fallback", fallback_used)
    if fallback_failed > 0:
        logger.warning("fillet: %d edge queries failed body-scoped fallback", fallback_failed)
    return result


def _resolve_face_to_edges(q: str, body: Body) -> list[TopoDS_Shape]:
    """Resolve a face ancestry query to all OCC edges of the matching face."""
    ids, type_restriction = _parse_ancestry(q)
    target_hash = None
    for id_str in ids:
        if id_str.startswith("@gface_"):
            target_hash = id_str
            break
    if not target_hash:
        return []

    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415

    cq_body = _ensure_cq(body.shape)

    for cq_face in cq_body.Faces():
        verts, idxs = cq_face.tessellate(0.1)
        verts_list = [list(v.toTuple()) for v in verts]
        centroid = _compute_face_centroid(cq_face)
        normal = _compute_face_normal(cq_face)
        area = sum(_triangle_area(verts_list[t[0]], verts_list[t[1]], verts_list[t[2]]) for t in idxs)
        gh = face_geometry_hash(centroid, normal, area)
        aq = make_ancestry_query(
            [f"@{gh}", f"@{body.created_by}", f"@{body.id}"], type_restriction
        )
        if aq == q:
            occ_face = _ensure_occ(cq_face)
            exp = TopExp_Explorer(occ_face, TopAbs_EDGE)
            face_edges = []
            while exp.More():
                face_edges.append(TopoDS.Edge_s(exp.Current()))
                exp.Next()
            return face_edges

    return []


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
