import copy
import time
from typing import Any
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


def _tessellate_bodies(body_store: dict[str, Body]) -> dict[str, dict]:
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
                from oversolved.geometry import solid_to_mesh  # type: ignore[attr-defined]
                entry["mesh"] = solid_to_mesh(body.shape)
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
        global_repo.elements = copy.deepcopy(checkpoint.repo_snapshot)
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
            repo_snapshot=copy.deepcopy(global_repo.elements),
            body_store_snapshot=copy.copy(body_store),
        )

    bodies_out = _tessellate_bodies(body_store)
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
