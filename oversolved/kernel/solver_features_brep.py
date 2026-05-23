from __future__ import annotations

import logging
import math

from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Frame3D
from oversolved.kernel.solver_features_shared import (
    _apply_body_operation, _collect_extrude_loops,
    _resolve_direction,
)
from oversolved.kernel.geometry_tessellation import extrude_profile as _ep, extrude_profile_with_lineage, revolve_profile_with_lineage
from oversolved.kernel.cadquery_ops import boolean_union, extrude_face, _compute_face_normal
from oversolved.kernel.geometry_tessellation import sketch_loops_to_face, revolve_face as _rf
from oversolved.kernel.solver_registry import _sketch_to_world_2d
from oversolved.kernel.profile_loops import _surface_entity_ids

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_extrude",
    "_solve_revolve",
    "ALL_KEYS",
]

ALL_KEYS: frozenset[str] = frozenset({
    "extrude", "revolve",
    "sketch", "distance", "depth", "direction", "operation", "merge_target",
    "angle", "axis", "axis_origin", "axis_direction",
})


def _solve_extrude(feature: dict, global_repo: Repository, body_store: dict) -> dict:
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
    cq_faces: list = []
    first_pt: Frame3D | dict = {}
    first_sketch_id = ""
    profile_errors: list[str] = []
    profile_queries: list[str] = []
    face_lineage: dict[str, list[str]] = {}
    edge_lineage: dict[str, list[str]] = {}
    for sketch_ref in sketch_refs:
        try:
            loops, pt, sketch_id, cq_face = _collect_extrude_loops(
                sketch_ref, feature_id, feature, distance, global_repo, body_store
            )
        except ValueError as exc:
            profile_errors.append(str(exc))
            continue
        if cq_face is not None:
            cq_faces.append(cq_face)
        else:
            all_loops.extend(loops)
        # collect profile entity tokens for lineage tagging
        topo = global_repo.elements.get("_topo_" + sketch_id, {})
        for surface in topo.get("surfaces", []):
            eids = _surface_entity_ids(surface)
            profile_queries.extend(sorted(eids))
        if not first_pt:
            first_pt = pt
            first_sketch_id = sketch_id

    if profile_errors and not cq_faces and not all_loops:
        raise ValueError("; ".join(profile_errors))

    body_id = "body_" + feature_id
    result: dict = {"status": "ok", "body_id": body_id}
    operation = feature.get("operation", "add")
    direction = feature.get("direction", "normal")

    if not cq_faces and not all_loops:
        result["mesh_warning"] = "no closed profile found; body has no shape"
    elif cq_faces and not all_loops:
        face_normal = _compute_face_normal(cq_faces[0])
        reverse_vec = [-n for n in face_normal]
        if direction == "symmetric":
            half_dist = distance / 2.0
            part_pos = extrude_face(cq_faces[0], face_normal, half_dist)
            part_neg = extrude_face(cq_faces[0], reverse_vec, half_dist)
            tool_shape = boolean_union(part_pos, part_neg)
            for cq_face in cq_faces[1:]:
                pos = extrude_face(cq_face, face_normal, half_dist)
                neg = extrude_face(cq_face, reverse_vec, half_dist)
                tool_shape = boolean_union(tool_shape, boolean_union(pos, neg))
        elif direction == "reverse":
            tool_shape = extrude_face(cq_faces[0], reverse_vec, distance)
            for cq_face in cq_faces[1:]:
                tool_shape = boolean_union(tool_shape, extrude_face(cq_face, reverse_vec, distance))  # type: ignore[assignment]
        else:
            tool_shape = extrude_face(cq_faces[0], face_normal, distance)
            for cq_face in cq_faces[1:]:
                tool_shape = boolean_union(tool_shape, extrude_face(cq_face, face_normal, distance))  # type: ignore[assignment]
    else:
        if isinstance(first_pt, Frame3D):
            normal = first_pt.normal
        elif isinstance(first_pt, dict):
            normal = first_pt.get("normal", [0, 0, 1])
        else:
            normal = [0, 0, 1]
        direction_vec, effective_distance, effective_plane = _resolve_direction(
            normal, first_pt, direction, distance
        )
        tool_shape, faces_lineage, edges_lineage = extrude_profile_with_lineage(
            all_loops, effective_plane, direction_vec, effective_distance,
            sketch_id=first_sketch_id,
        )
        if face_lineage is None:
            face_lineage = {}
        face_lineage.update(faces_lineage)
        if edge_lineage is None:
            edge_lineage = {}
        edge_lineage.update(edges_lineage)

    op_result = _apply_body_operation(
        tool_shape, body_store, operation, merge_target,
        body_id, feature_id, first_sketch_id, op_name="extrude",
        profile_queries=profile_queries,
        face_lineage=face_lineage,
        edge_lineage=edge_lineage,
    )
    result.update(op_result)

    if profile_errors:
        result["status"] = "partial"
        result["exception"] = "; ".join(profile_errors)

    return result


def _solve_revolve(feature: dict, global_repo: Repository, body_store: dict) -> dict:
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
    cq_faces: list = []
    first_pt: Frame3D | dict = {}
    first_sketch_id = ""
    profile_errors: list[str] = []
    profile_queries: list[str] = []
    face_lineage: dict[str, list[str]] = {}
    edge_lineage: dict[str, list[str]] = {}
    for sketch_ref in sketch_refs:
        try:
            loops, pt, sketch_id, cq_face = _collect_extrude_loops(
                sketch_ref, feature_id, feature, 0.0, global_repo, body_store
            )
        except ValueError as exc:
            profile_errors.append(str(exc))
            continue
        if cq_face is not None:
            cq_faces.append(cq_face)
        else:
            all_loops.extend(loops)
        # collect profile entity tokens for lineage tagging
        topo = global_repo.elements.get("_topo_" + sketch_id, {})
        for surface in topo.get("surfaces", []):
            eids = _surface_entity_ids(surface)
            profile_queries.extend(sorted(eids))
        if not first_pt:
            first_pt = pt
            first_sketch_id = sketch_id

    if profile_errors and not cq_faces and not all_loops:
        raise ValueError("; ".join(profile_errors))

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
        elif axis_data and "external_params" in axis_data and axis_data.get("kind") == "line":
            sketch_id = axis_data.get("sketch_id", "")
            plane = global_repo.elements.get("_pt_" + sketch_id) if sketch_id else None
            if plane:
                params = axis_data["external_params"]
                start = _sketch_to_world_2d(params[0:2], plane)
                end = _sketch_to_world_2d(params[2:4], plane)
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
    direction = feature.get("direction", "normal")

    if not cq_faces and not all_loops:
        result["mesh_warning"] = "no closed profile found; body has no shape"
    elif cq_faces and not all_loops:
        if direction == "symmetric":
            half_angle = angle / 2.0
            part_pos = _rf(cq_faces[0], axis_origin, axis_direction, half_angle)
            part_neg = _rf(cq_faces[0], axis_origin, axis_direction, -half_angle)
            tool_shape = boolean_union(part_pos, part_neg)
            for cq_face in cq_faces[1:]:
                pos = _rf(cq_face, axis_origin, axis_direction, half_angle)
                neg = _rf(cq_face, axis_origin, axis_direction, -half_angle)
                tool_shape = boolean_union(tool_shape, boolean_union(pos, neg))
        else:
            effective_angle = -angle if direction == "reverse" else angle
            tool_shape = _rf(cq_faces[0], axis_origin, axis_direction, effective_angle)
            for cq_face in cq_faces[1:]:
                tool_shape = boolean_union(  # type: ignore[assignment]
                    tool_shape, _rf(cq_face, axis_origin, axis_direction, effective_angle)
                )
    else:
        if direction == "symmetric":
            half_angle = angle / 2.0
            tool_shape_pos, fl_pos, el_pos = revolve_profile_with_lineage(
                all_loops, first_pt, axis_origin, axis_direction, half_angle,
                sketch_id=first_sketch_id,
            )
            tool_shape_neg, fl_neg, el_neg = revolve_profile_with_lineage(
                all_loops, first_pt, axis_origin, axis_direction, -half_angle,
                sketch_id=first_sketch_id,
            )
            tool_shape = boolean_union(tool_shape_pos, tool_shape_neg)
            face_lineage.update(fl_pos)
            face_lineage.update(fl_neg)
            edge_lineage.update(el_pos)
            edge_lineage.update(el_neg)
        else:
            effective_angle = -angle if direction == "reverse" else angle
            tool_shape, faces_l, edges_l = revolve_profile_with_lineage(
                all_loops, first_pt, axis_origin, axis_direction, effective_angle,
                sketch_id=first_sketch_id,
            )
            face_lineage.update(faces_l)
            edge_lineage.update(edges_l)

    op_result = _apply_body_operation(
        tool_shape, body_store, operation, merge_target,
        body_id, feature_id, first_sketch_id, op_name="revolve",
        profile_queries=profile_queries,
        face_lineage=face_lineage,
        edge_lineage=edge_lineage,
    )
    result.update(op_result)

    if profile_errors:
        result["status"] = "partial"
        result["exception"] = "; ".join(profile_errors)

    return result
