from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
from oversolved.kernel.query import Repository
from oversolved.kernel.cadquery_ops import boolean_cut, boolean_union, boolean_intersection, _ensure_occ
from oversolved.kernel.solver_features_shared import _resolve_body

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_boolean",
]


def _solve_boolean(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.cadquery_ops import boolean_cut, boolean_union, boolean_intersection  # noqa: F811

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

    for tool_ref in tool_refs:
        tool_body = _resolve_body(tool_ref, body_store)
        if operation == "union":
            result_shape = boolean_union(result_shape, tool_body.shape)
        elif operation == "subtract":
            result_shape = boolean_cut(result_shape, tool_body.shape)
        elif operation == "intersect":
            result_shape = boolean_intersection(result_shape, tool_body.shape)
        else:
            raise ValueError(f"boolean: unknown operation '{operation}'")
        if not keep_tools:
            consumed_keys.append(tool_body.id)

    target_body.shape = _ensure_occ(result_shape)
    target_body.modified_by.append(feature_id)

    for key in consumed_keys:
        body_store.pop(key, None)

    return {"status": "ok", "body_id": target_body.id, "operation": operation}
