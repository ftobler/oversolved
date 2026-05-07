import math
import logging
from typing import Optional
import numpy as np
from oversolved.kernel.solver_constants import (
    _FRONT_PLANE, _BUILTIN_PLANES, _PLANE_TYPES, _POINT_TYPES,
)
from oversolved.kernel.query import Repository

logger = logging.getLogger(__name__)


def is_plane_type(obj: dict) -> bool:
    return obj.get("type") in _PLANE_TYPES


def is_point_type(obj: dict) -> bool:
    return obj.get("type") in _POINT_TYPES


def _resolve_plane_early(
    plane_query: Optional[str], global_repo: Optional[Repository]
) -> dict:
    """Quick plane resolution without full repo setup (used before entity_offsets are built)."""
    _BARE_ID_MAP = {
        "Top": "builtin_plane_top",
        "Front": "builtin_plane_front",
        "Right": "builtin_plane_right",
    }
    if not plane_query:
        return _FRONT_PLANE
    if plane_query in _BARE_ID_MAP:
        return _BUILTIN_PLANES[_BARE_ID_MAP[plane_query]]
    if plane_query.startswith("@"):
        builtin = _BUILTIN_PLANES.get(plane_query[1:])
        if builtin is not None:
            return builtin
        # Also look up user-defined planes in global_repo (e.g. @plane1)
        if global_repo is not None:
            p = global_repo.elements.get(plane_query[1:])
            if p and is_plane_type(p):
                return p
        return _FRONT_PLANE
    if plane_query.startswith("?") and global_repo is not None:
        # Ancestry query -- resolves to a registered face (e.g. from a 3D body mesh)
        try:
            origin, x_axis, y_axis, normal = _plane_on_face(
                {"face": plane_query}, global_repo
            )
            return {
                "origin": origin.tolist(),
                "x_axis": x_axis.tolist(),
                "y_axis": y_axis.tolist(),
                "normal": normal.tolist(),
            }
        except (ValueError, KeyError, TypeError):
            logger.debug("Failed to resolve plane from ancestry query: %s", plane_query)
    if plane_query.startswith("$") and global_repo is not None:
        p = global_repo.elements.get(plane_query[1:])
        if p and is_plane_type(p):
            return p
    return _FRONT_PLANE


def _2d_to_3d(xy: list, plane: dict) -> list:
    """Convert 2D local coords to 3D world coords via plane transform."""
    origin = np.array(plane["origin"])
    x_axis = np.array(plane["x_axis"])
    y_axis = np.array(plane["y_axis"])
    return (origin + xy[0] * x_axis + xy[1] * y_axis).tolist()


def _3d_to_2d(xyz: list, plane: dict) -> list:
    """Project 3D world coords onto plane, returning [u, v]."""
    origin = np.array(plane["origin"])
    x_axis = np.array(plane["x_axis"])
    y_axis = np.array(plane["y_axis"])
    v = np.array(xyz) - origin
    return [float(np.dot(v, x_axis)), float(np.dot(v, y_axis))]


def _source_sketch_id(source_query: str) -> str:
    """Extract sketch ID from '@sketch_id/...' or '@sketch_identity...' query."""
    return source_query.lstrip("@").split("/")[0]


def _resolve_source_geometry(source_query: str, global_repo: Repository) -> tuple:
    """Resolve source entity to 3D geometry. Returns (kind_hint, data_3d).

    data_3d is:
    - for point: [x, y, z]
    - for line: {'start': [x,y,z], 'end': [x,y,z]}
    - for circle: {'center': [x,y,z], 'radius': r}
    - for arc: {'center': [x,y,z], 'radius': r, 'start_angle': a, 'end_angle': b}
    """
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

    raise ValueError(f"cannot resolve source geometry for {source_query!r}")


def _project_source_to_params(
    projected_kind: str, source_query: str, target_plane: dict, global_repo: Repository
) -> list:
    """Compute flat 2D params for a projected entity on target_plane."""
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


def _get_point_3d(ref: dict, global_repo: Repository) -> np.ndarray:
    """Convert a registered point reference to a 3D world coordinate.

    Uses sketch_id + _pt_ plane transform to lift 2D local coordinates to 3D
    world space.  Falls back to [x, y, 0] when no plane transform is known.
    Also accepts vertex objects (type == "vertex") and generic dicts with
    an "origin" field (but no "normal", which would indicate a plane).
    """
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


def _get_edge_3d(ref: dict, global_repo: Repository) -> tuple:
    """Return (start_3d, end_3d) for a registered edge/line reference.

    Uses sketch_id + _pt_ plane transform when available.
    Falls back to z=0 for 2D-only references.
    """
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
    """Return unit vector in direction of v."""
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError("Cannot normalize zero-length vector")
    return v / n


def _rotate_frame_around_normal(
    x_axis: np.ndarray, y_axis: np.ndarray, normal: np.ndarray, degrees: float
) -> tuple:
    """Rotate x_axis and y_axis around normal by degrees (CW looking down normal)."""
    radians = np.radians(degrees)
    cos_a = np.cos(radians)
    sin_a = np.sin(radians)
    x_new = cos_a * x_axis + sin_a * y_axis
    y_new = -sin_a * x_axis + cos_a * y_axis
    return x_new, y_new


def _plane_three_point(definition: dict, global_repo: Repository) -> tuple:
    """Three-point plane: origin at p1, x_axis toward p2, y_axis toward p3 (Gram-Schmidt)."""
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
    return origin, x_axis, y_axis, normal


def _plane_on_face(definition: dict, global_repo: Repository, body_store: dict | None = None) -> tuple:
    """Plane aligned with a topology face."""
    face_str = definition["face"]
    face = global_repo.query(face_str, body_store=body_store)
    if face is None:
        raise ValueError(f"face not found: {face_str!r}")

    origin = np.array(face["centroid"])
    normal = np.array(face["normal"])

    if abs(normal[2]) < 0.9:
        arbitrary = np.array([0.0, 0.0, 1.0])
    else:
        arbitrary = np.array([1.0, 0.0, 0.0])

    x_axis = _normalize(np.cross(normal, arbitrary))
    y_axis = np.cross(normal, x_axis)
    return origin, x_axis, y_axis, normal


def _plane_on_face_edge_angle(definition: dict, global_repo: Repository, body_store: dict | None = None) -> tuple:
    """Plane on face with X axis along an edge, rotated by angle."""
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
    x_axis_base = edge_dir - np.dot(edge_dir, normal) * normal
    x_axis_base = _normalize(x_axis_base)

    x_axis, _ = _rotate_frame_around_normal(
        x_axis_base, np.cross(normal, x_axis_base), normal, angle
    )
    y_axis = np.cross(normal, x_axis)
    return origin, x_axis, y_axis, normal


def _plane_edge_point(definition: dict, global_repo: Repository, body_store: dict | None = None) -> tuple:
    """Plane with X axis along an edge and origin at a point.

    The plane's origin is at the given point, x_axis is along the line direction,
    and y_axis points from the point toward the line (perpendicular projection),
    making the plane pivot around the line.
    """
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

    # Project point onto the line
    t = float(np.dot(point_3d - edge_start, x_axis))
    projected_point = edge_start + x_axis * t

    # y_axis points from point toward its projection on the line
    point_to_projection = projected_point - point_3d
    if np.linalg.norm(point_to_projection) > 1e-10:
        y_axis = _normalize(point_to_projection)
    else:
        # Point is on the line, use perpendicular direction
        if abs(x_axis[2]) < 0.9:
            arbitrary = np.array([0.0, 0.0, 1.0])
        else:
            arbitrary = np.array([1.0, 0.0, 0.0])
        y_axis = _normalize(np.cross(x_axis, arbitrary))

    normal = np.cross(x_axis, y_axis)
    return origin, x_axis, y_axis, normal


def _plane_through_point(definition: dict, global_repo: Repository) -> tuple:
    """Plane parallel to a reference plane, with its origin positioned at a given point.

    The plane keeps the same orientation (x_axis, y_axis, normal) as the reference
    plane but its origin is set to the specified point projected onto the reference
    plane's normal axis.
    """
    plane_query = definition.get("plane", "")
    point_query = definition.get("point", "")
    ref_plane = global_repo.query(plane_query)
    if ref_plane is None:
        raise ValueError(f"plane not found: {plane_query!r}")
    point_ref = global_repo.query(point_query)
    if point_ref is None:
        raise ValueError(f"point not found: {point_query!r}")

    normal = np.array(ref_plane.get("normal", [0, 0, 1]))
    x_axis = np.array(ref_plane.get("x_axis", [1, 0, 0]))
    y_axis = np.array(ref_plane.get("y_axis", [0, 1, 0]))
    ref_origin = np.array(ref_plane.get("origin", [0, 0, 0]))

    point_3d = _get_point_3d(point_ref, global_repo)

    # Project point onto the normal axis to determine offset from reference origin
    t = float(np.dot(point_3d - ref_origin, normal))
    origin = ref_origin + normal * t

    return origin, x_axis, y_axis, normal


def _plane_line_angle(definition: dict, global_repo: Repository) -> tuple:
    """Plane that contains a line (hinge axis) and is rotated around that line by a given angle.

    At angle=0 the plane is oriented so its y_axis is perpendicular to the line and
    points in the direction most aligned with the world Z axis (or world X when the
    line is parallel to Z).  Increasing angle rotates the plane around the line.
    """
    line_str = definition.get("line", "")
    angle = float(definition.get("angle", 0.0))

    line_ref = global_repo.query(line_str)
    if line_ref is None:
        raise ValueError(f"line not found: {line_str!r}")

    line_start, line_end = _get_edge_3d(line_ref, global_repo)
    x_axis = _normalize(line_end - line_start)  # hinge axis = line direction
    origin = line_start.copy()

    # Build a reference y_axis perpendicular to x_axis (default at angle=0)
    if abs(x_axis[2]) < 0.9:
        ref = np.array([0.0, 0.0, 1.0])
    else:
        ref = np.array([1.0, 0.0, 0.0])
    y_axis_default = _normalize(ref - np.dot(ref, x_axis) * x_axis)

    # Rotate y_axis around x_axis by angle
    radians = math.radians(angle)
    z_axis_default = np.cross(x_axis, y_axis_default)
    y_axis = math.cos(radians) * y_axis_default + math.sin(radians) * z_axis_default
    normal = np.cross(x_axis, y_axis)
    return origin, x_axis, y_axis, normal


def _plane_offset(definition: dict, global_repo: Repository) -> tuple:
    """Plane parallel to a reference plane, offset along its normal."""
    plane_val = definition.get("plane")
    plane_query = plane_val if isinstance(plane_val, str) else (definition.get("reference") or "")
    raw_offset = definition.get("offset") if definition.get("offset") is not None else definition.get("distance")
    offset = float(raw_offset if raw_offset is not None else 0.0)
    plane = global_repo.query(plane_query)
    if plane is None:
        raise ValueError(f"plane not found: {plane_query!r}")
    normal = np.array(plane.get("normal", [0, 0, 1]))
    origin = np.array(plane.get("origin", [0, 0, 0])) + normal * offset
    x_axis = np.array(plane.get("x_axis", [1, 0, 0]))
    y_axis = np.array(plane.get("y_axis", [0, 1, 0]))
    return origin, x_axis, y_axis, normal


def _solve_plane(feature: dict, global_repo: Repository, body_store: dict | None = None) -> dict:
    """Solve a plane feature, computing a 3D coordinate frame."""
    try:
        definition = feature.get("definition", {})
        mode = definition.get("mode")

        if mode == "three_point":
            origin, x_axis, y_axis, normal = _plane_three_point(definition, global_repo)
        elif mode == "plane_point":
            origin, x_axis, y_axis, normal = _plane_through_point(
                definition, global_repo
            )
        elif mode == "line_angle":
            origin, x_axis, y_axis, normal = _plane_line_angle(definition, global_repo)
        elif mode == "on_face":
            origin, x_axis, y_axis, normal = _plane_on_face(definition, global_repo, body_store)
        elif mode == "on_face_edge_angle":
            origin, x_axis, y_axis, normal = _plane_on_face_edge_angle(
                definition, global_repo, body_store
            )
        elif mode == "edge_point":
            origin, x_axis, y_axis, normal = _plane_edge_point(definition, global_repo, body_store)
        elif mode == "offset":
            origin, x_axis, y_axis, normal = _plane_offset(definition, global_repo)
        else:
            return {"status": "exception", "exception": f"unknown plane mode: {mode!r}"}

        rotation = definition.get("rotation", 0.0)
        if rotation != 0.0:
            x_axis, y_axis = _rotate_frame_around_normal(
                x_axis, y_axis, normal, rotation
            )

        plane_id = feature["id"]
        global_repo.register(
            plane_id,
            {
                "type": "plane",
                "origin": origin.tolist(),
                "x_axis": x_axis.tolist(),
                "y_axis": y_axis.tolist(),
                "normal": normal.tolist(),
            },
        )

        return {
            "status": "ok",
            "plane": {
                "origin": origin.tolist(),
                "x_axis": x_axis.tolist(),
                "y_axis": y_axis.tolist(),
                "normal": normal.tolist(),
            },
        }
    except Exception as e:
        return {"status": "exception", "exception": str(e)}
