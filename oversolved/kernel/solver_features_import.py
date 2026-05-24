from __future__ import annotations

import base64
import logging
import os
import tempfile

from oversolved.kernel.query import Repository
from oversolved.kernel.cadquery_ops import _ensure_occ
from oversolved.kernel.types3d import Body
from oversolved.kernel.geometry_io import step_file_to_shape

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_import_step",
    "ALL_KEYS",
]

ALL_KEYS: frozenset[str] = frozenset({
    "file_data", "scale",
})


def _solve_import_step(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    feature_id = feature.get("id", "")
    file_data_b64 = feature.get("file_data", "")
    scale = float(feature.get("scale", 1.0))

    if not file_data_b64:
        raise ValueError("import_step: requires 'file_data'")

    raw = base64.b64decode(file_data_b64)

    body_id = "body_" + feature_id

    with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as f:
        f.write(raw)
        tmp_path = f.name
    try:
        shape = step_file_to_shape(tmp_path, scale=scale)
    finally:
        os.unlink(tmp_path)

    body_store[body_id] = Body(
        id=body_id,
        created_by=feature_id,
        shape=_ensure_occ(shape),
    )
    return {"status": "ok", "body_id": body_id}
