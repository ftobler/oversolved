from __future__ import annotations

import logging
import math

from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Frame3D
from oversolved.kernel.solver_features_shared import (
    _apply_body_operation, _collect_extrude_loops,
    _resolve_direction,
)

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_extrude",
    "_solve_revolve",
]


def _solve_extrude(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    from oversolved.kernel.geometry_tessellation import extrude_profile as _ep  # noqa: F811

    feature_id = feature.get("id", "")
    sub = feature.get("extrude") or {}
    merge_target = sub.get("merge_target") or feature.get("merge_target")
    feature = {**sub, **feature}
    sketch_raw = feature.get("sketch", "")
    if isinstance(sketch_raw, list):
        sketch_refs: list[str] = [s for s in sketch_raw if s]
    else:
        sketch_refs = [sketch_raw] if sketch_raw else []
    distance = float(feature.get("distance") or feature.get("depth") or 1.0)

    if distance == 0:
        raise ValueError("extrude distance must be non-zero")

    if not sketch_refs:
        raise ValueError("extrude requires at least one profile reference")

    all_loops: list = []
    first_pt: Frame3D | dict = {}
    first_sketch_id = ""
    for sketch_ref in sketch_refs:
        loops, pt, sketch_id = _collect_extrude_loops(
            sketch_ref, feature_id, feature, distance, global_repo, body_store
        )
        all_loops.extend(loops)
        if not first_pt:
            first_pt = pt
            first_sketch_id = sketch_id

    if isinstance(first_pt, Frame3D):
        normal = first_pt.normal
    elif isinstance(first_pt, dict):
        normal = first_pt.get("normal", [0, 0, 1])
    else:
        normal = [0, 0, 1]
    body_id = "body_" + feature_id
    result: dict = {"status": "ok", "body_id": body_id}

    operation = feature.get("operation", "add")

    if not all_loops:
        result["mesh_warning"] = "no closed profile found; body has no shape"
    else:
        direction = feature.get("direction", "normal")
        direction_vec, effective_distance, effective_plane = _resolve_direction(
            normal, first_pt, direction, distance
        )
        tool_shape = _ep(
            all_loops, effective_plane, direction_vec, effective_distance
        )
        op_result = _apply_body_operation(
            tool_shape, body_store, operation, merge_target,
            body_id, feature_id, first_sketch_id, op_name="extrude",
        )
        result.update(op_result)

    return result


def _solve_revolve(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    from oversolved.kernel.geometry_tessellation import sketch_loops_to_face, revolve_face as _rf  # noqa: F811

    feature_id = feature.get("id", "")
    sub = feature.get("revolve") or {}
    merge_target = sub.get("merge_target") or feature.get("merge_target")
    feature = {**sub, **feature}
    sketch_raw = feature.get("sketch", "")
    if isinstance(sketch_raw, list):
        sketch_refs: list[str] = [s for s in sketch_raw if s]
    else:
        sketch_refs = [sketch_raw] if sketch_raw else []
    angle = float(feature.get("angle") or 360.0)

    if angle == 0:
        raise ValueError("revolve angle must be non-zero")

    if not sketch_refs:
        raise ValueError("revolve requires at least one profile reference")

    all_loops: list = []
    first_pt: Frame3D | dict = {}
    first_sketch_id = ""
    for sketch_ref in sketch_refs:
        loops, pt, sketch_id = _collect_extrude_loops(
            sketch_ref, feature_id, feature, 0.0, global_repo, body_store
        )
        all_loops.extend(loops)
        if not first_pt:
            first_pt = pt
            first_sketch_id = sketch_id

    axis_origin = feature.get("axis_origin", [0, 0, 0])
    axis_direction = feature.get("axis_direction", [0, 0, 1])
    stored_direction = list(axis_direction)
    axis_query = feature.get("axis")
    if axis_query:
        axis_data = global_repo.query(axis_query, body_store=body_store)
        if axis_data and "start" in axis_data and "end" in axis_data:
            start = axis_data["start"]
            end = axis_data["end"]
            dx = end[0] - start[0]
            dy = end[1] - start[1]
            dz = end[2] - start[2]
            length = math.sqrt(dx * dx + dy * dy + dz * dz)
            if length > 1e-12:
                computed = [dx / length, dy / length, dz / length]
                dot = sum(computed[i] * stored_direction[i] for i in range(3))
                if dot < 0:
                    axis_origin = list(end)
                    axis_direction = [-computed[0], -computed[1], -computed[2]]
                else:
                    axis_origin = list(start)
                    axis_direction = computed
    body_id = "body_" + feature_id
    result: dict = {"status": "ok", "body_id": body_id}

    operation = feature.get("operation", "add")

    if not all_loops:
        result["mesh_warning"] = "no closed profile found; body has no shape"
    else:
        face = sketch_loops_to_face(all_loops, first_pt)
        direction = feature.get("direction", "normal")
        if direction == "symmetric":
            half_angle = angle / 2.0
            tool_shape_pos = _rf(face, axis_origin, axis_direction, half_angle)
            tool_shape_neg = _rf(face, axis_origin, axis_direction, -half_angle)
            from oversolved.kernel.cadquery_ops import boolean_union  # noqa: F811
            tool_shape = boolean_union(tool_shape_pos, tool_shape_neg)
        else:
            effective_angle = -angle if direction == "reverse" else angle
            tool_shape = _rf(face, axis_origin, axis_direction, effective_angle)

        op_result = _apply_body_operation(
            tool_shape, body_store, operation, merge_target,
            body_id, feature_id, first_sketch_id, op_name="revolve",
        )
        result.update(op_result)

    return result
