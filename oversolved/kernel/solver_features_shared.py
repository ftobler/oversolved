from __future__ import annotations

import logging
import math
import re
from typing import Any, Callable, TYPE_CHECKING
import numpy as np

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
    from OCP.gp import gp_Trsf
from oversolved.kernel.query import Repository, _parse_ancestry
from oversolved.kernel.types3d import Body, Frame3D
from oversolved.kernel.solver_constants import _ARC_SEGMENTS, TOL_LOOP_CLOSURE

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
    "_apply_body_operation",
    "_collect_extrude_loops",
    "_extract_loops_from_occ_face",
    "_extract_profile_loops",
    "_register_top_face",
    "_resolve_axis_query",
    "_resolve_body",
    "_resolve_direction",
    "_resolve_direction_query",
    "_resolve_face_index_via_hash",
    "_resolve_face_profile",
    "_resolve_merge_targets",
    "_split_compound",
    "_tessellate_edge",
]


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
) -> list[list[dict]]:
    if not surfaces:
        return []

    TOL = TOL_LOOP_CLOSURE

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
    occ_shape = _ensure_occ(shape)
    if occ_shape.IsNull():
        raise ValueError("_extract_loops_from_occ_face received a null shape")
    import cadquery as cq
    cq_shape = cq.Shape.cast(occ_shape)
    cq_faces_sorted = sorted(list(cq_shape.Faces()), key=_face_sort_key)
    return ocp_extract_face_loops(occ_shape, cq_faces_sorted, face_index)


def _resolve_face_index_via_hash(
    shape: TopoDS_Shape, old_index: int, global_repo: Repository
) -> int | None:
    """Resolve an old sorted face index to the current index via geometry hash.

    Returns None if resolution fails (not a cadquery shape, index out of range,
    tessellation error, or hash not found in repo).
    """
    from oversolved.kernel.geom_hash import face_geometry_hash  # noqa: F811
    from oversolved.kernel.query import make_ancestry_query  # noqa: F811
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
        loops = _extract_profile_loops(surfaces)
        return loops, effective_plane

    if sketch_ref.startswith("?"):
        target_ids, _ = _parse_ancestry(sketch_ref)
        sketch_id = None
        for aid in target_ids:
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
            and _parse_ancestry(s["query"])[0] == target_ids
        ]
        loops = _extract_profile_loops(matched or all_surfaces)
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
    return _extract_profile_loops(surfaces), pt, sketch_id


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

    Guaranteed return keys: "status", "body_id", "operation".
    "body_id" is always present; for a no-op cut (empty store, no target) it
    holds the input body_id since no body was created or modified.

    Merge convention: callers do `feature = {**sub, **feature}` so top-level
    feature keys win over sub-dict keys. This helper receives already-resolved
    values, so no further merging is needed here.
    """
    from oversolved.kernel.types3d import Body  # noqa: F811

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
        from oversolved.kernel.geometry import boolean_cut, boolean_intersection  # noqa: F811
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
        from oversolved.kernel.geometry import boolean_union  # noqa: F811
        fused = False
        fused_body_id = None
        if not need_new_body:
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
