import copy
import time
from typing import Any
from oversolved.query import Repository
from oversolved.types3d import Body, FeatureCheckpoint, BuildState
from oversolved.solver import _init_global_repo, _try_solve_feature, _post_register


_BUILTIN_PLANE_RESULTS: dict[str, dict] = {
    "builtin_plane_front": {
        "status": "ok",
        "plane": {"origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0], "normal": [0, 0, 1]},
    },
    "builtin_plane_top": {
        "status": "ok",
        "plane": {"origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 0, -1], "normal": [0, 1, 0]},
    },
    "builtin_plane_right": {
        "status": "ok",
        "plane": {"origin": [0, 0, 0], "x_axis": [0, 0, -1], "y_axis": [0, 1, 0], "normal": [1, 0, 0]},
    },
}


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
        if prev_checkpoint is None or prev_checkpoint.spec != feature:
            return i
    return len(features)


def _register_brep_face_ancestry(global_repo, body: Body, mesh: dict) -> None:
    """Register B-rep face ancestry objects in the global query repository."""
    if global_repo is None or body.shape is None or not body.created_by:
        return

    face_data = mesh.get("face_data") or []
    for face_idx, face_info in enumerate(face_data):
        ancestor_ids = [f"@{body.created_by}face{face_idx}"]
        payload = {
            "type": "face",
            "body_id": body.id,
            "created_by": body.created_by,
            "face_index": face_idx,
            "centroid": face_info.get("centroid", [0.0, 0.0, 0.0]),
            "normal": face_info.get("normal", [0.0, 0.0, 1.0]),
        }
        key = frozenset(ancestor_ids)
        existing_ids = global_repo.anchestral.get(key, [])
        for element_id in existing_ids:
            if global_repo.elements.get(element_id) == payload:
                break
        else:
            global_repo.register_anchestor(ancestor_ids, payload)


def _dedupe_repo(repo: Repository) -> None:
    """Drop duplicate identical ancestry registrations from a repo snapshot."""
    for key, element_ids in list(repo.anchestral.items()):
        unique_ids: list[str] = []
        unique_payloads: list[dict[str, Any]] = []
        for element_id in element_ids:
            payload = repo.elements.get(element_id)
            if payload is None:
                continue
            if any(existing_payload == payload for existing_payload in unique_payloads):
                repo.elements.pop(element_id, None)
                continue
            unique_ids.append(element_id)
            unique_payloads.append(payload)
        if unique_ids:
            repo.anchestral[key] = unique_ids
        else:
            repo.anchestral.pop(key, None)


def _repo_from_snapshot(repo_snapshot: dict) -> Repository:
    """Rehydrate a repository snapshot, including ancestry index state."""
    repo = Repository()
    if "elements" in repo_snapshot or "anchestral" in repo_snapshot:
        repo.elements = copy.deepcopy(repo_snapshot.get("elements", {}))
        repo.anchestral = copy.deepcopy(repo_snapshot.get("anchestral", {}))
    else:
        # Backward compatibility for older snapshots that only stored elements.
        repo.elements = copy.deepcopy(repo_snapshot)
        repo.anchestral = {}
    _dedupe_repo(repo)
    return repo


def _snapshot_repo(repo: Repository) -> dict[str, Any]:
    """Serialize the repository state needed for partial rebuild restoration."""
    return {
        "elements": copy.deepcopy(repo.elements),
        "anchestral": copy.deepcopy(repo.anchestral),
    }


def _snapshot_with_brep_faces(
    checkpoint: FeatureCheckpoint,
    bodies_out: dict[str, dict],
) -> dict[str, Any]:
    """Return a repo snapshot augmented with B-rep face ancestry for this checkpoint."""
    repo = _repo_from_snapshot(checkpoint.repo_snapshot)

    for body_id, body in checkpoint.body_store_snapshot.items():
        body_out = bodies_out.get(body_id) or {}
        mesh = body_out.get("mesh")
        if mesh is not None:
            _register_brep_face_ancestry(repo, body, mesh)

    return _snapshot_repo(repo)


def _register_brep_edge_ancestry(global_repo, body: Body, edges: list, edge_queries: list) -> None:
    """Register B-rep edge ancestry objects in the global query repository."""
    if global_repo is None or not body.created_by or not edge_queries:
        return
    for idx, (edge, query) in enumerate(zip(edges, edge_queries)):
        ancestor_ids = [f"@{body.created_by}edge{idx}"]
        payload: dict[str, Any] = {
            "type": "edge",
            "body_id": body.id,
            "created_by": body.created_by,
            "edge_index": idx,
            "kind": edge.get("kind"),
            "start": edge.get("start"),
            "end": edge.get("end"),
        }
        global_repo.register_anchestor(ancestor_ids, payload)


def _register_brep_vertex_ancestry(global_repo, body: Body, vertices: list, vertex_queries: list) -> None:
    """Register B-rep vertex ancestry objects in the global query repository."""
    if global_repo is None or not body.created_by or not vertex_queries:
        return
    for idx, (pt, query) in enumerate(zip(vertices, vertex_queries)):
        ancestor_ids = [f"@{body.created_by}vertex{idx}"]
        payload: dict[str, Any] = {
            "type": "vertex",
            "body_id": body.id,
            "created_by": body.created_by,
            "vertex_index": idx,
            "origin": pt,
        }
        global_repo.register_anchestor(ancestor_ids, payload)


def _tessellate_bodies(
    body_store: dict[str, Body], global_repo=None
) -> dict[str, dict]:
    """Convert all OCC shapes in body_store to mesh dicts."""
    out: dict[str, dict] = {}
    for body_id, body in body_store.items():
        entry: dict[str, Any] = {
            "id": body.id,
            "created_by": body.created_by,
            "modified_by": list(body.modified_by),
        }
        if body.shape is None:
            entry["mesh_error"] = "no shape"
        else:
            try:
                from oversolved.geometry import solid_to_mesh, solid_to_edges, solid_to_vertices  # type: ignore[attr-defined]
                entry["mesh"] = solid_to_mesh(body.shape, created_by=body.created_by)
                edges_result = solid_to_edges(body.shape, created_by=body.created_by)
                entry["edges"] = edges_result["edges"]
                entry["edge_queries"] = edges_result["edge_queries"]
                verts_result = solid_to_vertices(body.shape, created_by=body.created_by)
                entry["vertices"] = verts_result["vertices"]
                entry["vertex_queries"] = verts_result["vertex_queries"]
                _register_brep_face_ancestry(global_repo, body, entry["mesh"])
                _register_brep_edge_ancestry(global_repo, body, entry["edges"], entry["edge_queries"])
                _register_brep_vertex_ancestry(global_repo, body, entry["vertices"], entry["vertex_queries"])
            except ImportError:
                entry["mesh_error"] = "geometry.solid_to_mesh not available (F2 pending)"
            except Exception as exc:
                entry["mesh_error"] = str(exc)
        out[body_id] = entry
    return out


def build(spec: dict, prev_state: BuildState | None = None) -> dict:
    """Process a full feature-stack document with optional partial rebuild.

    spec: parsed document dict with a top-level 'features' list.
    prev_state: BuildState from the previous call for the same document.
                Pass None to force a full rebuild.
    """
    features: list[dict] = spec.get("features", [])
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
        body_store = copy.copy(checkpoint.body_store_snapshot)
        for fid in prev_state.feature_order[:first_dirty]:
            result[fid] = prev_state.checkpoints[fid].result
            new_checkpoints[fid] = prev_state.checkpoints[fid]

    for feature in features[first_dirty:]:
        fid = feature.get("id", "")
        feature_result = _try_solve_feature(feature, global_repo, body_store)
        _post_register(global_repo, fid, feature, feature_result)
        result[fid] = feature_result
        new_checkpoints[fid] = FeatureCheckpoint(
            spec=copy.deepcopy(feature),
            result=feature_result,
            repo_snapshot=_snapshot_repo(global_repo),
            body_store_snapshot=copy.copy(body_store),
        )

    bodies_out = _tessellate_bodies(body_store, global_repo)
    new_checkpoints = {
        fid: FeatureCheckpoint(
            spec=checkpoint.spec,
            result=checkpoint.result,
            repo_snapshot=_snapshot_with_brep_faces(checkpoint, bodies_out),
            body_store_snapshot=copy.copy(checkpoint.body_store_snapshot),
        )
        for fid, checkpoint in new_checkpoints.items()
    }
    build_ms = round((time.perf_counter() - t0) * 1000, 1)
    result.update(_BUILTIN_PLANE_RESULTS)

    new_state = BuildState(
        feature_order=[f.get("id", "") for f in features],
        checkpoints=new_checkpoints,
    )

    return {
        "solve_ms": build_ms,
        "result": result,
        "bodies": bodies_out,
        "_build_state": new_state,
    }
