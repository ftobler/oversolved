from __future__ import annotations

import logging
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Body
from oversolved.kernel.cadquery_ops import _ensure_cq, _ensure_occ, _compute_face_centroid, _compute_face_normal, _triangle_area
from oversolved.kernel.geometry_tessellation import edge_to_geom_dict
from oversolved.kernel.geom_hash import edge_geometry_hash, face_geometry_hash
from oversolved.kernel.query import make_ancestry_query, _parse_ancestry, ref, body_id_of
from oversolved.kernel.geometry_features import (
    apply_fillet_with_diff, apply_chamfer_with_diff,
    apply_fillet_with_lineage, apply_chamfer_with_lineage,
)
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


def _brep_diff_new_edge_hashes(body: Body) -> set[str]:
    """Compute geom_hashes for TopoDS_Edges in body.brep_diff.new_edges.

    Mirrors the same logic in builder.py so the hashes match those computed
    during tessellation. Only line, arc, and circle edges are hashed; splines
    are skipped (no stable hash available).
    """
    diff = getattr(body, "brep_diff", None)
    if diff is None or not diff.new_edges:
        return set()
    try:
        from oversolved.kernel.ocp_ops import ocp_brep_diff_new_edge_data  # noqa: PLC0415
    except ImportError:
        return set()
    edge_data_list = ocp_brep_diff_new_edge_data(diff)
    hashes: set[str] = set()
    for ed in edge_data_list:
        try:
            if ed["type"] == "line":
                for s, e in [
                    (ed["start"], ed["end"]),
                    (ed["end"], ed["start"]),
                ]:
                    hashes.add(edge_geometry_hash({"kind": "line", "start": s, "end": e}))
            elif ed["type"] in ("circle", "arc"):
                hashes.add(edge_geometry_hash(ed))
        except Exception as exc:
            logger.debug("brep_diff edge hash skip: %s", exc)
    return hashes


class _EdgeIndex:
    """Per-body lookup tables for resolving edge queries.

    Enumerating a body's edges and hashing them is expensive, so this is built
    once per body and reused for both body routing and the final fillet.
    """

    __slots__ = ("query_to_edge", "hash_to_edge")

    def __init__(
        self,
        query_to_edge: dict,
        hash_to_edge: dict,
    ) -> None:
        self.query_to_edge = query_to_edge
        self.hash_to_edge = hash_to_edge


def _build_edge_index(body: Body) -> _EdgeIndex:
    seen_edges: list[TopoDS_Shape] = []
    edge_dicts: list[dict] = []
    if body.shape is not None:
        for edge in _ensure_cq(body.shape).Edges():
            wrapped = edge.wrapped
            if any(wrapped.IsEqual(s) for s in seen_edges):
                continue
            seen_edges.append(wrapped)

            # Use the same geometry extraction as solid_to_edges so the geom
            # hash computed here matches the one baked into the edge query.
            ed, _ = edge_to_geom_dict(edge)
            edge_dicts.append(ed)

    # Determine which edges are "new" (created by the last modifier feature).
    # Mirrors the rewrite logic in builder.py:612-629.
    new_edge_hashes: set[str] = set()
    has_modifier = body.brep_diff is not None and body.modified_by and body.modified_by[-1] != body.created_by
    if has_modifier:
        new_edge_hashes = _brep_diff_new_edge_hashes(body)

    query_to_edge: dict = {}
    hash_to_edge: dict = {}
    for idx, (te, ed) in enumerate(zip(seen_edges, edge_dicts)):
        edge_type = "straightedge" if ed["kind"] == "line" else "edge"
        geom_hash = edge_geometry_hash(ed)
        # Body-agnostic geometry index: a stale @body_<id> token in a query
        # must still resolve to whichever body now owns this edge. The geom
        # hash encodes location/orientation, so it is unique per physical edge.
        hash_to_edge.setdefault(geom_hash, te)
        if body.created_by:
            edge_created_by = body.created_by
            if geom_hash in new_edge_hashes:
                edge_created_by = body.modified_by[-1]
            ids = [ref(geom_hash), ref(edge_created_by), ref(body.id)]
            if body.edge_lineage:
                tokens = body.edge_lineage.get(str(hash(te)))
                if tokens:
                    ids.extend(tokens)
            elif body.profile_queries:
                ids.extend(body.profile_queries)
            aq_hash = make_ancestry_query(ids, edge_type)
            query_to_edge[aq_hash] = te

        query_to_edge[f"?{body.id}:edge:{idx}"] = te

    return _EdgeIndex(query_to_edge, hash_to_edge)


def _resolve_edges_with_index(
    body: Body, index: _EdgeIndex, edge_queries: list[str],
) -> list[TopoDS_Shape]:
    """Resolve edge queries against a body's prebuilt index.

    Resolution tiers: exact query match → geometry hash → face query.
    """
    query_to_edge = index.query_to_edge
    hash_to_edge = index.hash_to_edge

    result: list[TopoDS_Shape] = []
    seen_edge_hashes: set[int] = set()

    def _add_edge_unique(e: TopoDS_Shape) -> None:
        h = hash(e)
        if h not in seen_edge_hashes:
            seen_edge_hashes.add(h)
            result.append(e)

    for q in edge_queries:
        edge = query_to_edge.get(q)  # type: ignore[assignment]
        # Geometry-hash match, ignoring the (possibly stale) @body_<id> token.
        if edge is None and q.startswith("?"):
            try:
                ids, _ = _parse_ancestry(q)
                for id_str in ids:
                    if id_str.startswith("@gedge_"):
                        edge = hash_to_edge.get(id_str[1:])
                        if edge is not None:
                            break
            except Exception as exc:
                logger.debug("fillet edge geom-hash resolution failed for query %s: %s", q, exc)
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

    return result


def _resolve_fillet_edges(body: Body, edge_queries: list[str]) -> list[TopoDS_Shape]:
    if body.shape is None or not edge_queries:
        return []
    return _resolve_edges_with_index(body, _build_edge_index(body), edge_queries)


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
        if ref(gh) == target_hash:
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
    geometry_fn: Callable[..., tuple[TopoDS_Shape, Any]],
    lineage_fn: Callable[..., tuple[TopoDS_Shape, dict[str, list[str]] | None, dict[str, list[str]] | None, Any]] | None = None,
    **geometry_kwargs: Any,
) -> dict:
    """Shared body-resolution and edge-application logic for fillet and chamfer.

    Raises ValueError for user-facing errors; callers wrap in try/except.
    """
    feature_id = feature.get("id", "")
    edges: list[str] = feature.get("edges", [])
    if not edges:
        raise ValueError(f"{feature_kind}: requires at least one edge")
    if not body_store:
        raise ValueError(f"{feature_kind}: no bodies in body_store")

    source_body = feature.get("source_body", "")

    # Edge enumeration + hashing is expensive, so build each body's index at
    # most once and reuse it for routing and the final fillet.
    index_cache: dict[str, _EdgeIndex] = {}

    def _index_for(bid: str) -> _EdgeIndex:
        idx = index_cache.get(bid)
        if idx is None:
            idx = _build_edge_index(body_store[bid])
            index_cache[bid] = idx
        return idx

    def _contains(bid: str, q: str) -> bool:
        body = body_store.get(bid)
        if body is None or body.shape is None:
            return False
        return bool(_resolve_edges_with_index(body, _index_for(bid), [q]))

    # Route each edge query to the body that actually owns it. The @body_<id>
    # token baked into a query goes stale when upstream geometry is restructured
    # (e.g. an extrude split in two), so it is only a hint: prefer the body whose
    # geometry actually matches the query, and fall back to the token last.
    groups: dict[str, list[str]] = {}
    unresolved: list[str] = []
    if source_body:
        # source_body may be a feature id like 'ex1' or a body id like 'body_ex1'.
        # Resolve to an actual body_store key.
        resolved_src = source_body
        if source_body not in body_store:
            for bid, body in body_store.items():
                if body.created_by == source_body:
                    resolved_src = bid
                    break
        groups[resolved_src] = list(edges)
    else:
        for q in edges:
            named = body_id_of(q, body_store)
            is_default = named is None and len(body_store) == 1
            if is_default:
                named = next(iter(body_store))
            target: str | None = None
            if named and named in body_store and _contains(named, q):
                target = named  # the token is correct
            else:
                for bid in body_store:  # follow the geometry
                    if bid != named and _contains(bid, q):
                        target = bid
                        break
            # Last resort only when body_id_of found the token (not default).
            if target is None and named in body_store and not is_default:
                target = named
            if target is None:
                logger.warning(
                    "%s: edge query resolves to no body; skipping query %s",
                    feature_kind, q,
                )
                unresolved.append(q)
                continue
            groups.setdefault(target, []).append(q)

    applied: list[str] = []
    for bid, qlist in groups.items():
        try:
            body = _resolve_body(bid, body_store)
        except ValueError as exc:
            logger.warning("%s: %s", feature_kind, exc)
            unresolved.extend(qlist)
            continue
        if body.shape is None:
            logger.warning("%s: body %s has no shape", feature_kind, body.id)
            unresolved.extend(qlist)
            continue
        # Validate the shape before passing to OCC; a corrupted shape
        # can cause SIGSEGV inside the fillet/chamfer kernel.
        try:
            if _ensure_occ(body.shape).IsNull():
                logger.warning("%s: body %s shape is null", feature_kind, body.id)
                unresolved.extend(qlist)
                continue
        except Exception:
            logger.warning("%s: body %s shape is invalid", feature_kind, body.id)
            unresolved.extend(qlist)
            continue

        topo_edges = _resolve_edges_with_index(body, _index_for(bid), qlist)
        if not topo_edges:
            logger.warning("%s: no edges resolved on body %s", feature_kind, body.id)
            unresolved.extend(qlist)
            continue

        if lineage_fn is not None and (body.face_lineage or body.edge_lineage):
            new_shape, new_fl, new_el, brep_diff = lineage_fn(
                body.shape, topo_edges,
                body.face_lineage if body.face_lineage else {},
                body.edge_lineage if body.edge_lineage else {},
                **geometry_kwargs,
            )
            body.shape = new_shape
            if new_fl is not None:
                body.face_lineage = new_fl
            if new_el is not None:
                body.edge_lineage = new_el
        else:
            body.shape, brep_diff = geometry_fn(body.shape, edges=topo_edges, **geometry_kwargs)
        body.brep_diff = brep_diff
        body.modified_by.append(feature_id)
        applied.append(body.id)

    if not applied:
        raise ValueError(f"{feature_kind}: no edges resolved")

    if unresolved:
        return {
            "status": "partial",
            "body_id": applied[0],
            "body_ids": applied,
            "exception": (
                f"{feature_kind}: {len(unresolved)} edge(s) could not be resolved"
            ),
        }

    return {"status": "ok", "body_id": applied[0], "body_ids": applied}


def _apply_fillet_lineage(
    shape: TopoDS_Shape,
    edges: list[TopoDS_Shape],
    face_lineage: dict[str, list[str]],
    edge_lineage: dict[str, list[str]],
    radius: float = 1.0,
    **__: Any,
) -> tuple[TopoDS_Shape, dict[str, list[str]] | None, dict[str, list[str]] | None, Any]:
    """Shim to match _apply_edge_feature's lineage_fn signature."""
    return apply_fillet_with_lineage(shape, radius, edges, face_lineage, edge_lineage)


def _apply_chamfer_lineage(
    shape: TopoDS_Shape,
    edges: list[TopoDS_Shape],
    face_lineage: dict[str, list[str]],
    edge_lineage: dict[str, list[str]],
    distance: float = 1.0,
    kind: str = "distance",
    angle: float = 45.0,
    **__: Any,
) -> tuple[TopoDS_Shape, dict[str, list[str]] | None, dict[str, list[str]] | None, Any]:
    """Shim to match _apply_edge_feature's lineage_fn signature."""
    return apply_chamfer_with_lineage(
        shape, distance, edges, kind, angle, face_lineage, edge_lineage,
    )


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
        raise ValueError("fillet: radius must be positive")
    return _apply_edge_feature(
        feature, body_store, "fillet", apply_fillet_with_diff,
        lineage_fn=_apply_fillet_lineage,
        radius=radius,
    )


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
        raise ValueError("chamfer: distance must be positive")
    return _apply_edge_feature(
        feature, body_store, "chamfer", apply_chamfer_with_diff,
        lineage_fn=_apply_chamfer_lineage,
        distance=distance, kind=kind, angle=angle,
    )
