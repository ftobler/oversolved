from __future__ import annotations

import logging
import math
import os
import re
from typing import Any, Callable, TYPE_CHECKING
import numpy as np

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
    from OCP.gp import gp_Trsf
from oversolved.kernel.query import Repository, _parse_ancestry
from oversolved.kernel.types3d import Body, Frame3D
from oversolved.kernel.solver_constants import _ARC_SEGMENTS

try:
    import oversolved.kernel.geometry  # noqa: F401  # pre-warm to avoid concurrent-import race
except ImportError:
    pass
from oversolved.kernel.cadquery_ops import (
    _compute_face_centroid, _compute_face_normal,
    _ensure_cq, _ensure_occ,
    _face_sort_key, _triangle_area,
)
from oversolved.kernel.ocp_ops import (
    ocp_count_solids,
    ocp_curve_info,
    ocp_explore_solids,
    ocp_extract_face_loops,
    ocp_mesh_shape,
)

logger = logging.getLogger(__name__)

__all__ = [
    "_resolve_body",
    "_apply_body_operation",
    "_extract_profile_loops",
    "_solve_extrude",
    "_solve_revolve",
    "_solve_array",
    "_solve_import_step",
    "_solve_fillet",
    "_solve_chamfer",
    "_solve_boolean",
    "_solve_delete_body",
    "_solve_hole",
    "_solve_transform",
    "_solve_mirror",
]


#  ── Topology helpers ──


def _tessellate_edge(edge: dict) -> list[list[float]]:
    """Return ordered 2D [u, v] sample points for a boundary edge (exclusive of start)."""
    kind = edge.get("kind", "line")
    end = edge.get("end")
    if kind == "arc":
        center = edge.get("center", [0, 0])
        radius = edge.get("radius", 1.0)
        a0 = edge.get("angle_start_deg", 0.0)
        a1 = edge.get("angle_end_deg", 360.0)
        ccw = edge.get("ccw", True)
        span = ((a1 - a0) + 360) % 360 if ccw else -(((a0 - a1) + 360) % 360)
        steps = max(4, int(abs(span) / 360 * _ARC_SEGMENTS))
        pts = []
        for i in range(1, steps + 1):
            a = (a0 + span * i / steps) * math.pi / 180
            pts.append(
                [center[0] + radius * math.cos(a), center[1] + radius * math.sin(a)]
            )
        return pts
    if end is not None:
        return [list(end)]
    return []


def _extract_profile_loops(
    surfaces: list[dict],
    plane_transform: Frame3D | dict,
) -> list[list[dict]]:
    if not surfaces:
        return []

    TOL = 1e-6

    def dist2d(a: list, b: list) -> float:
        return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5

    all_loops: list[list[dict]] = []
    for surface in surfaces:
        boundary = surface.get("boundary", [])
        if not boundary:
            continue

        raw_edges = []
        for e in boundary:
            s = e.get("start")
            en = e.get("end")
            if s is not None and en is not None:
                raw_edges.append((s, en, e))
        if len(raw_edges) < 1:
            continue

        used: set[int] = set()
        current = list(raw_edges[0][0])
        loop: list[dict] = []

        for _ in range(len(raw_edges)):
            found_next = False
            for i, (s, e, edict) in enumerate(raw_edges):
                if i in used:
                    continue
                forward = dist2d(current, s) <= TOL
                reverse = dist2d(current, e) <= TOL
                if forward or reverse:
                    if forward:
                        loop.append(edict)
                        current = list(e)
                    else:
                        rev: dict = dict(edict)
                        rev["start"] = list(edict["end"])
                        rev["end"] = list(edict["start"])
                        if edict.get("kind") == "arc":
                            rev["angle_start_deg"] = edict.get("angle_end_deg", 0)
                            rev["angle_end_deg"] = edict.get("angle_start_deg", 0)
                            rev["ccw"] = not edict.get("ccw", True)
                        loop.append(rev)
                        current = list(s)
                    used.add(i)
                    found_next = True
                    break
            if not found_next:
                break
            if dist2d(list(raw_edges[0][0]), current) <= TOL and len(loop) >= 1:
                all_loops.append(loop)
                break

    return all_loops


def _register_top_face(
    global_repo: Repository,
    feature_id: str,
    pt: Frame3D | dict,
    surfaces: list[dict],
    distance: float,
) -> None:
    if isinstance(pt, Frame3D):
        origin = np.array(pt.origin)
        x_axis = np.array(pt.x_axis)
        y_axis = np.array(pt.y_axis)
        normal = np.array(pt.normal)
    else:
        origin = np.array(pt["origin"])
        x_axis = np.array(pt["x_axis"])
        y_axis = np.array(pt["y_axis"])
        normal = np.array(pt["normal"])

    if surfaces:
        pts_2d = []
        for edge in surfaces[0].get("boundary", []):
            for key in ("start", "end"):
                if key in edge:
                    pts_2d.append(edge[key])
        if pts_2d:
            u = sum(p[0] for p in pts_2d) / len(pts_2d)
            v = sum(p[1] for p in pts_2d) / len(pts_2d)
        else:
            u, v = 0.0, 0.0
    else:
        u, v = 0.0, 0.0

    sketch_centroid = origin + u * x_axis + v * y_axis
    top_centroid = sketch_centroid + normal * distance
    top_plane_origin = (origin + normal * distance).tolist()

    global_repo.register(
        feature_id + "/top_face",
        {
            "type": "flatface",
            "centroid": top_centroid.tolist(),
            "normal": normal.tolist(),
            "origin": top_plane_origin,
            "x_axis": x_axis.tolist(),
            "y_axis": y_axis.tolist(),
        },
    )

    if surfaces and surfaces[0].get("boundary"):
        edge = surfaces[0]["boundary"][0]
        if "start" in edge and "end" in edge:
            s2d, e2d = edge["start"], edge["end"]
            s3d = (
                origin + s2d[0] * x_axis + s2d[1] * y_axis + normal * distance
            ).tolist()
            e3d = (
                origin + e2d[0] * x_axis + e2d[1] * y_axis + normal * distance
            ).tolist()
            global_repo.register(
                feature_id + "/top_face/edge0",
                {
                    "type": "straightedge",
                    "start": s3d,
                    "end": e3d,
                },
            )


def _extract_loops_from_occ_face(
    shape: TopoDS_Shape, face_index: int
) -> tuple[list[list[dict]], Frame3D]:
    import cadquery as cq
    cq_shape = cq.Shape.cast(_ensure_occ(shape))
    cq_faces_sorted = sorted(list(cq_shape.Faces()), key=_face_sort_key)
    return ocp_extract_face_loops(_ensure_occ(shape), cq_faces_sorted, face_index)


def _resolve_face_index_via_hash(
    shape: TopoDS_Shape, old_index: int, global_repo: Repository
) -> int | None:
    """Resolve an old sorted face index to the current index via geometry hash.

    Returns None if resolution fails (not a cadquery shape, index out of range,
    tessellation error, or hash not found in repo).
    """
    from oversolved.kernel.geom_hash import face_geometry_hash
    from oversolved.kernel.query import make_ancestry_query
    import cadquery as cq

    cq_shape = cq.Shape.cast(shape)
    faces = list(cq_shape.Faces())

    faces.sort(key=_face_sort_key)
    if old_index >= len(faces):
        return None

    target_face = faces[old_index]
    centroid = _compute_face_centroid(target_face)
    normal = _compute_face_normal(target_face)

    try:
        ocp_mesh_shape(_ensure_occ(shape), 0.1, 0.1)
        verts, idxs = target_face.tessellate(0.1)
    except Exception as exc:
        logger.warning("face hash resolution: tessellation failed: %s", exc)
        return None

    flat_verts = [list(v.toTuple()) for v in verts]
    area = sum(
        _triangle_area(flat_verts[tri[0]], flat_verts[tri[1]], flat_verts[tri[2]])
        for tri in idxs
    )

    geom_hash = face_geometry_hash(centroid, normal, area)
    try:
        query_str = make_ancestry_query([f"@{geom_hash}"], "face")
        face_entry = global_repo.query(query_str, body_store={})
        if face_entry and "face_index" in face_entry:
            return face_entry["face_index"]
    except Exception as exc:
        logger.warning("face hash resolution: query failed: %s", exc)
    return None


def _resolve_face_profile(
    sketch_ref: str, global_repo: Repository, body_store: dict
) -> tuple[list[list[dict]], Frame3D | dict]:
    def _find_body_for_feature(feat_id: str):
        body = body_store.get("body_" + feat_id)
        if body is not None and body.shape is not None:
            return body
        return next(
            (
                b for b in body_store.values()
                if getattr(b, "created_by", None) == feat_id and getattr(b, "shape", None) is not None
            ),
            None,
        )

    slash_match = re.fullmatch(r"@([^/]+)/face/(\d+)", sketch_ref)
    if slash_match:
        feat_id = slash_match.group(1)
        face_index = int(slash_match.group(2))
        body = _find_body_for_feature(feat_id)
        if body is None:
            raise ValueError(f"No body found for feature {feat_id!r}")
        resolved_face_index = _resolve_face_index_via_hash(
            body.shape, face_index, global_repo
        )
        if resolved_face_index is not None:
            face_index = resolved_face_index
        return _extract_loops_from_occ_face(body.shape, face_index)

    face_entry = global_repo.query(sketch_ref, body_store=body_store)
    if face_entry is None:
        raise ValueError(f"Profile face not found: {sketch_ref!r}")

    body_id = face_entry.get("body_id")
    face_index = face_entry.get("face_index")
    if body_id is not None and face_index is not None:
        body = body_store.get(body_id)
        if body is None or body.shape is None:
            raise ValueError(f"Body {body_id!r} not found or has no shape")
        return _extract_loops_from_occ_face(body.shape, face_index)

    if sketch_ref.startswith("@"):
        feat_id = sketch_ref[1:].split("/")[0]
        body = _find_body_for_feature(feat_id)
        if body is None:
            raise ValueError(f"No body found for feature {feat_id!r}")
        topo = global_repo.elements.get("_topo_" + body.sketch_id, {})
        surfaces = topo.get("surfaces", []) if topo else []
        effective_plane = {
            "origin": face_entry.get("origin", [0, 0, 0]),
            "x_axis": face_entry.get("x_axis", [1, 0, 0]),
            "y_axis": face_entry.get("y_axis", [0, 1, 0]),
            "normal": face_entry.get("normal", [0, 0, 1]),
        }
        sketch_pt = global_repo.elements.get("_pt_" + body.sketch_id) or effective_plane
        loops = _extract_profile_loops(surfaces, sketch_pt)
        return loops, effective_plane

    if sketch_ref.startswith("?"):
        ids, _ = _parse_ancestry(sketch_ref)
        target_set = frozenset(ids)
        sketch_id = None
        for aid in ids:
            if aid.startswith("@"):
                candidate = aid[1:]
                if global_repo.elements.get("_pt_" + candidate) is not None:
                    sketch_id = candidate
                    break
        if sketch_id is None:
            raise ValueError(
                f"Cannot find parent sketch for surface query: {sketch_ref!r}"
            )
        pt_raw = global_repo.elements.get("_pt_" + sketch_id)
        if pt_raw is None:
            raise ValueError(f"Sketch plane not found for: {sketch_id!r}")
        surface_pt: dict = pt_raw
        topo = global_repo.elements.get("_topo_" + sketch_id, {})
        all_surfaces = topo.get("surfaces", []) if topo else []

        matched = [
            s for s in all_surfaces
            if s.get("query", "").startswith("?")
            and frozenset(_parse_ancestry(s["query"])[0]) == target_set
        ]
        loops = _extract_profile_loops(matched or all_surfaces, surface_pt)
        return loops, surface_pt

    raise ValueError(f"Cannot resolve profile from: {sketch_ref!r}")


# ── Extrude/revolve helpers ──


def _resolve_direction(
    normal: list, pt: Frame3D | dict, direction: str, distance: float
) -> tuple[list, float, Frame3D | dict]:
    if isinstance(pt, Frame3D):
        if direction == "reverse":
            direction_vec = [-n for n in normal]
            return direction_vec, distance, pt
        elif direction == "symmetric":
            direction_vec = list(normal)
            shift_val = [-n * distance / 2 for n in normal]
            shifted = Frame3D(
                origin=[pt.origin[0] + shift_val[0], pt.origin[1] + shift_val[1], pt.origin[2] + shift_val[2]],
                x_axis=pt.x_axis, y_axis=pt.y_axis, normal=pt.normal,
            )
            return direction_vec, distance, shifted
        else:
            return list(normal), distance, pt
    if direction == "reverse":
        direction_vec = [-n for n in normal]
        return direction_vec, distance, pt
    elif direction == "symmetric":
        direction_vec = list(normal)
        shift = [-n * distance / 2 for n in normal]
        shifted_origin = [
            pt["origin"][0] + shift[0],
            pt["origin"][1] + shift[1],
            pt["origin"][2] + shift[2],
        ]
        effective_plane = {
            "origin": shifted_origin,
            "x_axis": pt["x_axis"],
            "y_axis": pt["y_axis"],
            "normal": pt["normal"],
        }
        return direction_vec, distance, effective_plane
    else:
        return list(normal), distance, pt


def _collect_extrude_loops(
    sketch_ref: str,
    feature_id: str,
    feature: dict,
    distance: float,
    global_repo: Repository,
    body_store: dict,
) -> tuple[list, Frame3D | dict, str]:
    pt: Frame3D | dict
    if sketch_ref.startswith("?") or sketch_ref.startswith("@"):
        loops, pt = _resolve_face_profile(sketch_ref, global_repo, body_store)
        return loops, pt, ""
    sketch_id = sketch_ref.lstrip("$")
    pt_raw = global_repo.elements.get("_pt_" + sketch_id)
    if pt_raw is None:
        raise ValueError(f"sketch not found: {sketch_id!r}")
    pt = pt_raw
    topo = global_repo.elements.get("_topo_" + sketch_id, {})
    surfaces = topo.get("surfaces", []) if topo else []
    _register_top_face(global_repo, feature_id, pt, surfaces, distance)
    return _extract_profile_loops(surfaces, pt), pt, sketch_id


def _split_compound(shape: TopoDS_Shape) -> list[TopoDS_Shape]:
    raw_solids = ocp_explore_solids(_ensure_occ(shape))
    if len(raw_solids) > 1:
        return raw_solids
    return [_ensure_occ(shape)]


# ── Feature solvers ──


def _resolve_body(ref: str, body_store: dict) -> Body:
    """Resolve a body reference to a Body object.

    Accepts "@feat", "feat", or "body_feat" forms.
    Raises ValueError if no matching body is found.
    """
    key = ref.lstrip("@")
    if key in body_store:
        return body_store[key]
    prefixed = "body_" + key
    if prefixed in body_store:
        return body_store[prefixed]
    for body in body_store.values():
        if body.created_by == key:
            return body
    raise ValueError(f"body not found for ref '{ref}'")


def _resolve_merge_targets(merge_target: str | None, body_store: dict) -> list[str]:
    """Return list of body IDs to operate on.
    None / empty means ALL bodies. Otherwise resolve the ref to one body."""
    if not merge_target:
        return list(body_store.keys())
    key = merge_target.lstrip("@")
    if key in body_store:
        return [key]
    prefixed = "body_" + key
    if prefixed in body_store:
        return [prefixed]
    for bid, body in body_store.items():
        if body.created_by == key:
            return [bid]
    raise ValueError(f"extrude: body not found for merge_target '{merge_target}'")


def _apply_body_operation(
    tool_shape: "Any",
    body_store: dict,
    operation: str,
    merge_target: "str | None",
    body_id: str,
    feature_id: str,
    sketch_id: str,
    op_name: str = "",
) -> dict:
    """Apply a boolean body operation (add / cut / new) using tool_shape.

    Called by both _solve_extrude and _solve_revolve after tool shape creation.
    Raises ValueError for user-facing errors; callers catch and record status.

    Merge convention: callers do `feature = {**sub, **feature}` so top-level
    feature keys win over sub-dict keys. This helper receives already-resolved
    values, so no further merging is needed here.
    """
    from oversolved.kernel.types3d import Body

    result: dict = {"status": "ok", "body_id": body_id}

    if operation in ("add", "cut"):
        target_ids = _resolve_merge_targets(merge_target, body_store)
        if not target_ids and not merge_target and operation == "add":
            need_new_body = True
        else:
            need_new_body = False
            if not target_ids and not merge_target and operation == "cut":
                # No bodies exist and no target specified: silently succeed.
                result["operation"] = "cut"
                return result
            if not target_ids:
                raise ValueError(
                    f"{op_name}: merge target '{merge_target}' not found"
                )
    else:
        need_new_body = False
        target_ids = []

    if operation == "cut":
        from oversolved.kernel.geometry import boolean_cut, boolean_intersection
        cut_anything = False
        cut_body_id = None
        for bid in target_ids:
            existing_body = body_store[bid]
            if existing_body.shape is None:
                continue
            try:
                intersection = boolean_intersection(existing_body.shape, tool_shape)
                if intersection.Volume() < 1e-10:
                    continue
            except Exception:
                continue
            new_shape = boolean_cut(existing_body.shape, tool_shape)
            existing_body.shape = _ensure_occ(new_shape)
            existing_body.modified_by.append(feature_id)
            cut_anything = True
            if cut_body_id is None:
                cut_body_id = bid
        if not cut_anything:
            raise ValueError(
                f"{op_name}: cut does not intersect any target body "
                "- nothing to remove"
            )
        result["body_id"] = cut_body_id
        result["operation"] = "cut"
    elif operation == "new":
        solids = _split_compound(tool_shape)
        body_ids = []
        for i, solid in enumerate(solids):
            bid = body_id if i == 0 else f"{body_id}_{i}"
            b = Body(id=bid, created_by=feature_id, shape=_ensure_occ(solid),
                     sketch_id=sketch_id)
            body_store[bid] = b
            body_ids.append(bid)
        result["body_id"] = body_ids[0]
        result["body_ids"] = body_ids
        result["operation"] = "new"
    else:
        from oversolved.kernel.geometry import boolean_union
        if need_new_body:
            fused = False
            fused_body_id = None
        else:
            fused = False
            fused_body_id = None
            for bid in target_ids:
                existing_body = body_store[bid]
                if existing_body.shape is None:
                    continue
                try:
                    new_shape = boolean_union(existing_body.shape, tool_shape)
                except Exception as exc:
                    raise ValueError(f"{op_name}: add operation failed: {exc}")
                if merge_target:
                    if ocp_count_solids(_ensure_occ(new_shape)) > 1:
                        raise ValueError(
                            f"{op_name}: add would create island shape "
                            "not touching target body"
                        )
                existing_body.shape = _ensure_occ(new_shape)
                existing_body.modified_by.append(feature_id)
                fused = True
                fused_body_id = bid
                break
        if fused:
            result["body_id"] = fused_body_id
            result["body_ids"] = [fused_body_id]
            result["operation"] = "add"
        elif not need_new_body:
            raise ValueError(f"{op_name}: add could not fuse with any target body")
        else:
            solids = _split_compound(tool_shape)
            body_ids = []
            for i, solid in enumerate(solids):
                bid = body_id if i == 0 else f"{body_id}_{i}"
                b = Body(id=bid, created_by=feature_id, shape=solid,
                         sketch_id=sketch_id)
                body_store[bid] = b
                body_ids.append(bid)
            result["body_id"] = body_ids[0]
            result["body_ids"] = body_ids
            result["operation"] = "add"

    return result


def _solve_extrude(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    from oversolved.kernel.geometry import extrude_profile as _ep

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
    from oversolved.kernel.geometry import sketch_loops_to_face, revolve_face as _rf

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
            from oversolved.kernel.geometry import boolean_union
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


def _resolve_direction_query(query: str, global_repo: Repository, fallback: list[float], body_store: dict | None = None) -> list[float]:
    if not query:
        return fallback
    data = global_repo.query(query, body_store=body_store)
    if data and "start" in data and "end" in data:
        start = data["start"]
        end = data["end"]
        d = [end[k] - start[k] for k in range(3)]
        length = math.sqrt(sum(v * v for v in d))
        if length > 1e-12:
            return [v / length for v in d]
    return fallback


def _resolve_axis_query(
    query: str,
    global_repo: Repository,
    fallback_origin: list[float],
    fallback_direction: list[float],
    body_store: dict | None = None,
) -> tuple[list[float], list[float]]:
    if not query:
        return fallback_origin, fallback_direction
    data = global_repo.query(query, body_store=body_store)
    if data and "start" in data and "end" in data:
        start = data["start"]
        end = data["end"]
        axis_origin = list(start)
        d = [end[k] - start[k] for k in range(3)]
        length = math.sqrt(sum(v * v for v in d))
        if length > 1e-12:
            return axis_origin, [v / length for v in d]
    return fallback_origin, fallback_direction


def _build_array_transforms(
    feature: dict,
    global_repo: Repository,
) -> list[gp_Trsf]:
    from oversolved.kernel.geometry import make_translation_trsf, make_rotation_trsf

    mode = feature.get("mode", "linear")
    trsfs: list[gp_Trsf] = []

    if mode == "linear":
        count_x = int(feature.get("count_x", 2))
        pitch_x = float(feature.get("pitch_x", 10.0))
        dir_x = _resolve_direction_query(
            feature.get("direction_x_query", ""),
            global_repo,
            feature.get("direction_x", [1, 0, 0]),
        )
        for i in range(count_x):
            trsf = make_translation_trsf(dir_x[0] * pitch_x * i, dir_x[1] * pitch_x * i, dir_x[2] * pitch_x * i)
            trsfs.append(trsf)

    elif mode == "rectangular":
        count_x = int(feature.get("count_x", 2))
        count_y = int(feature.get("count_y", 2))
        pitch_x = float(feature.get("pitch_x", 10.0))
        pitch_y = float(feature.get("pitch_y", 10.0))
        dir_x = _resolve_direction_query(
            feature.get("direction_x_query", ""),
            global_repo,
            feature.get("direction_x", [1, 0, 0]),
        )
        dir_y = _resolve_direction_query(
            feature.get("direction_y_query", ""),
            global_repo,
            feature.get("direction_y", [0, 1, 0]),
        )
        for j in range(count_y):
            for i in range(count_x):
                trsf = make_translation_trsf(
                    dir_x[0] * pitch_x * i + dir_y[0] * pitch_y * j,
                    dir_x[1] * pitch_x * i + dir_y[1] * pitch_y * j,
                    dir_x[2] * pitch_x * i + dir_y[2] * pitch_y * j,
                )
                trsfs.append(trsf)

    elif mode == "rotational":
        count = int(feature.get("count", 4))
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
        )
        for i in range(count):
            trsf = make_rotation_trsf(axis_origin, axis_direction, math.radians(step * i))
            trsfs.append(trsf)

    return trsfs


def _solve_array(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.types3d import Body
    from oversolved.kernel.geometry import transform_copy, fuse_shapes

    feature_id = feature.get("id", "")
    sub = feature.get("array") or {}
    feature = {**sub, **feature}

    source_body_ref = feature.get("source_body", "")
    if source_body_ref:
        try:
            body = _resolve_body(source_body_ref, body_store)
        except ValueError:
            available = list(body_store.keys())
            raise ValueError(
                f"array: source body '{source_body_ref}' not found; "
                f"available body IDs: {available}"
            )
    else:
        _body_or_none = next(iter(body_store.values())) if body_store else None
        if _body_or_none is None:
            raise ValueError("array: no source body with shape found")
        body = _body_or_none
    source_body_id = body.id
    if body.shape is None:
        raise ValueError("array: source body has no shape")

    include_source = bool(feature.get("include_source", True))
    operation = feature.get("operation", "add")

    trsfs = _build_array_transforms(feature, global_repo)

    instances: list = []
    for i, trsf in enumerate(trsfs):
        if i == 0 and include_source:
            instances.append(body.shape)
        else:
            instances.append(transform_copy(body.shape, trsf))

    if not instances:
        raise ValueError("array produced no instances")

    tool_shape = fuse_shapes(instances)

    result_body_id = "body_" + feature_id
    if operation == "new":
        new_body = Body(
            id=result_body_id,
            created_by=feature_id,
            shape=_ensure_occ(tool_shape),
            sketch_id="",
        )
        body_store[result_body_id] = new_body
        return {"status": "ok", "body_id": result_body_id, "operation": "new"}
    else:
        body.shape = _ensure_occ(tool_shape)
        body.modified_by.append(feature_id)
        return {"status": "ok", "body_id": source_body_id, "operation": "add"}


def _solve_import_step(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    import base64
    import tempfile
    from oversolved.kernel.types3d import Body
    from oversolved.kernel.geometry import step_file_to_shape

    feature_id = feature.get("id", "")
    file_data_b64 = feature.get("file_data", "")
    scale = float(feature.get("scale", 1.0))

    if not file_data_b64:
        raise ValueError("import_step requires 'file_data'")

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


def _resolve_fillet_edges(body: Body, edge_queries: list[str]) -> list[TopoDS_Shape]:
    from oversolved.kernel.geom_hash import edge_geometry_hash
    from oversolved.kernel.query import make_ancestry_query, _parse_ancestry

    if body.shape is None or not edge_queries:
        return []

    seen_hashes = set()
    topo_edges = []
    edge_types = []
    edge_dicts = []
    for edge in _ensure_cq(body.shape).Edges():
        h = edge.hashCode()
        if h in seen_hashes:
            continue
        seen_hashes.add(h)
        wrapped = edge.wrapped
        topo_edges.append(wrapped)
        gt = edge.geomType()
        edge_types.append("straightedge" if gt == "LINE" else "edge")

        curve = ocp_curve_info(wrapped)
        ed: dict = {"kind": gt.lower()}
        if curve["type"] == "line":
            sp = edge.startPoint()  # type: ignore[attr-defined]
            ep = edge.endPoint()  # type: ignore[attr-defined]
            ed["start"] = [sp.x, sp.y, sp.z]
            ed["end"] = [ep.x, ep.y, ep.z]
        elif curve["type"] == "circle":
            ed["center"] = curve["center"]
            ed["radius"] = curve["radius"]
            ed["angle_start"] = curve["angle_start"]
            ed["angle_end"] = curve["angle_end"]
        else:
            n_pts = 16
            pts = []
            for i in range(n_pts + 1):
                pt = edge.positionAt(i / n_pts)  # type: ignore[attr-defined]
                pts.append([pt.x, pt.y, pt.z])
            ed["points"] = pts
        edge_dicts.append(ed)

    query_to_edge = {}
    for idx, (te, et, ed) in enumerate(zip(topo_edges, edge_types, edge_dicts)):
        if body.created_by:
            geom_hash = edge_geometry_hash(ed)
            aq_hash = make_ancestry_query(
                [f"@{geom_hash}", f"@{body.created_by}", f"@{body.id}"], et
            )
            query_to_edge[aq_hash] = te

            aq = make_ancestry_query(
                [f"@{body.created_by}edge{idx}", f"@{body.created_by}"], et
            )
            query_to_edge[aq] = te
            aq3 = make_ancestry_query(
                [f"@{body.id}edge{idx}", f"@{body.created_by}", f"@{body.id}"], et
            )
            query_to_edge[aq3] = te
        query_to_edge[f"?{body.id}:edge:{idx}"] = te

    result: list[TopoDS_Shape] = []
    for q in edge_queries:
        edge = query_to_edge.get(q)  # type: ignore[assignment]
        if edge is None and q.startswith("?"):
            try:
                ids, _ = _parse_ancestry(q)
                for id_str in ids:
                    m = re.match(r"@([^@]+)edge(\d+)$", id_str)
                    if m:
                        eidx = int(m.group(2))
                        if 0 <= eidx < len(topo_edges):
                            edge = topo_edges[eidx]
                            break
            except Exception as exc:
                logger.warning("fillet edge index resolution failed for query %s: %s", q, exc)
        if edge is None and q.startswith("?"):
            try:
                ids, type_restriction = _parse_ancestry(q)
                body_id_from_query = None
                for id_str in ids:
                    if id_str.startswith("@body_"):
                        body_id_from_query = id_str[1:]
                        break
                if body_id_from_query and body_id_from_query == body.id:
                    matched = [
                        te for te, et in zip(topo_edges, edge_types)
                        if type_restriction is None or et == type_restriction
                    ]
                    if matched:
                        edge = matched[0]
                        logger.warning(
                            "Resolved fillet edge via body-scoped type fallback: "
                            "query=%s body=%s matched_type=%s",
                            q, body.id, edge_types[topo_edges.index(edge)] if edge in topo_edges else "?",
                        )
            except Exception as exc:
                logger.warning("fillet edge body-scoped fallback failed for query %s: %s", q, exc)
        if edge is not None:
            result.append(edge)

    return result


def _solve_transform(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.cadquery_ops import apply_transform_shape
    from oversolved.kernel.types3d import Body
    from oversolved.kernel.solver_plane import _get_point_3d, _get_edge_3d

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


def _apply_edge_feature(
    feature: dict,
    body_store: dict,
    feature_kind: str,
    geometry_fn: Callable[..., TopoDS_Shape],
    **geometry_kwargs: Any,
) -> dict:
    """Shared body-resolution and edge-application logic for fillet and chamfer.

    Raises ValueError for user-facing errors; callers wrap in try/except.
    """
    feature_id = feature.get("id", "")
    edges: list[str] = feature.get("edges", [])
    if not edges:
        raise ValueError(f"{feature_kind} requires at least one edge")

    source_body = feature.get("source_body", "")
    if source_body:
        body = _resolve_body(source_body, body_store)
    else:
        if not body_store:
            raise ValueError(f"no body found for {feature_kind}")
        body = next(iter(body_store.values()))
    body_id = body.id

    if body.shape is None:
        raise ValueError(f"body {body_id} has no shape")

    # Validate the shape before passing to OCC; a corrupted shape
    # can cause SIGSEGV inside the fillet/chamfer kernel.
    try:
        if _ensure_occ(body.shape).IsNull():
            raise ValueError(f"body {body_id} shape is null")
    except Exception:
        raise ValueError(f"body {body_id} shape is invalid")

    topo_edges = _resolve_fillet_edges(body, edges)
    if not topo_edges:
        raise ValueError(f"no edges resolved for {feature_kind}")

    new_shape = geometry_fn(body.shape, edges=topo_edges, **geometry_kwargs)
    body.shape = new_shape
    body.modified_by.append(feature_id)

    return {"status": "ok", "body_id": body_id}


def _solve_fillet(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.geometry import apply_fillet

    sub = feature.get("fillet") or {}
    feature = {**sub, **feature}
    radius_raw = feature.get("radius")
    radius = float(radius_raw if radius_raw is not None else 1.0)
    if radius <= 0:
        raise ValueError("fillet radius must be positive")
    return _apply_edge_feature(feature, body_store, "fillet", apply_fillet, radius=radius)


def _solve_chamfer(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.geometry import apply_chamfer

    sub = feature.get("chamfer") or {}
    feature = {**sub, **feature}
    distance_raw = feature.get("distance")
    distance = float(distance_raw if distance_raw is not None else 1.0)
    kind = feature.get("kind", "distance")
    angle_raw = feature.get("angle")
    angle = float(angle_raw if angle_raw is not None else 45.0)
    if distance <= 0:
        raise ValueError("chamfer distance must be positive")
    return _apply_edge_feature(
        feature, body_store, "chamfer", apply_chamfer,
        distance=distance, kind=kind, angle=angle,
    )


def _solve_boolean(
    feature: dict,
    global_repo: Repository,
    body_store: dict,
) -> dict:
    from oversolved.kernel.cadquery_ops import boolean_cut, boolean_union, boolean_intersection

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


def _solve_mirror(feature: dict, global_repo: Repository, body_store: dict) -> dict:
    from oversolved.kernel.types3d import Body
    from oversolved.kernel.geometry import transform_copy, boolean_union
    from oversolved.kernel.cadquery_ops import make_mirror_trsf

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

    trsf = make_mirror_trsf((float(origin[0]), float(origin[1]), float(origin[2])), (float(normal[0]), float(normal[1]), float(normal[2])))
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


def _solve_hole(feature: dict, global_repo: Repository, body_store: dict, features_by_id: dict[str, dict]) -> dict:
    import numpy as np
    from oversolved.kernel.cadquery_ops import make_cylinder, boolean_cut

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
