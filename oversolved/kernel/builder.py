from __future__ import annotations

import copy
import hashlib
import json
import logging
import time
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
from oversolved.kernel.cadquery_ops import _normal_to_frame, _ensure_occ
from oversolved.kernel.ocp_ops import ocp_copy_shape
from oversolved.kernel.geom_hash import face_geometry_hash, edge_geometry_hash, vertex_geometry_hash
from oversolved.kernel.query import Repository, emit_wire, absolute, _evict_ancestry_and_register, ref
from oversolved.kernel.geometry_tessellation import MeshDict
from oversolved.kernel.types3d import Body, FeatureCheckpoint, BuildState
from oversolved.kernel.solver import _init_global_repo, _try_solve_feature
from oversolved.kernel.solver_constants import _BUILTIN_PLANE_RESULTS
from oversolved.kernel.solver_registry import _post_register
from oversolved.kernel import (
    solver_features_brep,
    solver_features_array,
    solver_features_boolean,
    solver_features_delete,
    solver_features_fillet_chamfer,
    solver_features_hole,
    solver_features_import,
    solver_features_transform_mirror,
)

try:
    import oversolved.kernel.geometry_tessellation  # noqa: F401  # pre-warm to avoid concurrent-import race
except ImportError:
    pass

logger = logging.getLogger(__name__)

__all__ = [
    "build",
    "_validate_incremental",
    "_hash_checkpoint_spec",
    "_hash_result_dict",
    "_repo_from_snapshot",
    "_copy_shape",
]


def _copy_shape(shape: TopoDS_Shape | None) -> TopoDS_Shape | None:
    """Return a defensive copy of an OCC shape using BRepBuilderAPI_Copy.

    OCC TopoDS_Shape objects are mutable; in-place operations (fuse, fillet, etc.)
    mutate the original. This function creates an independent copy so that storing
    a shape in a checkpoint does not get corrupted by later mutations.
    """
    if shape is None:
        return None
    try:
        return ocp_copy_shape(_ensure_occ(shape))
    except Exception as exc:
        logger.warning("Failed to copy OCP shape, discarding shape: %s", exc)
        return None


def _extract_all_keys(mod: Any) -> frozenset[str]:
    """Return mod.ALL_KEYS; raise ImportError if the attribute is absent or wrong type."""
    keys = getattr(mod, "ALL_KEYS", None)
    if not isinstance(keys, frozenset):
        raise ImportError(
            f"{getattr(mod, '__name__', repr(mod))} must export ALL_KEYS: frozenset[str]"
        )
    return keys


# Modules whose ALL_KEYS participate in dirty detection.
_FEATURE_MODULES = (
    solver_features_brep,
    solver_features_array,
    solver_features_boolean,
    solver_features_delete,
    solver_features_fillet_chamfer,
    solver_features_hole,
    solver_features_import,
    solver_features_transform_mirror,
)

# Keys shared across all feature kinds: sketch-level, plane, and UI attributes.
_COMMON_FEATURE_KEYS: frozenset[str] = frozenset({
    "id", "kind",
    # sketch feature
    "plane", "entities", "constraints", "initial",
    # plane definition (used by solver_plane)
    "definition",
    # UI-only: do not trigger re-solve, but must track for dirty detection
    "hide", "label", "suppressed", "file_id",
})

# _FEATURE_CMP_KEYS is built by union so adding a new solver_features_* module
# automatically extends dirty detection — no manual edit needed here.
_FEATURE_CMP_KEYS: frozenset[str] = frozenset().union(
    _COMMON_FEATURE_KEYS,
    *(_extract_all_keys(mod) for mod in _FEATURE_MODULES),
)


def _normalize_spec(spec: dict) -> dict:
    """Return a copy of spec containing only canonical feature keys."""
    return {k: spec[k] for k in _FEATURE_CMP_KEYS if k in spec}


def _find_first_dirty(features: list[dict], prev_state: BuildState | None) -> int:
    """Return the index of the first feature that differs from prev_state.

    Returns 0 if prev_state is None or if the feature list length changed.
    All features at or after this index must be re-solved.
    """
    if prev_state is None:
        return 0
    prev_order = prev_state.feature_order
    for i, feature in enumerate(features):
        fid = feature.get("id", "")
        if i >= len(prev_order) or prev_order[i] != fid:
            return i
        prev_checkpoint = prev_state.checkpoints.get(fid)
        if prev_checkpoint is None or _normalize_spec(prev_checkpoint.spec) != _normalize_spec(feature):
            return i
    return len(features)


# ─── Rebuild assertion: three-layer comparison helpers ───


def _round_floats(obj: Any, ndigits: int) -> Any:
    if isinstance(obj, float):
        r = round(obj, ndigits)
        return r + 0.0  # canonicalize -0.0 -> 0.0 so JSON serialization is stable

    if isinstance(obj, list):
        return [_round_floats(v, ndigits) for v in obj]
    if isinstance(obj, tuple):
        return tuple(_round_floats(v, ndigits) for v in obj)
    if isinstance(obj, dict):
        return {k: _round_floats(v, ndigits) for k, v in obj.items()}
    return obj


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, default=repr)


# Result-dict keys that capture wall-clock or non-geometric metadata.
# Stripped before hashing so timing jitter doesn't trigger false-positive diffs.
_RESULT_NON_GEOMETRIC_KEYS = frozenset({"solve_ms"})


def _strip_non_geometric(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {
            k: _strip_non_geometric(v)
            for k, v in obj.items()
            if k not in _RESULT_NON_GEOMETRIC_KEYS
        }
    if isinstance(obj, list):
        return [_strip_non_geometric(v) for v in obj]
    return obj


def _hash_checkpoint_spec(cp: FeatureCheckpoint) -> str:
    return hashlib.sha256(_stable_json(cp.spec).encode()).hexdigest()


def _hash_result_dict(result: dict, *, fp_round: int | None = None) -> str:
    payload = _strip_non_geometric(result)
    if fp_round is not None:
        payload = _round_floats(payload, fp_round)
    return hashlib.sha256(_stable_json(payload).encode()).hexdigest()


def _diff_repo_snapshot(
    a: BuildState, b: BuildState, *, feature_idx: int | None = None,
) -> dict[str, Any]:
    """Return a structural diff between two BuildStates, or {} if equivalent."""
    diff: dict[str, Any] = {}
    if a.feature_order != b.feature_order:
        diff["feature_order"] = {"a": a.feature_order, "b": b.feature_order}

    fids = a.feature_order if feature_idx is None else [a.feature_order[feature_idx]]
    for fid in fids:
        cp_a = a.checkpoints.get(fid)
        cp_b = b.checkpoints.get(fid)
        if cp_a is None or cp_b is None:
            diff.setdefault("missing_checkpoints", []).append(fid)
            continue
        # Body store comparison: ids, created_by, modified_by.
        a_bodies = {
            bid: {"created_by": body.created_by, "modified_by": list(body.modified_by)}
            for bid, body in cp_a.body_store_snapshot.items()
        }
        b_bodies = {
            bid: {"created_by": body.created_by, "modified_by": list(body.modified_by)}
            for bid, body in cp_b.body_store_snapshot.items()
        }
        if a_bodies != b_bodies:
            diff.setdefault("body_store", {})[fid] = {"a": a_bodies, "b": b_bodies}

        # Repo snapshot: compare ancestral keys + element payloads.
        a_repo = cp_a.repo_snapshot
        b_repo = cp_b.repo_snapshot
        a_keys = set(map(_stable_json, a_repo.get("ancestral", {}).keys()))
        b_keys = set(map(_stable_json, b_repo.get("ancestral", {}).keys()))
        added = sorted(b_keys - a_keys)
        removed = sorted(a_keys - b_keys)
        if added or removed:
            diff.setdefault("repo_ancestral", {})[fid] = {
                "added": added[:20], "removed": removed[:20],
                "added_total": len(added), "removed_total": len(removed),
            }
    return diff


def _validate_incremental(
    incremental_state: BuildState,
    incremental_result: dict[str, Any],
    doc: dict,
) -> dict[str, Any]:
    """Compare the incremental build result against a fresh-from-scratch full rebuild.

    Returns dict with keys: level (1|2|3), passed (bool), fp_only (bool, optional), diffs (dict).
    Level meanings: 1 = spec-hash, 2 = result-dict, 3 = repo/body-store.
    Inner build() call MUST NOT set _validate to avoid recursion.
    """
    doc_for_full = {k: v for k, v in doc.items() if k != "_validate"}
    fresh = build(doc_for_full, prev_state=None)
    fresh_state: BuildState = fresh["_build_state"]
    fresh_result: dict = fresh.get("result", {})

    # L1: spec hash per feature.
    for fid in incremental_state.feature_order:
        cp_a = incremental_state.checkpoints.get(fid)
        cp_b = fresh_state.checkpoints.get(fid)
        if cp_a is None or cp_b is None:
            return {"level": 1, "passed": False, "diffs": {"missing_checkpoint": fid}}
        if _hash_checkpoint_spec(cp_a) != _hash_checkpoint_spec(cp_b):
            return {"level": 1, "passed": False, "diffs": {"feature_id": fid}}

    # L2: result dict, strict then FP-tolerant.
    inc_r = {fid: incremental_result.get(fid) for fid in incremental_state.feature_order}
    fresh_r = {fid: fresh_result.get(fid) for fid in fresh_state.feature_order}
    if _hash_result_dict(inc_r) != _hash_result_dict(fresh_r):
        if _hash_result_dict(inc_r, fp_round=4) == _hash_result_dict(fresh_r, fp_round=4):
            return {"level": 2, "passed": False, "fp_only": True,
                    "diffs": {"reason": "floating-point drift within 4dp tolerance"}}
        # Structural L2 diff -> escalate to L3 for actionable info.
        return {
            "level": 3, "passed": False,
            "diffs": _diff_repo_snapshot(incremental_state, fresh_state),
        }

    # L3 final guard.
    l3 = _diff_repo_snapshot(incremental_state, fresh_state)
    if l3:
        return {"level": 3, "passed": False, "diffs": l3}
    return {"level": 3, "passed": True, "diffs": {}}


def _brep_diff_new_edge_hashes(body: Body) -> set[str]:
    """Compute geom_hashes for TopoDS_Edges in body.brep_diff.new_edges.

    Mirrors _brep_diff_new_face_hashes for the edge case. Only line, arc, and
    circle edges are hashed; splines are skipped (no stable hash available).
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


def _brep_diff_new_vertex_hashes(body: Body) -> set[str]:
    """Return vertex_geometry_hash strings for vertices that are purely new.

    A vertex is "purely new" if it appears as an endpoint of at least one
    new_edge but NOT as an endpoint of any inherited_edge. This catches corners
    of a cut window (all adjacent edges are new) while correctly falling back
    for vertices shared between new and inherited edges.
    """
    diff = getattr(body, "brep_diff", None)
    if diff is None or not diff.new_edges:
        return set()
    try:
        from oversolved.kernel.ocp_ops import ocp_brep_diff_vertex_endpoints  # noqa: PLC0415
    except ImportError:
        return set()
    new_verts_pts, inherited_verts_pts = ocp_brep_diff_vertex_endpoints(diff)
    new_hashes = {vertex_geometry_hash(list(pt)) for pt in new_verts_pts}
    inherited_hashes = {vertex_geometry_hash(list(pt)) for pt in inherited_verts_pts}
    return new_hashes - inherited_hashes


def _brep_diff_new_face_hashes(body: Body) -> set[str]:
    """Compute geom_hashes for TopoDS_Faces in body.brep_diff.new_faces.

    Used to identify which face_data entries are "new" (introduced by the
    boolean op) so their `@created_by` can be tagged with the cutting feature
    rather than the body's original creator.

    Area is computed by tessellating each new face and summing triangle areas
    (same method as solid_to_mesh) so the resulting hash matches the hash
    computed from the tessellated mesh.
    """
    diff = getattr(body, "brep_diff", None)
    if diff is None or not diff.new_faces:
        return set()
    try:
        from oversolved.kernel.cadquery_ops import _compute_face_centroid, _compute_face_normal, _triangle_area
        from oversolved.kernel.ocp_ops import ocp_mesh_shape
        import cadquery.occ_impl.shapes as cq_shapes  # noqa: PLC0415
    except ImportError:
        return set()
    hashes: set[str] = set()
    for topo_face in diff.new_faces:
        try:
            cq_face = cq_shapes.Shape.cast(topo_face)
            centroid = _compute_face_centroid(cq_face)
            normal = _compute_face_normal(cq_face)
            ocp_mesh_shape(topo_face, 0.1, 0.1)
            verts, idxs = cq_face.tessellate(0.1)
            flat_verts = [list(v.toTuple()) for v in verts]
            area = sum(
                _triangle_area(flat_verts[tri[0]], flat_verts[tri[1]], flat_verts[tri[2]])
                for tri in idxs
            )
            hashes.add(face_geometry_hash(centroid, normal, area))
        except Exception as exc:  # narrow OCP errors aren't easy to type
            logger.debug("brep_diff hash skip: %s", exc)
    return hashes


def _register_brep_face_ancestry(global_repo, body: Body, mesh: MeshDict) -> None:
    """Register B-rep face ancestry objects in the global query repository.

    User invariant (solver_arch.user.md §B-rep Operation Tracking):
      "New faces created by a cut in extrude2 track to extrude2 only."
    When body.brep_diff is populated, faces classified as "new" by the OCP
    history get @created_by = body.modified_by[-1] (the cutting feature),
    while inherited faces keep body.created_by (the original feature).
    """
    if global_repo is None or body.shape is None or not body.created_by:
        return

    new_face_hashes = _brep_diff_new_face_hashes(body)

    face_data = mesh.get("face_data") or []
    for face_idx, face_info in enumerate(face_data):
        centroid = face_info.get("centroid", [0.0, 0.0, 0.0])
        normal = face_info.get("normal", [0.0, 0.0, 1.0])
        area = face_info.get("area", 0.0)
        geom_hash = face_geometry_hash(centroid, normal, area)

        # Per-face provenance: new faces track to the latest modifier, not the
        # body's original creator. Falls back to body.created_by for inherited
        # faces or when brep_diff is unavailable.
        face_created_by = body.created_by
        if new_face_hashes and geom_hash in new_face_hashes and body.modified_by:
            face_created_by = body.modified_by[-1]

        ancestor_ids = [
            emit_wire(absolute(body.id, f"face{face_idx}")),
            emit_wire(absolute(face_created_by)),
            emit_wire(absolute(body.id)),
        ]
        if body.profile_queries:
            ancestor_ids.extend(body.profile_queries)
        x_axis, y_axis = _normal_to_frame(normal)
        payload = {
            "type": face_info.get("surface_type", "face"),
            "body_id": body.id,
            "created_by": face_created_by,
            "face_index": face_idx,
            "centroid": centroid,
            "normal": normal,
            "origin": centroid,
            "x_axis": x_axis,
            "y_axis": y_axis,
        }
        key = frozenset(ancestor_ids)
        existing_ids = global_repo.ancestral.get(key, [])
        if any(global_repo.elements.get(eid) == payload for eid in existing_ids):
            continue  # already registered with identical payload
        index_tag = emit_wire(absolute(body.id, f"face{face_idx}"))
        _evict_ancestry_and_register(global_repo, ancestor_ids, payload, index_tag, geom_hash=geom_hash)


def _register_solid_ancestry(global_repo, body: Body) -> None:
    """Register the solid body itself as a queryable solid entity."""
    if global_repo is None or not body.created_by:
        return
    global_repo.register_ancestor(
        [ref(body.created_by)],
        {"type": "solid", "body_id": body.id, "created_by": body.created_by},
    )


def _register_extrusion_feature(global_repo, feature_id: str, sketch_id: str = "") -> None:
    """Register an extrusion feature as a queryable extrusion-feature entity."""
    if global_repo is None or not feature_id:
        return
    global_repo.register_ancestor(
        [ref(feature_id)],
        {"type": "extrusion-feature", "feature_id": feature_id, "sketch_id": sketch_id},
    )


def _dedupe_repo(repo: Repository) -> None:
    """Drop duplicate identical ancestry registrations from a repo snapshot."""
    for key, element_ids in list(repo.ancestral.items()):
        unique_ids: list[str] = []
        seen: set[str] = set()
        for element_id in element_ids:
            payload = repo.elements.get(element_id)
            if payload is None:
                continue
            payload_hash = json.dumps(payload, sort_keys=True)
            if payload_hash in seen:
                repo.elements.pop(element_id, None)
                continue
            seen.add(payload_hash)
            unique_ids.append(element_id)
        if unique_ids:
            repo.ancestral[key] = unique_ids
        else:
            repo.ancestral.pop(key, None)


def _repo_from_snapshot(repo_snapshot: dict) -> Repository:
    """Rehydrate a repository snapshot, including ancestry index state."""
    repo = Repository()
    if "elements" in repo_snapshot or "ancestral" in repo_snapshot:
        repo.elements = dict(repo_snapshot.get("elements", {}))
        repo.ancestral = {
            k: list(v) for k, v in repo_snapshot.get("ancestral", {}).items()
        }
        repo.by_geom_hash = {
            k: list(v) for k, v in repo_snapshot.get("by_geom_hash", {}).items()
        }
    else:
        raise ValueError("Snapshot missing 'elements' key")
    _dedupe_repo(repo)
    return repo


def _snapshot_with_brep_geometry(
    checkpoint: FeatureCheckpoint,
    bodies_out: dict[str, dict],
) -> dict[str, Any]:
    """Return a repo snapshot with all B-rep ancestry for this checkpoint.

    Augments the checkpoint's existing repo snapshot with faces, edges, vertices,
    solid entities, and feature entities derived from the final tessellation.
    """
    repo = _repo_from_snapshot(checkpoint.repo_snapshot)

    for body_id, body in checkpoint.body_store_snapshot.items():
        body_out = bodies_out.get(body_id) or {}
        mesh = body_out.get("mesh")
        if mesh is not None:
            _register_brep_face_ancestry(repo, body, mesh)
        edges = body_out.get("edges") or []
        edge_queries = body_out.get("edge_queries") or []
        if edges and edge_queries:
            _register_brep_edge_ancestry(repo, body, edges, edge_queries)
        vertices = body_out.get("vertices") or []
        vertex_queries = body_out.get("vertex_queries") or []
        if vertices and vertex_queries:
            _register_brep_vertex_ancestry(repo, body, vertices, vertex_queries)
        if body.created_by:
            _register_solid_ancestry(repo, body)
            _register_extrusion_feature(repo, body.created_by, body.sketch_id)

    return {
        "version": 2,
        "elements": repo.elements,
        "ancestral": repo.ancestral,
        "by_geom_hash": repo.by_geom_hash,
    }


def _register_brep_edge_ancestry(global_repo, body: Body, edges: list, edge_queries: list) -> None:
    """Register B-rep edge ancestry objects in the global query repository.

    New edges from a boolean op (identified via brep_diff.new_edges) are tagged
    with body.modified_by[-1] rather than body.created_by, mirroring the face rule.
    """
    if global_repo is None or not body.created_by or not edge_queries:
        return
    new_edge_hashes = _brep_diff_new_edge_hashes(body)
    for idx, (edge, query) in enumerate(zip(edges, edge_queries)):
        geom_hash = edge_geometry_hash(edge)
        edge_created_by = body.created_by
        if new_edge_hashes and geom_hash in new_edge_hashes and body.modified_by:
            edge_created_by = body.modified_by[-1]
        ancestor_ids = [
            emit_wire(absolute(body.id, f"edge{idx}")),
            emit_wire(absolute(edge_created_by)),
            emit_wire(absolute(body.id)),
        ]
        if body.profile_queries:
            ancestor_ids.extend(body.profile_queries)
        edge_type = "straightedge" if edge.get("kind") == "line" else "edge"
        payload: dict[str, Any] = {
            "type": edge_type,
            "body_id": body.id,
            "created_by": edge_created_by,
            "edge_index": idx,
            "kind": edge.get("kind"),
            "start": edge.get("start"),
            "end": edge.get("end"),
        }
        index_tag = emit_wire(absolute(body.id, f"edge{idx}"))
        _evict_ancestry_and_register(global_repo, ancestor_ids, payload, index_tag, geom_hash=geom_hash)


def _register_brep_vertex_ancestry(global_repo, body: Body, vertices: list, vertex_queries: list) -> None:
    """Register B-rep vertex ancestry objects in the global query repository.

    Vertices that are purely new (endpoints of new_edges but not of any
    inherited_edge) are tagged with body.modified_by[-1], mirroring the edge rule.
    Mixed-adjacency vertices (touching both new and inherited edges) fall back
    to body.created_by.
    """
    if global_repo is None or not body.created_by or not vertex_queries:
        return
    new_vertex_hashes = _brep_diff_new_vertex_hashes(body)
    for idx, (pt, query) in enumerate(zip(vertices, vertex_queries)):
        geom_hash = vertex_geometry_hash(pt)
        vertex_created_by = body.created_by
        if new_vertex_hashes and geom_hash in new_vertex_hashes and body.modified_by:
            vertex_created_by = body.modified_by[-1]
        ancestor_ids = [
            emit_wire(absolute(body.id, f"vertex{idx}")),
            emit_wire(absolute(vertex_created_by)),
            emit_wire(absolute(body.id)),
        ]
        if body.profile_queries:
            ancestor_ids.extend(body.profile_queries)
        payload: dict[str, Any] = {
            "type": "vertex",
            "body_id": body.id,
            "created_by": vertex_created_by,
            "vertex_index": idx,
            "origin": pt,
        }
        index_tag = emit_wire(absolute(body.id, f"vertex{idx}"))
        _evict_ancestry_and_register(global_repo, ancestor_ids, payload, index_tag, geom_hash=geom_hash)


def _rewrite_created_by(query_str: str, new_created_by: str) -> str:
    """Rewrite the @created_by tag in an ancestry query string.

    Tessellation queries use a 3-tag format: [@geom_hash, @created_by, @body_id].
    The @created_by tag is always at index 1.
    """
    from oversolved.kernel.query import _parse_ancestry, make_ancestry_query, ref
    ids, type_restriction = _parse_ancestry(query_str)
    if len(ids) >= 2:
        ids[1] = ref(new_created_by)
        return make_ancestry_query(ids, type_restriction)
    return query_str


def _tessellate_body_geometry(body: Body) -> dict[str, Any]:
    """Tessellate a single body without registering ancestry.

    After tessellation, rewrites query strings for boolean-new elements
    (faces, edges, vertices) to use body.modified_by[-1] instead of
    body.created_by, matching the created_by used by _register_brep_*_ancestry.
    """
    entry: dict[str, Any] = {
        "id": body.id,
        "created_by": body.created_by,
        "modified_by": list(body.modified_by),
    }
    if body.shape is None:
        entry["mesh_error"] = "no shape"
        return entry
    try:
        from oversolved.kernel.geometry_tessellation import solid_to_mesh, solid_to_edges, solid_to_vertices
        pq = body.profile_queries if body.profile_queries else None
        fl = body.face_lineage if body.face_lineage else None
        el = body.edge_lineage if body.edge_lineage else None
        mesh = solid_to_mesh(body.shape, created_by=body.created_by, body_id=body.id, profile_queries=pq, face_lineage=fl)
        edges_result = solid_to_edges(body.shape, created_by=body.created_by, body_id=body.id, profile_queries=pq, edge_lineage=el)
        verts_result = solid_to_vertices(body.shape, created_by=body.created_by, body_id=body.id, profile_queries=pq)
    except ImportError:
        entry["mesh_error"] = "geometry.solid_to_mesh not available (F2 pending)"
        return entry
    except Exception as exc:
        entry["mesh_error"] = str(exc)
        return entry

    # Rewrite query strings for boolean-new elements so the @created_by tag
    # matches what _register_brep_*_ancestry registers (body.modified_by[-1]
    # for new elements instead of body.created_by).
    if body.brep_diff is not None and body.modified_by:
        modifier = body.modified_by[-1]
        if modifier != body.created_by:
            new_face_hashes = _brep_diff_new_face_hashes(body)
            if new_face_hashes:
                for i, fd in enumerate(mesh.get("face_data", [])):
                    gh = face_geometry_hash(fd["centroid"], fd["normal"], fd["area"])
                    if gh in new_face_hashes:
                        mesh["face_queries"][i] = _rewrite_created_by(mesh["face_queries"][i], modifier)

            new_edge_hashes = _brep_diff_new_edge_hashes(body)
            if new_edge_hashes:
                for i, edge in enumerate(edges_result.get("edges", [])):
                    gh = edge_geometry_hash(edge)
                    if gh in new_edge_hashes:
                        edges_result["edge_queries"][i] = _rewrite_created_by(
                            edges_result["edge_queries"][i], modifier
                        )

            new_vertex_hashes = _brep_diff_new_vertex_hashes(body)
            if new_vertex_hashes:
                for i, pt in enumerate(verts_result.get("vertices", [])):
                    gh = vertex_geometry_hash(pt)
                    if gh in new_vertex_hashes:
                        verts_result["vertex_queries"][i] = _rewrite_created_by(
                            verts_result["vertex_queries"][i], modifier
                        )

    entry["mesh"] = mesh
    entry["edges"] = edges_result["edges"]
    entry["edge_queries"] = edges_result["edge_queries"]
    entry["vertices"] = verts_result["vertices"]
    entry["vertex_queries"] = verts_result["vertex_queries"]
    return entry


def _tessellate_bodies(
    body_store: dict[str, Body], global_repo=None
) -> dict[str, dict]:
    """Convert all OCC shapes in body_store to mesh dicts."""
    out: dict[str, dict] = {}
    for body_id, body in body_store.items():
        entry = _tessellate_body_geometry(body)
        if global_repo is not None and "mesh" in entry:
            _register_brep_face_ancestry(global_repo, body, entry["mesh"])
            _register_brep_edge_ancestry(
                global_repo, body, entry.get("edges", []), entry.get("edge_queries", []),
            )
            _register_brep_vertex_ancestry(
                global_repo, body, entry.get("vertices", []), entry.get("vertex_queries", []),
            )
            _register_solid_ancestry(global_repo, body)
            _register_extrusion_feature(global_repo, body.created_by or "", body.sketch_id)
        out[body_id] = entry
    return out


def build(
    spec: dict,
    prev_state: BuildState | None = None,
    pick_boundary: int | None = None,
    rollback_position: int | None = None,
) -> dict:
    """Process a full feature-stack document with optional partial rebuild.

    spec: parsed document dict with a top-level 'features' list.
    prev_state: BuildState from the previous call for the same document.
                Pass None to force a full rebuild.
    pick_boundary: If provided, return an additional 'pick_bodies' key containing
                   the tessellated bodies from the checkpoint immediately BEFORE
                   the feature at this index. This is the "BEFORE" state used for
                   picking while a feature is being edited.
    rollback_position: If provided, only solve features before this index.
                      The returned BuildState.feature_order will contain ALL
                      feature IDs (full list) so that subsequent calls with
                      different rollback positions can do proper dirty checking.
    """
    all_features: list[dict] = spec.get("features", [])
    if rollback_position is not None:
        features = all_features[:rollback_position]
    else:
        features = all_features
    first_dirty = _find_first_dirty(features, prev_state)

    global_repo = _init_global_repo()
    body_store: dict[str, Body] = {}
    result: dict[str, Any] = {}
    new_checkpoints: dict[str, FeatureCheckpoint] = {}

    # When rebuilding from scratch (first_dirty=0) with a prev_state, preserve
    # the previous topology in the fresh repo so _post_register can apply
    # area re-ID (match_area_reid) for downstream features that reference old
    # surface queries. Without this, the new solve loses the old topology and
    # area re-ID never fires, breaking unrelated extrudes after entity deletion.
    if prev_state and first_dirty == 0:
        for feature in features:
            fid = feature.get("id", "")
            prev_cp = prev_state.checkpoints.get(fid)
            if prev_cp is None:
                continue
            topo_key = "_topo_" + fid
            prev_topo = prev_cp.repo_snapshot.get("elements", {}).get(topo_key)
            if prev_topo is not None:
                global_repo.elements[topo_key] = prev_topo

    t0 = time.perf_counter()

    if prev_state and first_dirty > 0:
        last_clean_fid = features[first_dirty - 1].get("id", "")
        checkpoint = prev_state.checkpoints[last_clean_fid]
        global_repo = _repo_from_snapshot(checkpoint.repo_snapshot)
        body_store = {
            bid: Body(
                id=body.id,
                created_by=body.created_by,
                modified_by=list(body.modified_by),
                shape=_copy_shape(body.shape),
                sketch_id=body.sketch_id,
                brep_diff=body.brep_diff,
                profile_queries=list(body.profile_queries),
            )
            for bid, body in checkpoint.body_store_snapshot.items()
        }
        for fid in prev_state.feature_order[:first_dirty]:
            result[fid] = prev_state.checkpoints[fid].result
            new_checkpoints[fid] = prev_state.checkpoints[fid]

    registered_body_ids: set[str] = set(body_store.keys())

    def _register_body_faces(body: Body) -> None:
        """Register face/vertex ancestry for a body."""
        if body.shape is None:
            return
        try:
            from oversolved.kernel.geometry_tessellation import solid_to_mesh, solid_to_edges, solid_to_vertices
            mesh = solid_to_mesh(body.shape, created_by=body.created_by, body_id=body.id)
            _register_brep_face_ancestry(global_repo, body, mesh)
            verts = solid_to_vertices(body.shape, created_by=body.created_by, body_id=body.id)
            _register_brep_vertex_ancestry(global_repo, body, verts["vertices"], verts["vertex_queries"])
            edges = solid_to_edges(body.shape, created_by=body.created_by, body_id=body.id)
            _register_brep_edge_ancestry(global_repo, body, edges["edges"], edges["edge_queries"])
        except Exception as exc:
            logger.warning("Failed to register B-rep ancestry for body %s: %s", body.id, exc)

    # Use full feature list for lookups (solver may need features past rollback)
    features_by_id = {f.get("id", ""): f for f in all_features}
    for feature in features[first_dirty:]:
        fid = feature.get("id", "")

        if feature.get("suppressed"):
            # No geometry, no body mutation, no post_register for suppressed features.
            # Store a sentinel so dirty detection can still compare specs correctly.
            new_checkpoints[fid] = FeatureCheckpoint(
                spec=copy.deepcopy(feature),
                result={"status": "suppressed"},
                repo_snapshot={
                    "elements": dict(global_repo.elements),
                    "ancestral": {k: list(v) for k, v in global_repo.ancestral.items()},
                    "by_geom_hash": {k: list(v) for k, v in global_repo.by_geom_hash.items()},
                },
                body_store_snapshot={
                    bid: Body(
                        id=body.id,
                        created_by=body.created_by,
                        modified_by=list(body.modified_by),
                        shape=_copy_shape(body.shape),
                        sketch_id=body.sketch_id,
                        brep_diff=body.brep_diff,
                        profile_queries=list(body.profile_queries),
                    )
                    for bid, body in body_store.items()
                },
            )
            result[fid] = {"status": "suppressed"}
            continue

        # Snapshot modified_by lengths so we can detect which bodies this feature changes.
        modified_by_len_before = {bid: len(body.modified_by) for bid, body in body_store.items()}

        feature_result = _try_solve_feature(feature, global_repo, body_store, features_by_id)
        _post_register(global_repo, fid, feature, feature_result)
        result[fid] = feature_result

        # Register new bodies and re-register bodies modified by this feature.
        # Modified bodies must be re-registered so downstream features see updated face ancestry.
        for body_id, body in body_store.items():
            if body_id not in registered_body_ids and body.shape is not None:
                _register_body_faces(body)
                _register_solid_ancestry(global_repo, body)
                _register_extrusion_feature(global_repo, body.created_by or "", body.sketch_id)
                registered_body_ids.add(body_id)
            elif (body.shape is not None
                  and len(body.modified_by) > modified_by_len_before.get(body_id, 0)):
                _register_body_faces(body)

        new_checkpoints[fid] = FeatureCheckpoint(
            spec=copy.deepcopy(feature),
            result=dict(feature_result),
            repo_snapshot={
                "elements": dict(global_repo.elements),
                "ancestral": {k: list(v) for k, v in global_repo.ancestral.items()},
                "by_geom_hash": {k: list(v) for k, v in global_repo.by_geom_hash.items()},
            },
            body_store_snapshot={
                bid: Body(
                    id=body.id,
                    created_by=body.created_by,
                    modified_by=list(body.modified_by),
                    shape=_copy_shape(body.shape),
                    sketch_id=body.sketch_id,
                    brep_diff=body.brep_diff,
                    profile_queries=list(body.profile_queries),
                )
                for bid, body in body_store.items()
            },
        )

    active_fids = {f.get("id", "") for f in all_features}
    global_repo.gc(active_fids)

    bodies_out = _tessellate_bodies(body_store, global_repo)

    # Build a cache of tessellations keyed by OCC shape hash so that each unique
    # OCC shape is tessellated at most once across all checkpoints.
    # hash(shape) uses the underlying TShape pointer (not the Python wrapper address),
    # so it remains stable across Python wrapper GC/reallocation at the same address.
    _shape_tess_cache: dict[int, dict] = {}
    for body_id, body in body_store.items():
        if body.shape is not None and body_id in bodies_out:
            _shape_tess_cache[hash(body.shape)] = bodies_out[body_id]

    for checkpoint in new_checkpoints.values():
        for body_id, body in checkpoint.body_store_snapshot.items():
            if body.shape is not None and hash(body.shape) not in _shape_tess_cache:
                # Body was replaced by a later operation; tessellate its original shape.
                _shape_tess_cache[hash(body.shape)] = _tessellate_body_geometry(body)

    def _checkpoint_bodies_out(checkpoint: FeatureCheckpoint) -> dict[str, dict]:
        return {
            body_id: _shape_tess_cache.get(hash(body.shape), {})
            for body_id, body in checkpoint.body_store_snapshot.items()
        }

    new_checkpoints = {
        fid: FeatureCheckpoint(
            spec=checkpoint.spec,
            result=checkpoint.result,
            repo_snapshot=_snapshot_with_brep_geometry(checkpoint, _checkpoint_bodies_out(checkpoint)),
            body_store_snapshot=copy.copy(checkpoint.body_store_snapshot),
        )
        for fid, checkpoint in new_checkpoints.items()
    }
    build_ms = round((time.perf_counter() - t0) * 1000, 1)
    result.update(_BUILTIN_PLANE_RESULTS)

    new_state = BuildState(
        feature_order=[f.get("id", "") for f in all_features],
        checkpoints=new_checkpoints,
    )

    body_shapes: dict[str, TopoDS_Shape] = {
        bid: body.shape for bid, body in body_store.items() if body.shape is not None
    }

    pick_bodies_out: dict[str, dict] | None = None
    if pick_boundary is not None and pick_boundary > 0 and pick_boundary <= len(features):
        target_fid = features[pick_boundary - 1].get("id", "")
        pick_checkpoint: FeatureCheckpoint | None = new_checkpoints.get(target_fid)
        if pick_checkpoint is None and prev_state is not None:
            pick_checkpoint = prev_state.checkpoints.get(target_fid)
        if pick_checkpoint is not None:
            pick_bodies_out = _tessellate_bodies(pick_checkpoint.body_store_snapshot, None)

    response = {
        "solve_ms": build_ms,
        "result": result,
        "bodies": bodies_out,
        "_build_state": new_state,
        "_body_shapes": body_shapes,
        **({"pick_bodies": pick_bodies_out} if pick_bodies_out is not None else {}),
    }

    # Opt-in three-layer comparison vs. a fresh full rebuild. Used by the
    # frontend Rebuild button to detect silent desyncs (stale checkpoints,
    # ancestry drift after reorder). Doubles solve time so it stays opt-in.
    # TODO: flip default-on once perf cost is measured in production.
    if spec.get("_validate"):
        response["_validation"] = _validate_incremental(new_state, result, spec)

    return response
