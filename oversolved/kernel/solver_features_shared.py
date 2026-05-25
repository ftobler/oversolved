from __future__ import annotations

import logging
import math
import re
from typing import Any, TYPE_CHECKING
import numpy as np

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
from oversolved.kernel.query import Repository, _parse_ancestry, make_ancestry_query, ref
from oversolved.kernel.types3d import Body, Frame3D
from oversolved.kernel.geom_hash import face_geometry_hash
from oversolved.kernel.profile_loops import _loop_centroid
from oversolved.kernel.solver_constants import _ARC_SEGMENTS, TOL_LOOP_CLOSURE

try:
    import oversolved.kernel.geometry_tessellation  # noqa: F401  # pre-warm to avoid concurrent-import race
except ImportError:
    pass
from oversolved.kernel.cadquery_ops import (
    _compute_face_centroid, _compute_face_normal,
    _ensure_occ,
    _face_sort_key, _triangle_area,
    boolean_cut_with_diff, boolean_intersection, boolean_union_with_diff,
)
from oversolved.kernel.ocp_ops import (
    ocp_count_solids,
    ocp_explore_solids,
    ocp_extract_face_loops,
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

    boundary = surfaces[0].get("boundary", []) if surfaces else []
    u, v = _loop_centroid(boundary)

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
) -> tuple[list[list[dict]], Frame3D, Any]:
    occ_shape = _ensure_occ(shape)
    if occ_shape.IsNull():
        raise ValueError("_extract_loops_from_occ_face received a null shape")
    import cadquery as cq
    cq_shape = cq.Shape.cast(occ_shape)
    cq_faces_sorted = sorted(list(cq_shape.Faces()), key=_face_sort_key)
    cq_face = cq_faces_sorted[face_index]
    loops, frame = ocp_extract_face_loops(occ_shape, cq_faces_sorted, face_index)
    return loops, frame, cq_face


def _resolve_face_index_via_hash(
    shape: TopoDS_Shape, old_index: int, global_repo: Repository
) -> int | None:
    """Resolve an old sorted face index to the current index via geometry hash.

    Returns None if resolution fails (not a cadquery shape, index out of range,
    tessellation error, or hash not found in repo).
    """
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
        verts, idxs = target_face.tessellate(0.1, 0.1)
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
        query_str = make_ancestry_query([ref(geom_hash)], "face")
        face_entry = global_repo.query(query_str, body_store={})
        if face_entry and "face_index" in face_entry:
            return face_entry["face_index"]
    except Exception as exc:
        logger.warning("face hash resolution: query failed: %s", exc)
    return None


def _resolve_face_profile(
    sketch_ref: str, global_repo: Repository, body_store: dict
) -> tuple[list[list[dict]], Frame3D | dict, Any]:

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
        loops, frame, cq_face = _extract_loops_from_occ_face(body.shape, face_index)
        return loops, frame, cq_face

    face_entry = global_repo.query(sketch_ref, body_store=body_store)
    if face_entry is None:
        raise ValueError(f"Profile face not found: {sketch_ref!r}")

    body_id = face_entry.get("body_id")
    face_index = face_entry.get("face_index")
    if body_id is not None and face_index is not None:
        body = body_store.get(body_id)
        if body is None or body.shape is None:
            raise ValueError(f"Body {body_id!r} not found or has no shape")
        loops, frame, cq_face = _extract_loops_from_occ_face(body.shape, face_index)
        return loops, frame, cq_face

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
        return loops, effective_plane, None

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
        return loops, surface_pt, None

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
) -> tuple[list, Frame3D | dict, str, Any]:
    pt: Frame3D | dict
    if sketch_ref.startswith("?") or sketch_ref.startswith("@"):
        sketch_id = ""
        if sketch_ref.startswith("?"):
            target_ids, _ = _parse_ancestry(sketch_ref)
            for aid in target_ids:
                if aid.startswith("@") and "/" not in aid:
                    candidate = aid[1:]
                    if global_repo.elements.get("_pt_" + candidate) is not None:
                        sketch_id = candidate
                        break
        elif sketch_ref.startswith("@"):
            sketch_id = sketch_ref[1:].split("/")[0]
        loops, pt, cq_face = _resolve_face_profile(sketch_ref, global_repo, body_store)
        return loops, pt, sketch_id, cq_face
    sketch_id = sketch_ref.lstrip("$")
    pt_raw = global_repo.elements.get("_pt_" + sketch_id)
    if pt_raw is None:
        raise ValueError(f"sketch not found: {sketch_id!r}")
    pt = pt_raw
    topo = global_repo.elements.get("_topo_" + sketch_id, {})
    surfaces = topo.get("surfaces", []) if topo else []
    _register_top_face(global_repo, feature_id, pt, surfaces, distance)
    return _extract_profile_loops(surfaces), pt, sketch_id, None


def _split_compound(shape: TopoDS_Shape) -> list[TopoDS_Shape]:
    raw_solids = ocp_explore_solids(_ensure_occ(shape))
    if len(raw_solids) > 1:
        return raw_solids
    return [_ensure_occ(shape)]

# ── Feature solvers ──


def _resolve_body(ref: str, body_store: dict) -> Body:
    """Resolve a body reference to a Body object.

    Accepts "@feat", "feat", "body_feat", viewport selection formats
    ("face:feature_id:...", "entity:sketch_id:entity_id", "body:body_id",
    "edge:...", "vertex:..."), and ancestry queries ("?...:flatface").
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
    # Handle ? ancestry queries — extract @body_* ancestors
    if ref.startswith("?"):
        try:
            from oversolved.kernel.query import _parse_ancestry
            ids, _ = _parse_ancestry(ref)
            for aid in ids:
                if aid.startswith("@body_"):
                    bid = aid[1:]
                    if bid in body_store:
                        return body_store[bid]
        except Exception:
            pass
    # Handle viewport selection prefixes: face:feature_id:..., entity:sk_id:eid, etc.
    if ":" in ref:
        parts = ref.split(":")
        if len(parts) >= 2:
            candidate = parts[1]
            if candidate in body_store:
                return body_store[candidate]
            body_prefixed = "body_" + candidate
            if body_prefixed in body_store:
                return body_store[body_prefixed]
            for body in body_store.values():
                if body.created_by == candidate:
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


def _brep_diff_is_empty(diff: "Any") -> bool:
    """Return True if a BrepDiff has no geometry changes (no new, deleted, or modified shapes)."""
    if diff is None:
        return False
    return (
        not diff.new_faces
        and not diff.deleted_input_faces
        and not diff.modified_input_faces
        and not diff.new_edges
        and not diff.deleted_input_edges
        and not diff.modified_input_edges
    )


def _transfer_boolean_lineage(
    body: Body,
    old_target_shape: "Any",
    tool_shape: "Any",
    tool_face_lineage: dict[str, list[str]] | None,
    tool_edge_lineage: dict[str, list[str]] | None,
) -> None:
    """Rebuild face_lineage and edge_lineage on body after a boolean op.

    Pre-boolean, the target body (old_target_shape) and tool shape have
    per-entity lineage tokens in body.face_lineage / tool_face_lineage.
    After the boolean, OCC shape handles change so those dict keys are stale.

    Strategy:
    - Build geometric signatures (centroid + normal + area) for all faces
      in both pre-boolean shapes, together with their lineage tokens.
    - For each output face classified as inherited in body.brep_diff, find
      the best geometric match among old_target_shape faces and copy tokens.
    - For each output face classified as new, do the same against tool faces.
    - Rebuild edge_lineage from face_lineage via edge→face adjacency.
    """
    import cadquery.occ_impl.shapes as cq_shapes  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer, TopExp  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape  # noqa: PLC0415
    from oversolved.kernel.ocp_ops import ocp_face_area  # noqa: PLC0415

    diff = body.brep_diff
    if diff is None:
        return

    def _face_geometry_list(occ_shape: "Any") -> list:
        """Return [(topo_face, centroid3, area, normal3), ...] for all faces."""
        result: list = []
        exp = TopExp_Explorer(occ_shape, TopAbs_FACE)
        while exp.More():
            f = exp.Current()
            cq_f = cq_shapes.Shape.cast(f)
            c = list(_compute_face_centroid(cq_f))
            n = list(_compute_face_normal(cq_f))
            a = ocp_face_area(f)
            result.append((f, c, a, n))
            exp.Next()
        return result

    target_face_list = _face_geometry_list(old_target_shape)
    tool_face_list = _face_geometry_list(tool_shape) if tool_shape is not None else []

    def _lineage_tokens(f: "Any", lineage_dict: dict[str, list[str]] | None) -> list[str] | None:
        if lineage_dict is None:
            return None
        return lineage_dict.get(str(hash(f)))

    def _face_geom_key(c: list, a: float, n: list) -> tuple:
        return (round(c[0], 6), round(c[1], 6), round(c[2], 6),
                round(a, 6),
                round(n[0], 6), round(n[1], 6), round(n[2], 6))

    def _find_best_face_match(face: "Any", candidate_list: list) -> "Any | None":
        """Find closest geometric match to face among candidates."""
        if not candidate_list:
            return None
        cq_f = cq_shapes.Shape.cast(face)
        fc = list(_compute_face_centroid(cq_f))
        fn = list(_compute_face_normal(cq_f))
        fa = ocp_face_area(face)
        best = None
        best_score = float("inf")
        for cf, cc, ca, cn in candidate_list:
            dc = sum((fc[i] - cc[i]) ** 2 for i in range(3)) ** 0.5
            ar = abs(fa - ca) / max(fa, ca, 1e-12)
            dn = 1.0 - abs(sum(fn[i] * cn[i] for i in range(3)))
            score = dc + 0.01 * ar + 0.001 * dn
            if score < best_score:
                best_score = score
                best = cf
        # Only return a match if geometry is virtually identical.
        if best is not None and best_score < 1.0:
            return best
        return None

    new_face_lineage: dict[str, list[str]] = {}

    # Inherited faces: match against target body's pre-boolean faces.
    if diff.inherited_faces and body.face_lineage:
        for output_face in diff.inherited_faces:
            src = _find_best_face_match(output_face, target_face_list)
            if src is not None:
                tokens = _lineage_tokens(src, body.face_lineage)
                if tokens:
                    new_face_lineage[str(hash(output_face))] = tokens

    # New faces: match against tool shape's faces.
    if diff.new_faces and tool_face_lineage:
        for output_face in diff.new_faces:
            src = _find_best_face_match(output_face, tool_face_list)
            if src is not None:
                tokens = _lineage_tokens(src, tool_face_lineage)
                if tokens:
                    new_face_lineage[str(hash(output_face))] = tokens

    body.face_lineage = new_face_lineage

    # Rebuild edge_lineage from face_lineage via edge→face adjacency.
    if body.shape is not None:
        e2f = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(body.shape, TopAbs_EDGE, TopAbs_FACE, e2f)
        new_edge_lineage: dict[str, list[str]] = {}
        edge_exp = TopExp_Explorer(body.shape, TopAbs_EDGE)
        while edge_exp.More():
            se = edge_exp.Current()
            sh = str(hash(se))
            eids: list[str] = []
            seen: set[str] = set()
            for face in e2f.FindFromKey(se):
                fh = str(hash(face))
                for eid in new_face_lineage.get(fh, []):
                    if eid not in seen:
                        seen.add(eid)
                        eids.append(eid)
            if eids:
                new_edge_lineage[sh] = eids
            edge_exp.Next()
        body.edge_lineage = new_edge_lineage


def _apply_body_operation(
    tool_shape: "Any",
    body_store: dict,
    operation: str,
    merge_target: "str | None",
    body_id: str,
    feature_id: str,
    sketch_id: str,
    op_name: str = "",
    profile_queries: list[str] | None = None,
    face_lineage: dict[str, list[str]] | None = None,
    edge_lineage: dict[str, list[str]] | None = None,
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
        cut_anything = False
        cut_body_id = None
        cut_body_ids: list[str] = []
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
            old_target_shape = _ensure_occ(existing_body.shape)
            new_shape, brep_diff = boolean_cut_with_diff(old_target_shape, tool_shape)
            existing_body.shape = _ensure_occ(new_shape)
            existing_body.modified_by.append(feature_id)
            existing_body.brep_diff = brep_diff
            _transfer_boolean_lineage(
                existing_body, old_target_shape, _ensure_occ(tool_shape),
                face_lineage, edge_lineage,
            )
            cut_anything = True
            cut_body_ids.append(bid)
            if cut_body_id is None:
                cut_body_id = bid
            # If cut splits the body into disconnected solids, create extra bodies.
            solids = _split_compound(_ensure_occ(new_shape))
            if len(solids) > 1:
                existing_body.shape = _ensure_occ(solids[0])
                for i, solid in enumerate(solids[1:], start=1):
                    suffix = i
                    while f"{bid}_{suffix}" in body_store:
                        suffix += 1
                    new_bid = f"{bid}_{suffix}"
                    body_store[new_bid] = Body(
                        id=new_bid,
                        created_by=existing_body.created_by,
                        shape=_ensure_occ(solid),
                        sketch_id=existing_body.sketch_id,
                    )
                    cut_body_ids.append(new_bid)
        if not cut_anything:
            raise ValueError(
                f"{op_name}: cut does not intersect any target body "
                "- nothing to remove"
            )
        result["body_id"] = cut_body_id
        result["body_ids"] = cut_body_ids
        result["operation"] = "cut"
        cut_body = body_store.get(cut_body_id)
        if cut_body is not None and _brep_diff_is_empty(cut_body.brep_diff):
            result["solver_warning"] = f"{op_name}: operation produced no geometry change"
    elif operation == "new":
        solids = _split_compound(tool_shape)
        body_ids = []
        for i, solid in enumerate(solids):
            bid = body_id if i == 0 else f"{body_id}_{i}"
            b = Body(id=bid, created_by=feature_id, shape=_ensure_occ(solid),
                     sketch_id=sketch_id,
                     profile_queries=list(profile_queries) if profile_queries else [],
                     face_lineage=dict(face_lineage) if face_lineage else {},
                     edge_lineage=dict(edge_lineage) if edge_lineage else {})
            body_store[bid] = b
            body_ids.append(bid)
        result["body_id"] = body_ids[0]
        result["body_ids"] = body_ids
        result["operation"] = "new"
    else:
        fused = False
        fused_body_id = None
        if not need_new_body:
            for bid in target_ids:
                existing_body = body_store[bid]
                if existing_body.shape is None:
                    continue
                old_target_shape = _ensure_occ(existing_body.shape)
                try:
                    new_shape, brep_diff = boolean_union_with_diff(old_target_shape, tool_shape)
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
                existing_body.brep_diff = brep_diff
                _transfer_boolean_lineage(
                    existing_body, old_target_shape, _ensure_occ(tool_shape),
                    face_lineage, edge_lineage,
                )
                fused = True
                fused_body_id = bid
                break
        if fused:
            result["body_id"] = fused_body_id
            result["body_ids"] = [fused_body_id]
            result["operation"] = "add"
            fused_body = body_store.get(fused_body_id)
            if fused_body is not None and _brep_diff_is_empty(fused_body.brep_diff):
                result["solver_warning"] = f"{op_name}: operation produced no geometry change"
        elif not need_new_body:
            raise ValueError(f"{op_name}: add could not fuse with any target body")
        else:
            solids = _split_compound(tool_shape)
            body_ids = []
            for i, solid in enumerate(solids):
                bid = body_id if i == 0 else f"{body_id}_{i}"
                b = Body(id=bid, created_by=feature_id, shape=solid,
                         sketch_id=sketch_id,
                         profile_queries=list(profile_queries) if profile_queries else [],
                         face_lineage=dict(face_lineage) if face_lineage else {},
                         edge_lineage=dict(edge_lineage) if edge_lineage else {})
                body_store[bid] = b
                body_ids.append(bid)
            result["body_id"] = body_ids[0]
            result["body_ids"] = body_ids
            result["operation"] = "add"

    return result


def _resolve_direction_query(
    query: str, global_repo: Repository,
    fallback: list[float], body_store: dict | None = None,
) -> list[float]:
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
    elif data and "external_params" in data and data.get("kind") == "line":
        sketch_id = data.get("sketch_id", "")
        plane = global_repo.elements.get("_pt_" + sketch_id) if sketch_id else None
        if plane:
            from oversolved.kernel.solver_registry import _sketch_to_world_2d
            params = data["external_params"]
            start = _sketch_to_world_2d(params[0:2], plane)
            end = _sketch_to_world_2d(params[2:4], plane)
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
    elif data and "external_params" in data and data.get("kind") == "line":
        sketch_id = data.get("sketch_id", "")
        plane = global_repo.elements.get("_pt_" + sketch_id) if sketch_id else None
        if plane:
            from oversolved.kernel.solver_registry import _sketch_to_world_2d
            params = data["external_params"]
            start = _sketch_to_world_2d(params[0:2], plane)
            end = _sketch_to_world_2d(params[2:4], plane)
            axis_origin = list(start)
            d = [end[k] - start[k] for k in range(3)]
            length = math.sqrt(sum(v * v for v in d))
            if length > 1e-12:
                return axis_origin, [v / length for v in d]
    return fallback_origin, fallback_direction
