from __future__ import annotations

import copy
import json
import logging
import time
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
from oversolved.kernel.cadquery_ops import _normal_to_frame, _ensure_occ
from oversolved.kernel.ocp_ops import ocp_copy_shape
from oversolved.kernel.geom_hash import face_geometry_hash, edge_geometry_hash, vertex_geometry_hash
from oversolved.kernel.query import Repository, emit_wire, absolute
from oversolved.kernel.geometry import MeshDict
from oversolved.kernel.types3d import Body, FeatureCheckpoint, BuildState
from oversolved.kernel.solver import _init_global_repo, _try_solve_feature
from oversolved.kernel.solver_constants import _BUILTIN_PLANE_RESULTS
from oversolved.kernel.solver_registry import _post_register

try:
    import oversolved.kernel.geometry  # noqa: F401  # pre-warm to avoid concurrent-import race
except ImportError:
    pass

logger = logging.getLogger(__name__)

__all__ = [
    "build",
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
        logger.warning("Failed to copy OCP shape: %s, returning original", exc)
        return shape


# Canonical keys that define a feature's identity for dirty detection.
# Add new keys here when new feature kinds are introduced.
# Transient/UI-only keys sent by the frontend are ignored during comparison.
_FEATURE_CMP_KEYS = frozenset({
    "id", "kind", "plane", "entities", "constraints", "initial",
    "extrude", "revolve", "fillet", "chamfer", "boolean", "hole",
    "transform", "array", "hide", "label",
    "sketch", "distance", "direction", "operation", "angle",
    "radius", "edges", "file_id", "scale",
    "definition",
    "delete_body",
    "mirror",
})


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


def _register_brep_face_ancestry(global_repo, body: Body, mesh: MeshDict) -> None:
    """Register B-rep face ancestry objects in the global query repository."""
    if global_repo is None or body.shape is None or not body.created_by:
        return

    face_data = mesh.get("face_data") or []
    for face_idx, face_info in enumerate(face_data):
        centroid = face_info.get("centroid", [0.0, 0.0, 0.0])
        normal = face_info.get("normal", [0.0, 0.0, 1.0])
        area = face_info.get("area", 0.0)
        geom_hash = face_geometry_hash(centroid, normal, area)
        ancestor_ids = [
            emit_wire(absolute(body.id, f"face{face_idx}")),
            emit_wire(absolute(body.created_by)),
            emit_wire(absolute(body.id)),
            emit_wire(absolute(geom_hash)),
        ]
        x_axis, y_axis = _normal_to_frame(normal)
        payload = {
            "type": face_info.get("surface_type", "face"),
            "body_id": body.id,
            "created_by": body.created_by,
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
        # Remove stale registrations with the same face index tag but different hash.
        index_tag = emit_wire(absolute(body.id, f"face{face_idx}"))
        stale_keys = [k for k in global_repo.ancestral if index_tag in k and k != key]
        for stale_key in stale_keys:
            for eid in global_repo.ancestral.pop(stale_key, []):
                global_repo.elements.pop(eid, None)
        # Remove stale entries with the exact same key (hash unchanged, payload changed).
        for eid in existing_ids:
            global_repo.elements.pop(eid, None)
        global_repo.ancestral.pop(key, None)
        global_repo.register_ancestor(ancestor_ids, payload)


def _register_solid_ancestry(global_repo, body: Body) -> None:
    """Register the solid body itself as a queryable solid entity."""
    if global_repo is None or not body.created_by:
        return
    global_repo.register_ancestor(
        [f"@{body.created_by}"],
        {"type": "solid", "body_id": body.id, "created_by": body.created_by},
    )


def _register_extrusion_feature(global_repo, feature_id: str, sketch_id: str = "") -> None:
    """Register an extrusion feature as a queryable extrusion-feature entity."""
    if global_repo is None or not feature_id:
        return
    global_repo.register_ancestor(
        [f"@{feature_id}"],
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
    else:
        # Backward compatibility for older snapshots that only stored elements.
        repo.elements = copy.deepcopy(repo_snapshot)
        repo.ancestral = {}
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
        "elements": repo.elements,
        "ancestral": repo.ancestral,
    }


def _register_brep_edge_ancestry(global_repo, body: Body, edges: list, edge_queries: list) -> None:
    """Register B-rep edge ancestry objects in the global query repository."""
    if global_repo is None or not body.created_by or not edge_queries:
        return
    for idx, (edge, query) in enumerate(zip(edges, edge_queries)):
        geom_hash = edge_geometry_hash(edge)
        ancestor_ids = [
            emit_wire(absolute(body.id, f"edge{idx}")),
            emit_wire(absolute(body.created_by)),
            emit_wire(absolute(body.id)),
            emit_wire(absolute(geom_hash)),
        ]
        edge_type = "straightedge" if edge.get("kind") == "line" else "edge"
        payload: dict[str, Any] = {
            "type": edge_type,
            "body_id": body.id,
            "created_by": body.created_by,
            "edge_index": idx,
            "kind": edge.get("kind"),
            "start": edge.get("start"),
            "end": edge.get("end"),
        }
        key = frozenset(ancestor_ids)
        # Remove stale registrations with the same edge index tag but different hash.
        index_tag = emit_wire(absolute(body.id, f"edge{idx}"))
        stale_keys = [k for k in global_repo.ancestral if index_tag in k and k != key]
        for stale_key in stale_keys:
            for eid in global_repo.ancestral.pop(stale_key, []):
                global_repo.elements.pop(eid, None)
        for old_id in global_repo.ancestral.pop(key, []):
            global_repo.elements.pop(old_id, None)
        global_repo.register_ancestor(ancestor_ids, payload)


def _register_brep_vertex_ancestry(global_repo, body: Body, vertices: list, vertex_queries: list) -> None:
    """Register B-rep vertex ancestry objects in the global query repository."""
    if global_repo is None or not body.created_by or not vertex_queries:
        return
    for idx, (pt, query) in enumerate(zip(vertices, vertex_queries)):
        geom_hash = vertex_geometry_hash(pt)
        ancestor_ids = [
            emit_wire(absolute(body.id, f"vertex{idx}")),
            emit_wire(absolute(body.created_by)),
            emit_wire(absolute(body.id)),
            emit_wire(absolute(geom_hash)),
        ]
        payload: dict[str, Any] = {
            "type": "vertex",
            "body_id": body.id,
            "created_by": body.created_by,
            "vertex_index": idx,
            "origin": pt,
        }
        key = frozenset(ancestor_ids)
        # Remove stale registrations with the same vertex index tag but different hash.
        index_tag = emit_wire(absolute(body.id, f"vertex{idx}"))
        stale_keys = [k for k in global_repo.ancestral if index_tag in k and k != key]
        for stale_key in stale_keys:
            for eid in global_repo.ancestral.pop(stale_key, []):
                global_repo.elements.pop(eid, None)
        for old_id in global_repo.ancestral.pop(key, []):
            global_repo.elements.pop(old_id, None)
        global_repo.register_ancestor(ancestor_ids, payload)


def _tessellate_body_geometry(body: Body) -> dict[str, Any]:
    """Tessellate a single body without registering ancestry."""
    entry: dict[str, Any] = {
        "id": body.id,
        "created_by": body.created_by,
        "modified_by": list(body.modified_by),
    }
    if body.shape is None:
        entry["mesh_error"] = "no shape"
        return entry
    try:
        from oversolved.kernel.geometry import solid_to_mesh, solid_to_edges, solid_to_vertices  # type: ignore[attr-defined]
        entry["mesh"] = solid_to_mesh(body.shape, created_by=body.created_by, body_id=body.id)
        edges_result = solid_to_edges(body.shape, created_by=body.created_by, body_id=body.id)
        entry["edges"] = edges_result["edges"]
        entry["edge_queries"] = edges_result["edge_queries"]
        verts_result = solid_to_vertices(body.shape, created_by=body.created_by, body_id=body.id)
        entry["vertices"] = verts_result["vertices"]
        entry["vertex_queries"] = verts_result["vertex_queries"]
    except ImportError:
        entry["mesh_error"] = "geometry.solid_to_mesh not available (F2 pending)"
    except Exception as exc:
        entry["mesh_error"] = str(exc)
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
            _register_brep_edge_ancestry(global_repo, body, entry.get("edges", []), entry.get("edge_queries", []))
            _register_brep_vertex_ancestry(global_repo, body, entry.get("vertices", []), entry.get("vertex_queries", []))
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
            from oversolved.kernel.geometry import solid_to_mesh, solid_to_edges, solid_to_vertices
            mesh = solid_to_mesh(body.shape, created_by=body.created_by)
            _register_brep_face_ancestry(global_repo, body, mesh)
            verts = solid_to_vertices(body.shape, created_by=body.created_by)
            _register_brep_vertex_ancestry(global_repo, body, verts["vertices"], verts["vertex_queries"])
            edges = solid_to_edges(body.shape, created_by=body.created_by)
            _register_brep_edge_ancestry(global_repo, body, edges["edges"], edges["edge_queries"])
        except Exception as exc:
            logger.warning("Failed to register B-rep ancestry for body %s: %s", body.id, exc)

    # Use full feature list for lookups (solver may need features past rollback)
    features_by_id = {f["id"]: f for f in all_features}
    for i, feature in enumerate(features[first_dirty:]):
        fid = feature.get("id", "")

        # BEFORE solving non-first features, re-register bodies that may have changed.
        # Reset registered_this_cycle per iteration so that every dirty feature
        # sees the current shape, not the shape from a prior iteration.
        if i > 0:
            registered_this_cycle: set[str] = set()
            for body in body_store.values():
                if body.shape and body.created_by and body.id not in registered_this_cycle:
                    _register_body_faces(body)
                    registered_this_cycle.add(body.id)

        feature_result = _try_solve_feature(feature, global_repo, body_store, features_by_id)
        _post_register(global_repo, fid, feature, feature_result)
        result[fid] = feature_result

        # Register new bodies created by this feature.
        for body_id, body in body_store.items():
            if body_id not in registered_body_ids and body.shape is not None:
                _register_body_faces(body)
                _register_solid_ancestry(global_repo, body)
                _register_extrusion_feature(global_repo, body.created_by or "", body.sketch_id)
                registered_body_ids.add(body_id)

        new_checkpoints[fid] = FeatureCheckpoint(
            spec=copy.deepcopy(feature),
            result=dict(feature_result),
            repo_snapshot={"elements": dict(global_repo.elements), "ancestral": {k: list(v) for k, v in global_repo.ancestral.items()}},
            body_store_snapshot={
                bid: Body(
                    id=body.id,
                    created_by=body.created_by,
                    modified_by=list(body.modified_by),
                    shape=_copy_shape(body.shape),
                    sketch_id=body.sketch_id,
                )
                for bid, body in body_store.items()
            },
        )

    bodies_out = _tessellate_bodies(body_store, global_repo)

    # Build a cache of tessellations keyed by shape object identity so that
    # each unique OCC shape is tessellated at most once across all checkpoints.
    # Using id(shape) is safe here because all Body objects are kept alive by
    # body_store and the checkpoint body_store_snapshots for the duration of
    # this function.
    _shape_tess_cache: dict[int, dict] = {}
    for body_id, body in body_store.items():
        if body.shape is not None and body_id in bodies_out:
            _shape_tess_cache[id(body.shape)] = bodies_out[body_id]

    for checkpoint in new_checkpoints.values():
        for body_id, body in checkpoint.body_store_snapshot.items():
            if body.shape is not None and id(body.shape) not in _shape_tess_cache:
                # Body was replaced by a later operation; tessellate its original shape.
                _shape_tess_cache[id(body.shape)] = _tessellate_body_geometry(body)

    def _checkpoint_bodies_out(checkpoint: FeatureCheckpoint) -> dict[str, dict]:
        return {
            body_id: _shape_tess_cache.get(id(body.shape), {})
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

    body_shapes: dict[str, TopoDS_Shape] = {bid: body.shape for bid, body in body_store.items() if body.shape is not None}

    pick_bodies_out: dict[str, dict] | None = None
    if pick_boundary is not None and pick_boundary > 0 and pick_boundary <= len(features):
        target_fid = features[pick_boundary - 1].get("id", "")
        pick_checkpoint: FeatureCheckpoint | None = new_checkpoints.get(target_fid)
        if pick_checkpoint is None and prev_state is not None:
            pick_checkpoint = prev_state.checkpoints.get(target_fid)
        if pick_checkpoint is not None:
            pick_bodies_out = _tessellate_bodies(pick_checkpoint.body_store_snapshot, None)

    return {
        "solve_ms": build_ms,
        "result": result,
        "bodies": bodies_out,
        "_build_state": new_state,
        "_body_shapes": body_shapes,
        **({"pick_bodies": pick_bodies_out} if pick_bodies_out is not None else {}),
    }
