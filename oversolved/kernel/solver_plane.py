import math
import logging
import numpy as np
from oversolved.kernel.types3d import Frame3D
from oversolved.kernel.cadquery_ops import _normal_to_frame
from oversolved.kernel.solver_constants import (
    _FRONT_PLANE, _BUILTIN_PLANES, _PLANE_TYPES, _POINT_TYPES,
)
from oversolved.kernel.query import Repository

logger = logging.getLogger(__name__)

__all__ = [
    "is_plane_type",
    "is_point_type",
    "_resolve_plane_early",
    "_2d_to_3d",
    "_3d_to_2d",
    "_source_sketch_id",
    "_resolve_source_geometry",
    "_project_source_to_params",
    "_get_point_3d",
    "_get_edge_3d",
    "_normalize",
    "_rotate_frame_around_normal",
    "_plane_three_point",
    "_plane_on_face",
    "_plane_on_face_edge_angle",
    "_plane_edge_point",
    "_plane_through_point",
    "_plane_line_angle",
    "_plane_offset",
    "_solve_plane",
]

_BARE_ID_MAP = {
    "Top": "builtin_plane_top",
    "Front": "builtin_plane_front",
    "Right": "builtin_plane_right",
}


def _plane_dict(frame: Frame3D) -> dict:
    return {**frame.to_dict(), "type": "plane"}


def is_plane_type(obj: dict | Frame3D) -> bool:
    if isinstance(obj, Frame3D):
        return True
    return obj.get("type") in _PLANE_TYPES


def is_point_type(obj: dict) -> bool:
    return obj.get("type") in _POINT_TYPES


def _resolve_plane_early(
    plane_query: str | None, global_repo: Repository | None
) -> dict:
    if not plane_query:
        raise ValueError("sketch has no plane assignment")
    if plane_query in _BARE_ID_MAP:
        return _BUILTIN_PLANES[_BARE_ID_MAP[plane_query]]
    if plane_query.startswith("@"):
        builtin = _BUILTIN_PLANES.get(plane_query[1:])
        if builtin is not None:
            return builtin
        if global_repo is not None:
            p = global_repo.elements.get(plane_query[1:])
            if p and is_plane_type(p):
                return p if isinstance(p, dict) else _plane_dict(p)
        return _FRONT_PLANE
    if plane_query.startswith("?") and global_repo is not None:
        try:
            frame = _plane_on_face({"face": plane_query}, global_repo)
            return _plane_dict(frame)
        except (ValueError, KeyError, TypeError):
            logger.debug("Failed to resolve plane from ancestry query: %s", plane_query)
    if plane_query.startswith("$") and global_repo is not None:
        p = global_repo.elements.get(plane_query[1:])
        if p:
            if isinstance(p, Frame3D):
                return _plane_dict(p)
            if isinstance(p, dict) and is_plane_type(p):
                return p
    return _FRONT_PLANE


def _2d_to_3d(xy: list, plane: Frame3D | dict) -> list:
    if isinstance(plane, Frame3D):
        origin = np.array(plane.origin)
        x_axis = np.array(plane.x_axis)
        y_axis = np.array(plane.y_axis)
    else:
        origin = np.array(plane["origin"])
        x_axis = np.array(plane["x_axis"])
        y_axis = np.array(plane["y_axis"])
    return (origin + xy[0] * x_axis + xy[1] * y_axis).tolist()


def _3d_to_2d(xyz: list, plane: Frame3D | dict) -> list:
    if isinstance(plane, Frame3D):
        origin = np.array(plane.origin)
        x_axis = np.array(plane.x_axis)
        y_axis = np.array(plane.y_axis)
    else:
        origin = np.array(plane["origin"])
        x_axis = np.array(plane["x_axis"])
        y_axis = np.array(plane["y_axis"])
    v = np.array(xyz) - origin
    return [float(np.dot(v, x_axis)), float(np.dot(v, y_axis))]


def _source_sketch_id(source_query: str) -> str:
    return source_query.lstrip("@").split("/")[0]


def _resolve_source_geometry(source_query: str, global_repo: Repository) -> tuple:
    sketch_id = _source_sketch_id(source_query)
    source_plane = global_repo.elements.get("_pt_" + sketch_id) or _FRONT_PLANE

    data = global_repo.query(source_query)
    if data is None:
        raise ValueError(f"source not found: {source_query!r}")

    if "external_xy" in data:
        xy = data["external_xy"]
        return "point", _2d_to_3d(xy, source_plane)

    if "external_params" in data:
        params = data["external_params"]
        kind = data.get("kind", "")
        if kind == "line":
            return "line", {
                "start": _2d_to_3d(params[0:2], source_plane),
                "end": _2d_to_3d(params[2:4], source_plane),
            }
        if kind == "circle":
            return "circle", {
                "center": _2d_to_3d(params[0:2], source_plane),
                "radius": params[2],
            }
        if kind == "arc":
            return "arc", {
                "center": _2d_to_3d(params[0:2], source_plane),
                "radius": params[2],
                "start_angle": params[3],
                "end_angle": params[4],
            }

    # 3D body geometry resolved via ancestry query: face / edge / vertex.
    # These payloads carry 3D world coordinates, not 2D sketch params.
    data_type = data.get("type", "")
    if data_type in ("face", "flatface", "cylinderface"):
        point_3d = data.get("centroid") or data.get("origin") or [0.0, 0.0, 0.0]
        return "point", point_3d
    if data_type in ("edge", "straightedge"):
        start = data.get("start", [0.0, 0.0, 0.0])
        end = data.get("end", [0.0, 0.0, 0.0])
        return "line", {"start": start, "end": end}
    if data_type == "vertex":
        vx = data.get("x", 0.0)
        vy = data.get("y", 0.0)
        vz = data.get("z", 0.0)
        return "point", [vx, vy, vz]

    raise ValueError(f"cannot resolve source geometry for {source_query!r}")


def _project_source_to_params(
    projected_kind: str, source_query: str, target_plane: Frame3D | dict, global_repo: Repository
) -> list:
    kind_hint, data_3d = _resolve_source_geometry(source_query, global_repo)

    if projected_kind == "projected_point":
        u, v = _3d_to_2d(data_3d, target_plane)
        return [u, v]
    if projected_kind == "projected_line":
        s2d = _3d_to_2d(data_3d["start"], target_plane)
        e2d = _3d_to_2d(data_3d["end"], target_plane)
        return s2d + e2d
    if projected_kind == "projected_circle":
        c2d = _3d_to_2d(data_3d["center"], target_plane)
        return c2d + [data_3d["radius"]]
    if projected_kind == "projected_arc":
        c2d = _3d_to_2d(data_3d["center"], target_plane)
        return c2d + [data_3d["radius"], data_3d["start_angle"], data_3d["end_angle"]]

    raise ValueError(f"unknown projected kind: {projected_kind!r}")


def _get_point_3d(ref: Frame3D | dict, global_repo: Repository) -> np.ndarray:
    if isinstance(ref, Frame3D):
        raise ValueError("reference is a plane, not a point")
    if "external_xy" in ref:
        xy = ref["external_xy"]
        sketch_id = ref.get("sketch_id")
        if sketch_id:
            pt = global_repo.elements.get("_pt_" + sketch_id)
            if pt:
                origin = np.array(pt["origin"])
                x_axis = np.array(pt["x_axis"])
                y_axis = np.array(pt["y_axis"])
                return origin + xy[0] * x_axis + xy[1] * y_axis
        return np.array([xy[0], xy[1], 0.0])
    if ref.get("type") == "vertex" and "origin" in ref:
        return np.array(ref["origin"], dtype=float)
    if "origin" in ref and "normal" not in ref:
        return np.array(ref["origin"], dtype=float)
    if "origin" in ref and "normal" in ref:
        raise ValueError("reference is a plane, not a point")
    raise ValueError("point reference has no coordinates")


def _get_edge_3d(ref: Frame3D | dict, global_repo: Repository) -> tuple:
    if isinstance(ref, Frame3D):
        raise ValueError("reference is a plane, not an edge")
    if "external_params" in ref and ref.get("kind") in ("line", "projected_line"):
        p = ref["external_params"]
        sketch_id = ref.get("sketch_id")
        if sketch_id:
            pt = global_repo.elements.get("_pt_" + sketch_id)
            if pt:
                origin = np.array(pt["origin"])
                x_axis = np.array(pt["x_axis"])
                y_axis = np.array(pt["y_axis"])
                start = origin + p[0] * x_axis + p[1] * y_axis
                end = origin + p[2] * x_axis + p[3] * y_axis
                return start, end
        return np.array([p[0], p[1], 0.0]), np.array([p[2], p[3], 0.0])
    if "start" in ref and "end" in ref:
        return np.array(ref["start"]), np.array(ref["end"])
    raise ValueError("edge reference has no line coordinates")


def _normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError("Cannot normalize zero-length vector")
    return v / n


def _rotate_frame_around_normal(
    x_axis: np.ndarray, y_axis: np.ndarray, normal: np.ndarray, degrees: float
) -> tuple:
    radians = np.radians(degrees)
    cos_a = np.cos(radians)
    sin_a = np.sin(radians)
    x_new = cos_a * x_axis + sin_a * y_axis
    y_new = -sin_a * x_axis + cos_a * y_axis
    return x_new, y_new


def _plane_three_point(definition: dict, global_repo: Repository) -> Frame3D:
    r1 = global_repo.query(definition["p1"])
    r2 = global_repo.query(definition["p2"])
    r3 = global_repo.query(definition["p3"])
    if r1 is None:
        raise ValueError(f"point not found: {definition['p1']!r}")
    if r2 is None:
        raise ValueError(f"point not found: {definition['p2']!r}")
    if r3 is None:
        raise ValueError(f"point not found: {definition['p3']!r}")
    p1 = _get_point_3d(r1, global_repo)
    p2 = _get_point_3d(r2, global_repo)
    p3 = _get_point_3d(r3, global_repo)

    origin = p1.copy()
    x_axis = _normalize(p2 - origin)
    v = p3 - origin
    y_axis_raw = v - np.dot(v, x_axis) * x_axis
    if np.linalg.norm(y_axis_raw) < 1e-10:
        raise ValueError("collinear points: cannot define a plane")
    y_axis = _normalize(y_axis_raw)
    normal = np.cross(x_axis, y_axis)
    return Frame3D.from_arrays(origin, x_axis, y_axis, normal)


def _plane_on_face(definition: dict, global_repo: Repository, body_store: dict | None = None) -> Frame3D:
    face_str = definition["face"]
    face = global_repo.query(face_str, body_store=body_store)
    if face is None:
        raise ValueError(f"face not found: {face_str!r}")

    origin = np.array(face["centroid"])
    normal = np.array(face["normal"])

    x_list, y_list = _normal_to_frame(list(normal))
    x_axis = np.array(x_list)
    y_axis = np.array(y_list)
    return Frame3D.from_arrays(origin, x_axis, y_axis, normal)


def _plane_on_face_edge_angle(definition: dict, global_repo: Repository, body_store: dict | None = None) -> Frame3D:
    face_str = definition["face"]
    edge_str = definition["edge"]
    angle = definition.get("angle", 0.0)

    face = global_repo.query(face_str, body_store=body_store)
    if face is None:
        raise ValueError(f"face not found: {face_str!r}")
    edge = global_repo.query(edge_str, body_store=body_store)
    if edge is None:
        raise ValueError(f"edge not found: {edge_str!r}")

    origin = np.array(face["centroid"])
    normal = np.array(face["normal"])

    edge_dir = _normalize(np.array(edge["end"]) - np.array(edge["start"]))
    x_axis_raw = edge_dir - np.dot(edge_dir, normal) * normal
    if np.linalg.norm(x_axis_raw) < 1e-12:
        # edge_dir is parallel to normal -- pick an arbitrary perpendicular direction
        if abs(normal[2]) < 0.9:
            arbitrary = np.array([0.0, 0.0, 1.0])
        else:
            arbitrary = np.array([1.0, 0.0, 0.0])
        x_axis_base = _normalize(np.cross(normal, arbitrary))
    else:
        x_axis_base = _normalize(x_axis_raw)

    x_axis, _ = _rotate_frame_around_normal(
        x_axis_base, np.cross(normal, x_axis_base), normal, angle
    )
    y_axis = np.cross(normal, x_axis)
    return Frame3D.from_arrays(origin, x_axis, y_axis, normal)


def _plane_edge_point(definition: dict, global_repo: Repository, body_store: dict | None = None) -> Frame3D:
    edge_str = definition["edge"]
    point_str = definition["point"]

    edge = global_repo.query(edge_str, body_store=body_store)
    if edge is None:
        raise ValueError(f"edge not found: {edge_str!r}")
    point_ref = global_repo.query(point_str, body_store=body_store)
    if point_ref is None:
        raise ValueError(f"point not found: {point_str!r}")

    edge_start, edge_end = _get_edge_3d(edge, global_repo)
    x_axis = _normalize(edge_end - edge_start)
    origin = _get_point_3d(point_ref, global_repo)
    point_3d = origin

    t = float(np.dot(point_3d - edge_start, x_axis))
    projected_point = edge_start + x_axis * t

    point_to_projection = projected_point - point_3d
    if np.linalg.norm(point_to_projection) > 1e-10:
        y_axis = _normalize(point_to_projection)
    else:
        if abs(x_axis[2]) < 0.9:
            arbitrary = np.array([0.0, 0.0, 1.0])
        else:
            arbitrary = np.array([1.0, 0.0, 0.0])
        y_axis = _normalize(np.cross(x_axis, arbitrary))

    normal = np.cross(x_axis, y_axis)
    return Frame3D.from_arrays(origin, x_axis, y_axis, normal)


def _plane_through_point(definition: dict, global_repo: Repository) -> Frame3D:
    plane_query = definition.get("plane", "")
    point_query = definition.get("point", "")
    ref_plane = global_repo.query(plane_query)
    if ref_plane is None:
        raise ValueError(f"plane not found: {plane_query!r}")
    point_ref = global_repo.query(point_query)
    if point_ref is None:
        raise ValueError(f"point not found: {point_query!r}")

    if isinstance(ref_plane, Frame3D):
        normal = np.array(ref_plane.normal)
        x_axis = np.array(ref_plane.x_axis)
        y_axis = np.array(ref_plane.y_axis)
        ref_origin = np.array(ref_plane.origin)
    else:
        normal = np.array(ref_plane.get("normal", [0, 0, 1]))
        x_axis = np.array(ref_plane.get("x_axis", [1, 0, 0]))
        y_axis = np.array(ref_plane.get("y_axis", [0, 1, 0]))
        ref_origin = np.array(ref_plane.get("origin", [0, 0, 0]))

    point_3d = _get_point_3d(point_ref, global_repo)

    t = float(np.dot(point_3d - ref_origin, normal))
    origin = ref_origin + normal * t

    return Frame3D.from_arrays(origin, x_axis, y_axis, normal)


def _plane_line_angle(definition: dict, global_repo: Repository) -> Frame3D:
    line_str = definition.get("line", "")
    angle = float(definition.get("angle", 0.0))

    line_ref = global_repo.query(line_str)
    if line_ref is None:
        raise ValueError(f"line not found: {line_str!r}")

    line_start, line_end = _get_edge_3d(line_ref, global_repo)
    x_axis = _normalize(line_end - line_start)
    origin = line_start.copy()

    if abs(x_axis[2]) < 0.9:
        ref = np.array([0.0, 0.0, 1.0])
    else:
        ref = np.array([1.0, 0.0, 0.0])
    y_axis_default = _normalize(ref - np.dot(ref, x_axis) * x_axis)

    radians = math.radians(angle)
    z_axis_default = np.cross(x_axis, y_axis_default)
    y_axis = math.cos(radians) * y_axis_default + math.sin(radians) * z_axis_default
    normal = np.cross(x_axis, y_axis)
    return Frame3D.from_arrays(origin, x_axis, y_axis, normal)


def _plane_offset(definition: dict, global_repo: Repository) -> Frame3D:
    plane_val = definition.get("plane")
    plane_query = plane_val if isinstance(plane_val, str) else (definition.get("reference") or "")
    raw_offset = definition.get("offset")
    raw_offset = raw_offset if raw_offset is not None else definition.get("distance")
    offset = float(raw_offset if raw_offset is not None else 0.0)
    plane = global_repo.query(plane_query)
    if plane is None:
        raise ValueError(f"plane not found: {plane_query!r}")

    if isinstance(plane, Frame3D):
        normal = np.array(plane.normal)
        origin = np.array(plane.origin) + normal * offset
        x_axis = np.array(plane.x_axis)
        y_axis = np.array(plane.y_axis)
    else:
        normal = np.array(plane.get("normal", [0, 0, 1]))
        origin = np.array(plane.get("origin", [0, 0, 0])) + normal * offset
        x_axis = np.array(plane.get("x_axis", [1, 0, 0]))
        y_axis = np.array(plane.get("y_axis", [0, 1, 0]))
    return Frame3D.from_arrays(origin, x_axis, y_axis, normal)


def _solve_plane(feature: dict, global_repo: Repository, body_store: dict | None = None) -> dict:
    definition = feature.get("definition", {})
    mode = definition.get("mode")

    if mode == "three_point":
        frame = _plane_three_point(definition, global_repo)
    elif mode == "plane_point":
        frame = _plane_through_point(definition, global_repo)
    elif mode == "line_angle":
        frame = _plane_line_angle(definition, global_repo)
    elif mode == "on_face":
        frame = _plane_on_face(definition, global_repo, body_store)
    elif mode == "on_face_edge_angle":
        frame = _plane_on_face_edge_angle(definition, global_repo, body_store)
    elif mode == "edge_point":
        frame = _plane_edge_point(definition, global_repo, body_store)
    elif mode == "offset":
        frame = _plane_offset(definition, global_repo)
    else:
        raise ValueError(f"unknown plane mode: {mode!r}")

    rotation = definition.get("rotation", 0.0)
    if rotation != 0.0:
        x_a = np.array(frame.x_axis)
        y_a = np.array(frame.y_axis)
        n_a = np.array(frame.normal)
        x_new, y_new = _rotate_frame_around_normal(x_a, y_a, n_a, rotation)
        frame = Frame3D(
            origin=frame.origin,
            x_axis=x_new.tolist(),
            y_axis=y_new.tolist(),
            normal=frame.normal,
        )

    plane_id = feature["id"]
    frame_dict = _plane_dict(frame)
    global_repo.register(plane_id, frame_dict)

    return {
        "status": "ok",
        "plane": frame.to_dict(),
    }
