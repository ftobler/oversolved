from __future__ import annotations

import logging

from oversolved.kernel.query import Repository
from oversolved.kernel.cadquery_ops import (
    _ensure_occ, boolean_cut_with_diff, boolean_union_with_diff, boolean_intersection_with_diff,
)
from oversolved.kernel.solver_features_shared import _resolve_body, _split_compound
from oversolved.kernel.types3d import Body

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_boolean",
    "ALL_KEYS",
]

ALL_KEYS: frozenset[str] = frozenset({
    "boolean", "tools", "keep_tools", "operation", "target",
})


def _solve_boolean(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    feature_id = feature.get("id", "")
    sub = feature.get("boolean") or {}
    operation = sub.get("operation", "union")
    target_ref = sub.get("target", "")
    tool_refs = sub.get("tools") or []
    keep_tools = sub.get("keep_tools", False)

    if not target_ref:
        raise ValueError("boolean: 'target' is required")
    if not tool_refs:
        raise ValueError("boolean: 'tools' must have at least one entry")

    target_body = _resolve_body(target_ref, body_store)

    result_shape = target_body.shape
    consumed_keys: list[str] = []
    last_diff = None

    for tool_ref in tool_refs:
        tool_body = _resolve_body(tool_ref, body_store)
        if operation == "union":
            result_shape, last_diff = boolean_union_with_diff(result_shape, tool_body.shape)
        elif operation == "subtract":
            result_shape, last_diff = boolean_cut_with_diff(result_shape, tool_body.shape)
        elif operation == "intersect":
            result_shape, last_diff = boolean_intersection_with_diff(result_shape, tool_body.shape)
        else:
            raise ValueError(f"boolean: unknown operation '{operation}'")
        if not keep_tools:
            consumed_keys.append(tool_body.id)

    target_body.shape = _ensure_occ(result_shape)
    target_body.modified_by.append(feature_id)
    # Single-op history: only the last tool's diff is retained (see plan Stage 3).
    target_body.brep_diff = last_diff

    body_ids: list[str] = [target_body.id]
    # If subtract split the body into disconnected solids, create extra bodies.
    if operation == "subtract":
        solids = _split_compound(_ensure_occ(result_shape))
        if len(solids) > 1:
            target_body.shape = _ensure_occ(solids[0])
            for i, solid in enumerate(solids[1:], start=1):
                suffix = i
                while f"{target_body.id}_{suffix}" in body_store:
                    suffix += 1
                new_bid = f"{target_body.id}_{suffix}"
                body_store[new_bid] = Body(
                    id=new_bid,
                    created_by=target_body.created_by,
                    shape=_ensure_occ(solid),
                    sketch_id=target_body.sketch_id,
                )
                body_ids.append(new_bid)

    for key in consumed_keys:
        body_store.pop(key, None)

    return {"status": "ok", "body_id": target_body.id, "body_ids": body_ids, "operation": operation}
