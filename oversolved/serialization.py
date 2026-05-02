"""Serialization helpers for BuildState to/from JSON with STEP binaries."""

import base64
import copy
import os
import tempfile
from typing import Any

from oversolved.types3d import Body, BuildState, FeatureCheckpoint


def _serialize_repo_snapshot(repo_snapshot: dict) -> dict:
    """Convert repo snapshot with frozenset keys to JSON-serializable dict."""
    result: dict[str, Any] = {
        "elements": copy.deepcopy(repo_snapshot.get("elements", {}))
    }
    ancestral = repo_snapshot.get("ancestral", {})
    result["ancestral"] = [
        {"keys": sorted(list(k)), "values": v}
        for k, v in ancestral.items()
    ]
    return result


def _deserialize_repo_snapshot(data: dict) -> dict:
    """Convert JSON repo snapshot back to dict with frozenset keys."""
    if "elements" not in data:
        return copy.deepcopy(data)
    result: dict[str, Any] = {
        "elements": copy.deepcopy(data.get("elements", {}))
    }
    ancestral_data = data.get("ancestral", {})
    if isinstance(ancestral_data, list):
        result["ancestral"] = {
            frozenset(item["keys"]): item["values"]
            for item in ancestral_data
        }
    else:
        result["ancestral"] = copy.deepcopy(ancestral_data)
    return result


def shape_to_step_base64(shape: Any) -> str:
    """Export an OCC shape to a base64-encoded STEP string."""
    from oversolved.geometry import shape_to_step_file_buffer
    buffer = shape_to_step_file_buffer(shape)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def step_base64_to_shape(encoded: str) -> Any:
    """Import an OCC shape from a base64-encoded STEP string."""
    from oversolved.geometry import step_file_to_shape
    data = base64.b64decode(encoded)
    with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        return step_file_to_shape(tmp_path)
    finally:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)


def serialize_build_state(state: BuildState) -> dict:
    """Serialize a BuildState to a JSON-serializable dict."""
    checkpoints: dict[str, Any] = {}
    for fid, checkpoint in state.checkpoints.items():
        body_store: dict[str, Any] = {}
        for bid, body in checkpoint.body_store_snapshot.items():
            body_dict: dict[str, Any] = {
                "id": body.id,
                "created_by": body.created_by,
                "modified_by": list(body.modified_by),
                "sketch_id": body.sketch_id,
            }
            if body.shape is not None:
                body_dict["shape_step"] = shape_to_step_base64(body.shape)
            body_store[bid] = body_dict

        checkpoints[fid] = {
            "spec": copy.deepcopy(checkpoint.spec),
            "result": copy.deepcopy(checkpoint.result),
            "repo_snapshot": _serialize_repo_snapshot(checkpoint.repo_snapshot),
            "body_store": body_store,
        }

    return {
        "feature_order": list(state.feature_order),
        "checkpoints": checkpoints,
    }


def deserialize_build_state(data: dict) -> BuildState | None:
    """Deserialize a JSON dict to a BuildState.

    Returns None if deserialization fails (e.g., corrupted STEP data).
    """
    try:
        feature_order = list(data.get("feature_order", []))
        checkpoints: dict[str, FeatureCheckpoint] = {}

        for fid, cp_data in data.get("checkpoints", {}).items():
            body_store: dict[str, Body] = {}
            for bid, body_dict in cp_data.get("body_store", {}).items():
                shape = None
                shape_step = body_dict.get("shape_step")
                if shape_step:
                    try:
                        shape = step_base64_to_shape(shape_step)
                    except Exception:
                        return None
                body_store[bid] = Body(
                    id=body_dict["id"],
                    created_by=body_dict.get("created_by", ""),
                    modified_by=list(body_dict.get("modified_by", [])),
                    shape=shape,
                    sketch_id=body_dict.get("sketch_id", ""),
                )

            checkpoints[fid] = FeatureCheckpoint(
                spec=copy.deepcopy(cp_data.get("spec", {})),
                result=copy.deepcopy(cp_data.get("result", {})),
                repo_snapshot=_deserialize_repo_snapshot(
                    cp_data.get("repo_snapshot", {})
                ),
                body_store_snapshot=body_store,
            )

        return BuildState(feature_order=feature_order, checkpoints=checkpoints)
    except Exception:
        return None
