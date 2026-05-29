from __future__ import annotations

import logging
import math

from oversolved.kernel.query import Repository, _parse_ancestry
from oversolved.kernel.types3d import Frame3D
from oversolved.kernel.solver_features_shared import (
    _apply_body_operation, _collect_extrude_loops,
    _resolve_direction,
)
from oversolved.kernel.geometry_tessellation import (
    extrude_profile as _ep, extrude_profile_with_lineage,
    revolve_profile_with_lineage, sweep_profile_with_lineage,
)
from oversolved.kernel.cadquery_ops import (
    boolean_union, extrude_face, _compute_face_normal,
    make_line_edge, make_arc_edge,
)
from oversolved.kernel.geometry_tessellation import sketch_loops_to_face, revolve_face as _rf
from oversolved.kernel.solver_registry import _sketch_to_world_2d
from oversolved.kernel.profile_loops import _surface_entity_ids

logger = logging.getLogger(__name__)

__all__ = [
    "_solve_extrude",
    "_solve_revolve",
    "_solve_sweep",
    "ALL_KEYS",
]

ALL_KEYS: frozenset[str] = frozenset({
    "extrude", "revolve", "sweep",
    "sketch", "distance", "depth", "direction", "operation", "merge_target",
    "angle", "axis", "axis_origin", "axis_direction", "path",
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
        raise ValueError("extrude: distance must be non-zero")

    if not sketch_refs:
        raise ValueError("extrude: requires at least one profile reference")

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
        raise ValueError("revolve: angle must be non-zero")

    if not sketch_refs:
        raise ValueError("revolve: requires at least one profile reference")

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


def _solve_sweep(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    feature_id = feature.get("id", "")
    sub = feature.get("sweep") or {}
    merge_target = sub.get("merge_target") or feature.get("merge_target")
    feature = {**sub, **feature}
    sketch_raw = feature.get("sketch", "")
    if isinstance(sketch_raw, list):
        sketch_refs: list[str] = [s for s in sketch_raw if s]
    else:
        sketch_refs = [sketch_raw] if sketch_raw else []
    path_ref = feature.get("path") or ""

    if not sketch_refs:
        raise ValueError("sweep: requires at least one profile reference")
    if not path_ref:
        raise ValueError("sweep: requires a path reference")

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
        topo = global_repo.elements.get("_topo_" + sketch_id, {})
        for surface in topo.get("surfaces", []):
            eids = _surface_entity_ids(surface)
            profile_queries.extend(sorted(eids))
        if not first_pt:
            first_pt = pt
            first_sketch_id = sketch_id

    if profile_errors and not cq_faces and not all_loops:
        raise ValueError("; ".join(profile_errors))
    if cq_faces and not all_loops:
        raise ValueError("sweep: face profiles are not yet supported; use a sketch profile")
    if not all_loops:
        raise ValueError("sweep: no closed profile found")

    spine_edges, _path_sketch_id = _collect_path_edges(path_ref, global_repo)

    body_id = "body_" + feature_id
    result: dict = {"status": "ok", "body_id": body_id}
    operation = feature.get("operation", "add")

    tool_shape, faces_lineage, edges_lineage = sweep_profile_with_lineage(
        all_loops, first_pt, spine_edges, sketch_id=first_sketch_id,
    )
    face_lineage.update(faces_lineage)
    edge_lineage.update(edges_lineage)

    op_result = _apply_body_operation(
        tool_shape, body_store, operation, merge_target,
        body_id, feature_id, first_sketch_id, op_name="sweep",
        profile_queries=profile_queries,
        face_lineage=face_lineage,
        edge_lineage=edge_lineage,
    )
    result.update(op_result)

    if profile_errors:
        result["status"] = "partial"
        result["exception"] = "; ".join(profile_errors)

    return result


def _path_ref_to_sketch_id(path_ref: str, global_repo: Repository) -> str:
    """Resolve a sweep path reference to the sketch id holding the spine."""
    if path_ref.startswith("@"):
        return path_ref[1:].split("/")[0]
    if path_ref.startswith("?"):
        ids, _ = _parse_ancestry(path_ref)
        for aid in ids:
            if aid.startswith("@") and "/" not in aid:
                cand = aid[1:]
                if (global_repo.elements.get("_topo_" + cand) is not None
                        or global_repo.elements.get("_pt_" + cand) is not None):
                    return cand
        raise ValueError(f"sweep: could not resolve path sketch from {path_ref!r}")
    return path_ref.lstrip("$")


def _order_edges_into_chain(edges: list[dict], tol: float = 1e-6) -> list[dict]:
    """Order path edges into a connected chain by matching 2D endpoints.

    Geometry of each edge is orientation-independent for wire assembly, so only
    the sequence matters. Raises if the edges do not form one connected chain.
    """
    def close(a: list, b: tuple) -> bool:
        return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol

    edges = list(edges)
    if len(edges) <= 1:
        return edges

    endpoints: list[tuple] = []
    for e in edges:
        endpoints.append(tuple(e["start"]))
        endpoints.append(tuple(e["end"]))

    def degree(p: tuple) -> int:
        return sum(1 for q in endpoints if close(list(p), q))

    used = [False] * len(edges)
    start_i = 0
    cur_pt: tuple = tuple(edges[0]["end"])
    for i, e in enumerate(edges):
        if degree(tuple(e["start"])) == 1:
            start_i, cur_pt = i, tuple(e["end"])
            break
        if degree(tuple(e["end"])) == 1:
            start_i, cur_pt = i, tuple(e["start"])
            break

    ordered = [edges[start_i]]
    used[start_i] = True
    for _ in range(len(edges) - 1):
        for j, e in enumerate(edges):
            if used[j]:
                continue
            if close(e["start"], cur_pt):
                ordered.append(e)
                used[j] = True
                cur_pt = tuple(e["end"])
                break
            if close(e["end"], cur_pt):
                ordered.append(e)
                used[j] = True
                cur_pt = tuple(e["start"])
                break
        else:
            raise ValueError("sweep: path edges do not form a connected chain")
    return ordered


def _world_arc_edge(center: list, start: list, end: list, radius: float):
    """Build a world-space circular arc edge through start -> end about center.

    Picks the minor arc (<=180 degrees); major-arc path segments are not yet
    supported. The rotation plane is derived from the start/end radius vectors,
    so no separate plane normal is needed.
    """
    v0 = [start[i] - center[i] for i in range(3)]
    v1 = [end[i] - center[i] for i in range(3)]
    cross = [
        v0[1] * v1[2] - v0[2] * v1[1],
        v0[2] * v1[0] - v0[0] * v1[2],
        v0[0] * v1[1] - v0[1] * v1[0],
    ]
    cross_mag = math.sqrt(sum(c * c for c in cross))
    if cross_mag < 1e-12:
        raise ValueError("sweep: degenerate or 180-degree arc in path not supported")
    dot = sum(v0[i] * v1[i] for i in range(3))
    angle = math.atan2(cross_mag, dot)  # minor-arc sweep angle in (0, pi)
    normal = [c / cross_mag for c in cross]
    return make_arc_edge(center, radius, normal, v0, 0.0, angle)


def _collect_path_edges(path_ref: str, global_repo: Repository) -> tuple[list, str]:
    """Resolve a sweep path reference to ordered world-space spine edges.

    The path references a sketch whose solved topology edges form a connected
    open or closed chain. Returns (spine_edges, path_sketch_id).
    """
    sketch_id = _path_ref_to_sketch_id(path_ref, global_repo)
    plane = global_repo.elements.get("_pt_" + sketch_id)
    if plane is None:
        raise ValueError(f"sweep: path sketch not found: {sketch_id!r}")
    topo = global_repo.elements.get("_topo_" + sketch_id, {})
    raw_edges = list(topo.get("edges", [])) if topo else []
    if not raw_edges:
        raise ValueError(f"sweep: path sketch {sketch_id!r} has no edges")

    spine_edges = []
    for e in _order_edges_into_chain(raw_edges):
        start_w = _sketch_to_world_2d(e["start"], plane)
        end_w = _sketch_to_world_2d(e["end"], plane)
        if e.get("kind") == "arc" and "center" in e:
            center_w = _sketch_to_world_2d(e["center"], plane)
            spine_edges.append(_world_arc_edge(center_w, start_w, end_w, float(e["radius"])))
        else:
            spine_edges.append(make_line_edge(start_w, end_w))
    return spine_edges, sketch_id
