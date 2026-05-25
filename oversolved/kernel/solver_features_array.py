from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.gp import gp_Trsf
from oversolved.kernel.query import Repository
from oversolved.kernel.cadquery_ops import _ensure_cq, _ensure_occ, boolean_union_with_diff, fuse_shapes
from oversolved.kernel.types3d import Body
from oversolved.kernel.geometry_features import make_translation_trsf, transform_copy
from oversolved.kernel.solver_features_shared import (
    _resolve_body,
    _resolve_direction_query,
)

logger = logging.getLogger(__name__)

__all__ = [
    "_build_array_transforms",
    "_solve_array",
    "ALL_KEYS",
]

ALL_KEYS: frozenset[str] = frozenset({
    "array", "source_body", "mode", "operation",
    "count_x", "count_y",
    "pitch_x", "pitch_y",
    "direction_x", "direction_x_query", "direction_y", "direction_y_query",
    "include_source",
})


def _build_array_transforms(
    feature: dict,
    global_repo: Repository,
) -> list[gp_Trsf]:
    mode = feature.get("mode", "linear")
    trsfs: list[gp_Trsf] = []

    if mode == "linear":
        count_x = int(feature.get("count_x", 2))
        pitch_x = float(feature.get("pitch_x", 10.0))
        dir_x = _resolve_direction_query(
            feature.get("direction_x_query", ""),
            global_repo,
            feature.get("direction_x", [1, 0, 0]),
        )
        for i in range(count_x):
            trsf = make_translation_trsf(dir_x[0] * pitch_x * i, dir_x[1] * pitch_x * i, dir_x[2] * pitch_x * i)
            trsfs.append(trsf)

    elif mode == "rectangular":
        count_x = int(feature.get("count_x", 2))
        count_y = int(feature.get("count_y", 2))
        pitch_x = float(feature.get("pitch_x", 10.0))
        pitch_y = float(feature.get("pitch_y", 10.0))
        dir_x = _resolve_direction_query(
            feature.get("direction_x_query", ""),
            global_repo,
            feature.get("direction_x", [1, 0, 0]),
        )
        dir_y = _resolve_direction_query(
            feature.get("direction_y_query", ""),
            global_repo,
            feature.get("direction_y", [0, 1, 0]),
        )
        for j in range(count_y):
            for i in range(count_x):
                trsf = make_translation_trsf(
                    dir_x[0] * pitch_x * i + dir_y[0] * pitch_y * j,
                    dir_x[1] * pitch_x * i + dir_y[1] * pitch_y * j,
                    dir_x[2] * pitch_x * i + dir_y[2] * pitch_y * j,
                )
                trsfs.append(trsf)

    return trsfs


def _solve_array(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    feature_id = feature.get("id", "")
    sub = feature.get("array") or {}
    feature = {**sub, **feature}

    source_body_ref = feature.get("source_body", "")
    if source_body_ref:
        try:
            body = _resolve_body(source_body_ref, body_store)
        except ValueError:
            available = list(body_store.keys())
            raise ValueError(
                f"array: source body '{source_body_ref}' not found; "
                f"available body IDs: {available}"
            )
    else:
        _body_or_none = next(iter(body_store.values())) if body_store else None
        if _body_or_none is None:
            raise ValueError("array: no source body with shape found")
        body = _body_or_none
    source_body_id = body.id
    if body.shape is None:
        raise ValueError("array: source body has no shape")

    include_source = bool(feature.get("include_source", True))
    operation = feature.get("operation", "add")

    trsfs = _build_array_transforms(feature, global_repo)

    instances: list = []
    for i, trsf in enumerate(trsfs):
        if i == 0 and include_source:
            instances.append(body.shape)
        else:
            instances.append(transform_copy(body.shape, trsf))

    if not instances:
        raise ValueError("array produced no instances")

    result_body_id = "body_" + feature_id
    if operation == "new":
        tool_shape = fuse_shapes(instances)
        new_body = Body(
            id=result_body_id,
            created_by=feature_id,
            shape=_ensure_occ(tool_shape),
            sketch_id="",
        )
        body_store[result_body_id] = new_body
        return {"status": "ok", "body_id": result_body_id, "operation": "new"}
    else:
        # Fuse incrementally so the final union's BrepDiff is captured. The seam
        # faces where copies meet are attributed to this array feature via the
        # @created_by rewrite. Single-op history: only the last union's diff is
        # retained (N-1 unions for N copies; see plan Stage 4).
        if len(instances) == 1:
            fused: object = _ensure_cq(instances[0])
            last_diff = None
        else:
            fused = instances[0]
            last_diff = None
            for inst in instances[1:]:
                fused, last_diff = boolean_union_with_diff(fused, inst)
        body.shape = _ensure_occ(fused)
        body.modified_by.append(feature_id)
        body.brep_diff = last_diff
        return {"status": "ok", "body_id": source_body_id, "operation": "add"}
