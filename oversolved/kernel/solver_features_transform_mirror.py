from __future__ import annotations

import logging

from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Frame3D
from oversolved.kernel.cadquery_ops import _ensure_occ
from oversolved.kernel.solver_features_shared import _resolve_body

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_mirror",
    "_solve_transform",
]


def _solve_transform(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.cadquery_ops import apply_transform_shape  # noqa: F811
    from oversolved.kernel.types3d import Body  # noqa: F811
    from oversolved.kernel.solver_plane import _get_point_3d, _get_edge_3d  # noqa: F811

    feature_id = feature.get("id", "")
    sub = feature.get("transform") or {}
    cfg = {**sub, **{k: v for k, v in feature.items() if k not in ("transform",)}}

    body_query = cfg.get("body", "")
    source_body = _resolve_body(body_query, body_store) if body_query else None
    if source_body is None or source_body.shape is None:
        raise ValueError(f"transform: body not found: {body_query!r}")

    translation = cfg.get("translation")
    tr_from = cfg.get("translation_from")
    tr_to = cfg.get("translation_to")
    if tr_from and tr_to:
        p0_ref = global_repo.query(tr_from, body_store=body_store)
        p1_ref = global_repo.query(tr_to, body_store=body_store)
        if p0_ref is None:
            raise ValueError(f"transform: translation_from not found: {tr_from!r}")
        if p1_ref is None:
            raise ValueError(f"transform: translation_to not found: {tr_to!r}")
        p0 = _get_point_3d(p0_ref, global_repo)
        p1 = _get_point_3d(p1_ref, global_repo)
        translation = [float(p1[i] - p0[i]) for i in range(3)]

    rotation_angle = float(cfg.get("rotation_angle", 0.0))
    rotation_axis_origin = cfg.get("rotation_axis_origin")
    rotation_axis_direction = cfg.get("rotation_axis_direction")
    axis_query = cfg.get("rotation_axis")
    if axis_query:
        edge_ref = global_repo.query(axis_query, body_store=body_store)
        if edge_ref is None:
            raise ValueError(f"transform: rotation_axis not found: {axis_query!r}")
        edge = _get_edge_3d(edge_ref, global_repo)
        if edge:
            p0, p1 = edge
            d = [float(p1[i] - p0[i]) for i in range(3)]
            length = sum(x * x for x in d) ** 0.5
            if length > 1e-10:
                rotation_axis_origin = list(p0)
                rotation_axis_direction = [x / length for x in d]

    scale = float(cfg.get("scale", 1.0))
    scale_center = cfg.get("scale_center")
    scale_center_query = cfg.get("scale_center_from")
    if scale_center_query:
        pt_ref = global_repo.query(scale_center_query, body_store=body_store)
        if pt_ref is None:
            raise ValueError(f"transform: scale_center_from not found: {scale_center_query!r}")
        scale_center = list(_get_point_3d(pt_ref, global_repo))

    new_shape = apply_transform_shape(
        source_body.shape,
        translation=translation,
        rotation_axis_origin=rotation_axis_origin,
        rotation_axis_direction=rotation_axis_direction,
        rotation_angle_deg=rotation_angle,
        scale=scale,
        scale_center=scale_center,
    )

    operation = cfg.get("operation", "new")
    if operation == "replace":
        source_body.shape = _ensure_occ(new_shape)
        source_body.modified_by = list(source_body.modified_by or []) + [feature_id]
        return {"status": "ok", "body_id": source_body.id, "operation": "replace"}
    else:
        new_body_id = "body_" + feature_id
        body_store[new_body_id] = Body(
            id=new_body_id,
            created_by=feature_id,
            modified_by=[],
            shape=_ensure_occ(new_shape),
            sketch_id=source_body.sketch_id,
        )
        return {"status": "ok", "body_id": new_body_id, "operation": "new"}


def _solve_mirror(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    from oversolved.kernel.types3d import Body  # noqa: F811
    from oversolved.kernel.geometry_features import transform_copy  # noqa: F811
    from oversolved.kernel.cadquery_ops import boolean_union, make_mirror_trsf  # noqa: F811

    feature_id = feature.get("id", "")
    sub = feature.get("mirror") or {}
    cfg = {**sub, **{k: v for k, v in feature.items() if k not in ("mirror",)}}

    body_query = cfg.get("body", "")
    source_body = _resolve_body(body_query, body_store) if body_query else None
    if source_body is None or source_body.shape is None:
        raise ValueError(f"mirror: body not found: {body_query!r}")

    plane_query = cfg.get("plane", "")
    if not plane_query:
        raise ValueError("mirror: plane is required")
    plane_data = global_repo.query(plane_query, body_store=body_store)
    if plane_data is None:
        raise ValueError(f"mirror: plane not found: {plane_query!r}")
    if isinstance(plane_data, Frame3D):
        origin = plane_data.origin
        normal = plane_data.normal
    elif isinstance(plane_data, dict) and plane_data.get("type") in ("flatface", "plane"):
        origin = plane_data.get("origin", [0, 0, 0])
        normal = plane_data.get("normal", [0, 0, 1])
    else:
        raise ValueError(f"mirror: plane query did not resolve to a plane: {plane_query!r}")

    keep_original = bool(cfg.get("keep_original", True))
    merge = bool(cfg.get("merge", True))

    trsf = make_mirror_trsf(
        (float(origin[0]), float(origin[1]), float(origin[2])),
        (float(normal[0]), float(normal[1]), float(normal[2])),
    )
    mirrored_shape = transform_copy(source_body.shape, trsf)

    if not keep_original:
        source_body.shape = _ensure_occ(mirrored_shape)
        source_body.modified_by.append(feature_id)
        return {"status": "ok", "body_id": source_body.id, "operation": "replace"}

    if merge:
        new_shape = boolean_union(source_body.shape, mirrored_shape)
        source_body.shape = _ensure_occ(new_shape)
        source_body.modified_by.append(feature_id)
        return {"status": "ok", "body_id": source_body.id, "operation": "merge"}

    new_body_id = "body_" + feature_id
    body_store[new_body_id] = Body(
        id=new_body_id,
        created_by=feature_id,
        modified_by=[],
        shape=_ensure_occ(mirrored_shape),
        sketch_id=source_body.sketch_id,
    )
    return {"status": "ok", "body_id": new_body_id, "body_ids": [source_body.id, new_body_id], "operation": "new"}
