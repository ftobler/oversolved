from __future__ import annotations

import logging
import numpy as np

from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Frame3D
from oversolved.kernel.cadquery_ops import _ensure_cq, _ensure_occ
from oversolved.kernel.solver_features_shared import _resolve_body

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_hole",
    "ALL_KEYS",
]

ALL_KEYS: frozenset[str] = frozenset({
    "hole", "sketch", "diameter", "depth_mode", "depth", "direction", "target",
})


def _solve_hole(feature: dict, global_repo: Repository, body_store: dict, features_by_id: dict[str, dict]) -> dict:
    from oversolved.kernel.cadquery_ops import make_cylinder, boolean_cut  # noqa: F811

    sub = feature.get("hole") or {}
    sketch_ref = sub.get("sketch", "").lstrip("@")
    diameter = float(sub.get("diameter", 10.0))
    depth_mode = sub.get("depth_mode", "blind")
    depth = float(sub.get("depth", 10.0))
    direction = sub.get("direction", "normal")
    target_ref = sub.get("target", "")

    radius = diameter / 2.0

    plane = global_repo.elements.get("_pt_" + sketch_ref)
    if plane is None:
        raise ValueError(f"hole: sketch '{sketch_ref}' has no plane transform registered")

    if isinstance(plane, Frame3D):
        origin = np.array(plane.origin)
        x_axis = np.array(plane.x_axis)
        y_axis = np.array(plane.y_axis)
        normal = np.array(plane.normal)
    else:
        origin = np.array(plane["origin"])
        x_axis = np.array(plane["x_axis"])
        y_axis = np.array(plane["y_axis"])
        normal = np.array(plane["normal"])
    axis = normal if direction == "normal" else -normal

    if target_ref:
        target_body = _resolve_body(target_ref, body_store)
    else:
        if not body_store:
            raise ValueError("hole: no bodies in body_store and no target specified")
        target_body = next(iter(body_store.values()))

    sketch_feature = features_by_id.get(sketch_ref, {})
    entities = sketch_feature.get("entities", [])
    point_entities = [e for e in entities if e.get("kind") == "point"]

    if not point_entities:
        raise ValueError(f"hole: sketch '{sketch_ref}' has no point entities")

    if depth_mode == "through_all":
        bb = _ensure_cq(target_body.shape).BoundingBox()
        span = max(bb.xmax - bb.xmin, bb.ymax - bb.ymin, bb.zmax - bb.zmin)
        through_depth: float = span * 3.0
        through_back_offset: float = span
    else:
        through_depth = 0.0
        through_back_offset = 0.0

    for entity in point_entities:
        eid = entity["id"]
        xy_entry = global_repo.elements.get(sketch_ref + "/" + eid + "/xy")
        if xy_entry is None:
            logger.warning(
                "hole: xy entry not found for entity '%s' in sketch '%s'; skipping",
                eid, sketch_ref,
            )
            continue
        x2d, y2d = xy_entry["external_xy"]
        center_3d = origin + x2d * x_axis + y2d * y_axis

        if depth_mode == "through_all":
            start_3d = center_3d - axis * through_back_offset
            h = through_depth
        else:
            start_3d = center_3d
            h = depth

        cyl = make_cylinder(list(start_3d), list(axis), radius, h)
        target_body.shape = _ensure_occ(boolean_cut(target_body.shape, cyl))

    target_body.modified_by.append(feature["id"])
    return {
        "status": "ok",
        "body_id": target_body.id,
        "hole_count": len(point_entities),
    }
