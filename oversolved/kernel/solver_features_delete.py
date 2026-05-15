from __future__ import annotations

import logging

from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Body
from oversolved.kernel.solver_features_shared import _resolve_body

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_delete_body",
]


def _solve_delete_body(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    sub = feature.get("delete_body") or {}
    body_query = sub.get("body", "")
    if body_query.startswith("?"):
        resolved = global_repo.query(body_query, body_store=body_store)
        if resolved is None:
            raise ValueError(f"delete_body: body not found: {body_query!r}")
        if isinstance(resolved, Body):
            body_key = resolved.id
        elif isinstance(resolved, dict):
            _raw_key = resolved.get("body_id")
            if not _raw_key:
                raise ValueError(f"delete_body: query did not resolve to a body: {body_query!r}")
            body_key = str(_raw_key)
        else:
            raise ValueError(f"delete_body: query did not resolve to a body: {body_query!r}")
    else:
        body = _resolve_body(body_query, body_store)
        body_key = body.id
    del body_store[body_key]
    return {"status": "ok", "deleted_body_id": body_key}
