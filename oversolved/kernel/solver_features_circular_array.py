from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.gp import gp_Trsf
from oversolved.kernel.query import Repository
from oversolved.kernel.cadquery_ops import _ensure_cq, _ensure_occ, boolean_union_with_diff
from oversolved.kernel.types3d import Body
from oversolved.kernel.geometry_features import make_rotation_trsf, transform_copy
from oversolved.kernel.solver_features_shared import (
    _resolve_axis_query,
    _resolve_body,
)

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_circular_array",
    "ALL_KEYS",
]

ALL_KEYS: frozenset[str] = frozenset({
    "circular_array", "source_body", "operation",
    "count", "step_angle", "include_source",
    "axis", "axis_origin", "axis_direction",
})


def _build_circular_transforms(
    feature: dict,
    global_repo: Repository,
    body_store: dict | None = None,
) -> list[gp_Trsf]:
    count = int(feature.get("count", 4))
    include_source = bool(feature.get("include_source", True))
    step_angle_raw = feature.get("step_angle")
    if step_angle_raw is None:
        step = 360.0 / count
    else:
        step = float(step_angle_raw)
    axis_origin = feature.get("axis_origin", [0, 0, 0])
    axis_direction = feature.get("axis_direction", [0, 0, 1])
    axis_origin, axis_direction = _resolve_axis_query(
        feature.get("axis", ""),
        global_repo,
        axis_origin,
        axis_direction,
        body_store=body_store,
    )
    trsfs: list[gp_Trsf] = []
    num = count if not include_source else count - 1
    for i in range(1, 1 + num):
        trsf = make_rotation_trsf(axis_origin, axis_direction, math.radians(step * i))
        trsfs.append(trsf)
    return trsfs


def _solve_circular_array(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    feature_id = feature.get("id", "")
    sub = feature.get("circular_array") or {}
    feature = {**sub, **feature}

    source_body_ref = feature.get("source_body", "")
    if source_body_ref:
        try:
            body = _resolve_body(source_body_ref, body_store)
        except ValueError:
            available = list(body_store.keys())
            raise ValueError(
                f"circular_array: source body '{source_body_ref}' not found; "
                f"available body IDs: {available}"
            )
    else:
        _body_or_none = next(iter(body_store.values())) if body_store else None
        if _body_or_none is None:
            raise ValueError("circular_array: no source body with shape found")
        body = _body_or_none
    source_body_id = body.id
    if body.shape is None:
        raise ValueError("circular_array: source body has no shape")

    include_source = bool(feature.get("include_source", True))
    operation = feature.get("operation", "add")

    trsfs = _build_circular_transforms(feature, global_repo, body_store)

    instances: list = []
    if include_source:
        instances.append(body.shape)
    for trsf in trsfs:
        instances.append(transform_copy(body.shape, trsf))

    if not instances:
        raise ValueError("circular_array produced no instances")

    result_body_id = "body_" + feature_id
    if operation == "new":
        for i, shape in enumerate(instances):
            bid = result_body_id if i == 0 else f"{result_body_id}_{i}"
            body_store[bid] = Body(
                id=bid,
                created_by=feature_id,
                shape=_ensure_occ(shape),
                sketch_id="",
            )
        return {"status": "ok", "body_id": result_body_id, "operation": "new"}
    else:
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
