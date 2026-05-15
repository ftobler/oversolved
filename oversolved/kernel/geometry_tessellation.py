"""geometry_tessellation.py - Tessellation, 2D/3D geometry helpers, and shape construction."""

from __future__ import annotations

import math
import os
import logging
from typing import Any, TypedDict, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape

try:
    from cadquery.occ_impl import shapes as cq_shapes
except ImportError:
    cq_shapes = None  # type: ignore

from oversolved.kernel.solver_constants import TOL_MESH_NORMAL
from oversolved.kernel.cadquery_ops import (
    _compute_face_centroid,
    _compute_face_normal,
    _ensure_cq,
    _ensure_occ,
    _face_sort_key_from_tuple,
    _get_face_surface_type,
    _triangle_area,
    boolean_union,
    extrude_face,
    make_arc_edge,
    make_face_from_wires,
    make_line_edge,
    make_wire,
    to_cq_plane,
)
from oversolved.kernel.ocp_ops import ocp_mesh_shape
from oversolved.kernel.profile_loops import classify_loops
from oversolved.kernel.types3d import Frame3D

logger = logging.getLogger(__name__)


class MeshDict(TypedDict):
    vertices: list[list[float]]
    faces: list[list[int]]
    normals: list[list[float]]
    face_data: list[dict]
    triangle_to_face: list[int]
    face_queries: list[str]
    is_fallback: bool


class EdgeDict(TypedDict):
    edges: list[dict]
    edge_queries: list[str]


class VertexDict(TypedDict):
    vertices: list[list[float]]
    vertex_queries: list[str]


def _validate_mesh(mesh: MeshDict) -> None:
    """Validate mesh data: no NaN/inf vertices, valid face indices, unit normals.

    Raises ValueError with descriptive message if mesh is invalid.
    """
    verts = mesh["vertices"]
    faces = mesh["faces"]
    normals = mesh.get("normals", [])
    triangle_to_face = mesh.get("triangle_to_face", [])
    face_queries = mesh.get("face_queries", [])
    face_data = mesh.get("face_data", [])

    for i, v in enumerate(verts):
        if len(v) != 3:
            raise ValueError(f"vertex {i} has {len(v)} coordinates, expected 3")
        for j, coord in enumerate(v):
            if math.isnan(coord) or math.isinf(coord):
                raise ValueError(f"vertex {i} has invalid coordinate [{j}]: {coord}")

    n = len(verts)
    for i, tri in enumerate(faces):
        if len(tri) != 3:
            raise ValueError(f"face {i} has {len(tri)} indices, expected 3")
        for j, idx in enumerate(tri):
            if not isinstance(idx, int):
                raise ValueError(f"face {i} index {j} is not an int: {idx!r}")
            if idx < 0 or idx >= n:
                raise ValueError(f"face {i} index {j}={idx} out of range [0, {n})")

    if len(normals) != len(faces):
        raise ValueError(f"normals count {len(normals)} != faces count {len(faces)}")

    for i, normal in enumerate(normals):
        mag = math.sqrt(sum(x * x for x in normal))
        if abs(mag - 1.0) > TOL_MESH_NORMAL:
            raise ValueError(f"normal {i} not unit length: mag={mag}")

    if triangle_to_face:
        if len(triangle_to_face) != len(faces):
            raise ValueError(
                f"triangle_to_face length {len(triangle_to_face)} != faces count {len(faces)}"
            )
        face_count = len(face_queries) if face_queries else len(face_data)
        for i, face_idx in enumerate(triangle_to_face):
            if not isinstance(face_idx, int):
                raise ValueError(f"triangle_to_face[{i}] is not an int: {face_idx!r}")
            if face_idx < 0 or face_idx >= face_count:
                raise ValueError(
                    f"triangle_to_face[{i}]={face_idx} out of range [0, {face_count})"
                )
        if face_queries:
            used_faces = set(triangle_to_face)
            no_tri_count = 0
            for face_idx in range(len(face_queries)):
                if face_idx not in used_faces:
                    logger.debug("face %d has no triangles in triangle_to_face", face_idx)
                    no_tri_count += 1
            if no_tri_count > 0:
                logger.warning("%d face(s) have no triangles in triangle_to_face", no_tri_count)

    if face_queries and len(face_data) != len(face_queries):
        raise ValueError(
            f"face_data count {len(face_data)} != face_queries count {len(face_queries)}"
        )


def signed_distance_to_line(
    point: tuple[float, float],
    line_start: tuple[float, float],
    line_end: tuple[float, float],
) -> float:
    """Compute signed distance from point to line.

    Positive = point is on the left side of the directed line (start → end).
    Negative = point is on the right side.
    Zero = point is on the line.
    """
    px, py = point
    x1, y1 = line_start
    x2, y2 = line_end

    dx = x2 - x1
    dy = y2 - y1

    dpx = px - x1
    dpy = py - y1

    return dx * dpy - dy * dpx


def point_in_circle(
    point: tuple[float, float], center: tuple[float, float], radius: float
) -> bool:
    """Check if point is inside circle (distance < radius)."""
    px, py = point
    cx, cy = center
    dist_sq = (px - cx) ** 2 + (py - cy) ** 2
    return dist_sq < radius**2


def classify_surface_by_line_side(
    centroid: tuple[float, float],
    line_start: tuple[float, float],
    line_end: tuple[float, float],
) -> str:
    """Classify surface as '@pos' or '@neg' based on line side.

    @pos: centroid is on the left/positive side of the line
    @neg: centroid is on the right/negative side of the line
    """
    signed_dist = signed_distance_to_line(centroid, line_start, line_end)
    return "@pos" if signed_dist > 0 else "@neg"


def classify_surface_by_circle_side(
    centroid: tuple[float, float], center: tuple[float, float], radius: float
) -> str:
    """Classify surface as '@inner' or '@outer' relative to circle.

    @inner: centroid is inside the circle
    @outer: centroid is outside the circle
    """
    return "@inner" if point_in_circle(centroid, center, radius) else "@outer"


def classify_surface_cardinal(
    centroid: tuple[float, float], origin: tuple[float, float] = (0, 0)
) -> str:
    """Classify surface by cardinal direction from origin.

    Returns '@north', '@south', '@east', or '@west' based on which quadrant
    the centroid falls into relative to the origin.
    """
    px, py = centroid
    ox, oy = origin
    dx = px - ox
    dy = py - oy

    if abs(dy) > abs(dx):
        return "@north" if dy > 0 else "@south"
    else:
        return "@east" if dx > 0 else "@west"


# Data types:
# PlaneTransform dict:
# {
#   'origin': [x, y, z],
#   'x_axis': [x, y, z],
#   'y_axis': [x, y, z],
#   'normal': [x, y, z],
# }
#
# ProfileLoops: list of loops, each a list of [u, v] pairs in sketch-local 2D.
# loops[0] = outer boundary, loops[1:] = holes.
#
# Mesh dict:
# {
#   'vertices': [[x, y, z], ...],
#   'faces':    [[i, j, k], ...],
#   'normals':  [[nx, ny, nz], ...],  per-face unit normals
# }


def plane_dict_to_gp_pln(plane: Frame3D | dict) -> Any:
    """Convert a PlaneTransform dict to a cadquery Plane object."""
    return to_cq_plane(plane)


def sketch_loops_to_face(loops: list[list[dict]], plane: Frame3D | dict) -> cq_shapes.Face:
    """Convert 2D profile boundary-edge loops to a cadquery Face with holes.

    loops[0] = outer boundary, loops[1:] = holes.
    Each loop is a list of edge dicts with keys: kind, start, end,
    and for arcs: center, radius, angle_start_deg, angle_end_deg, ccw.
    plane is a PlaneTransform dict with origin, x_axis, y_axis, normal (all [x,y,z]).
    Returns a cadquery Face.
    """
    cq_plane = to_cq_plane(plane)
    origin = list(cq_plane.origin.toTuple())
    x_axis = list(cq_plane.xDir.toTuple())
    y_axis = list(cq_plane.yDir.toTuple())
    normal = list(cq_plane.zDir.toTuple())

    def uv_to_3d_list(uv: list) -> list:
        return [
            origin[0] + uv[0] * x_axis[0] + uv[1] * y_axis[0],
            origin[1] + uv[0] * x_axis[1] + uv[1] * y_axis[1],
            origin[2] + uv[0] * x_axis[2] + uv[1] * y_axis[2],
        ]

    def build_arc_edge(edge: dict) -> cq_shapes.Edge:
        center_uv = edge.get("center", [0.0, 0.0])
        radius = float(edge.get("radius", 1.0))
        a0_deg = float(edge.get("angle_start_deg", 0.0))
        a1_deg = float(edge.get("angle_end_deg", 360.0))
        ccw = edge.get("ccw", True)

        center_3d = uv_to_3d_list(center_uv)
        span = (
            ((a1_deg - a0_deg) + 360) % 360
            if ccw
            else -(((a0_deg - a1_deg) + 360) % 360)
        )
        if abs(abs(span) - 360.0) < 1e-6:
            return make_arc_edge(center_3d, radius, normal, x_axis, 0.0, 2 * math.pi)

        u0 = math.radians(a0_deg)
        u1 = math.radians(a1_deg)
        if ccw:
            if u1 <= u0:
                u1 += 2 * math.pi
        else:
            if u0 <= u1:
                u0 += 2 * math.pi
            u0, u1 = u1, u0

        return make_arc_edge(center_3d, radius, normal, x_axis, u0, u1)

    def build_wire(loop: list[dict]) -> cq_shapes.Wire:
        edges: list[cq_shapes.Edge] = []
        for edge in loop:
            kind = edge.get("kind", "line")
            if kind == "arc":
                edges.append(build_arc_edge(edge))
            else:
                p1 = uv_to_3d_list(edge["start"])
                p2 = uv_to_3d_list(edge["end"])
                edges.append(make_line_edge(p1, p2))
        return make_wire(edges)

    outer_wire = build_wire(loops[0])
    inner_wires = [build_wire(hole) for hole in loops[1:]]
    return make_face_from_wires(outer_wire, inner_wires if inner_wires else None)


def extrude_profile(
    loops: list[list[dict]],
    plane: Frame3D | dict,
    direction_vec: list[float],
    distance: float,
) -> cq_shapes.Solid:
    """Extrude boundary-edge loops to a solid, unioning disjoint loop groups.

    Multiple loops that are not nested (disjoint closed areas) are each extruded
    separately and boolean-unioned into one solid. Loops that are contained inside
    another loop are treated as holes of that outer boundary.
    """
    groups = classify_loops(loops)
    if not groups:
        raise ValueError("no loops to extrude")

    solid = None
    for outer, holes in groups:
        face = sketch_loops_to_face([outer] + holes, plane)
        part = extrude_face(face, direction_vec, distance)
        if solid is None:
            solid = part
        else:
            solid = boolean_union(solid, part)  # type: ignore[assignment]
    return solid  # type: ignore[return-value]


def revolve_face(
    face: cq_shapes.Face,
    axis_origin: list[float],
    axis_direction: list[float],
    angle_deg: float,
) -> cq_shapes.Solid:
    """Revolve a face around an axis."""
    from oversolved.kernel.cadquery_ops import revolve_face as _revolve_face
    return _revolve_face(face, axis_origin, axis_direction, angle_deg)


def _sort_shape_faces(
    solid: cq_shapes.Shape,
    deflection: float = 0.1,
) -> list[tuple[Any, list, list, list, list, str]]:
    """Return sorted [(face, verts, idxs, centroid, normal, surface_type), ...].

    Sorting places flat faces before curved (so fillet never shifts indices).
    Within each group, sort by (normal, centroid) for determinism.
    """
    raw_faces: list[tuple] = []
    for face in solid.Faces():
        verts, idxs = face.tessellate(deflection)
        centroid = _compute_face_centroid(face)
        normal = _compute_face_normal(face)
        surface_type = _get_face_surface_type(face)
        raw_faces.append((face, verts, idxs, centroid, normal, surface_type))
    raw_faces.sort(key=_face_sort_key_from_tuple)
    return raw_faces


def _append_face_triangles(
    all_vertices: list[list[float]],
    all_faces: list[list[int]],
    all_normals: list[list[float]],
    triangle_to_face: list[int],
    face_idx: int,
    verts: list,
    idxs: list,
) -> tuple[float, int]:
    """Append triangles from one face to accumulator lists.

    Returns (face_area, triangle_count).
    """
    offset = len(all_vertices)
    face_area = 0.0

    for v in verts:
        all_vertices.append(list(v.toTuple()))

    triangle_count_before = len(triangle_to_face)
    for tri in idxs:
        i0 = offset + tri[0]
        i1 = offset + tri[1]
        i2 = offset + tri[2]
        all_faces.append([i0, i1, i2])

        p0 = all_vertices[i0]
        p1 = all_vertices[i1]
        p2 = all_vertices[i2]
        v1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
        v2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
        nx = v1[1] * v2[2] - v1[2] * v2[1]
        ny = v1[2] * v2[0] - v1[0] * v2[2]
        nz = v1[0] * v2[1] - v1[1] * v2[0]
        mag = math.sqrt(nx * nx + ny * ny + nz * nz)
        if mag > 0:
            all_normals.append([nx / mag, ny / mag, nz / mag])
        else:
            all_normals.append([0.0, 0.0, 1.0])
        triangle_to_face.append(face_idx)
        face_area += _triangle_area(p0, p1, p2)

    triangle_count = len(triangle_to_face) - triangle_count_before
    return face_area, triangle_count


def _build_face_query(
    created_by: str | None,
    body_id: str | None,
    face_idx: int,
    centroid: list,
    normal: list,
    face_area: float,
    surface_type: str,
) -> str | None:
    """Return ancestry query string for a face, or None if created_by is None."""
    if not created_by:
        return None
    from oversolved.kernel.geom_hash import face_geometry_hash
    from oversolved.kernel.query import make_ancestry_query

    geom_hash = face_geometry_hash(centroid, normal, face_area)
    if body_id:
        return make_ancestry_query(
            [f"@{geom_hash}", f"@{created_by}", f"@{body_id}"], surface_type
        )
    element_id = f"face{face_idx}"
    abs_id = "@" + created_by + "/" + element_id
    return make_ancestry_query([abs_id, f"@{created_by}"], surface_type)


def _unit_cube_mesh() -> MeshDict:
    """Return a unit cube as fallback mesh."""
    return {
        "vertices": [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
            [0.0, 1.0, 1.0],
        ],
        "faces": [
            [0, 1, 2], [0, 2, 3],
            [4, 5, 6], [4, 6, 7],
            [0, 4, 5], [0, 5, 1],
            [1, 5, 6], [1, 6, 2],
            [2, 6, 7], [2, 7, 3],
            [3, 7, 4], [3, 4, 0],
        ],
        "normals": [
            [0, 0, -1], [0, 0, -1],
            [0, 0, 1], [0, 0, 1],
            [-1, 0, 0], [-1, 0, 0],
            [1, 0, 0], [1, 0, 0],
            [0, 1, 0], [0, 1, 0],
            [0, -1, 0], [0, -1, 0],
        ],
        "face_data": [],
        "triangle_to_face": [],
        "face_queries": [],
        "is_fallback": True,
    }


def _load_shape_from_path(filepath: str) -> cq_shapes.Shape:
    """Load a shape from a STEP or STL file path.

    Raises ValueError for a missing file or unrecognised extension.
    """
    from oversolved.kernel.geometry_io import stl_file_to_shape, step_file_to_shape

    if not os.path.isfile(filepath):
        raise ValueError(f"File not found: {filepath!r}")
    ext = os.path.splitext(filepath)[1].lower()
    if ext in (".stl",):
        return _ensure_cq(stl_file_to_shape(filepath))
    if ext in (".step", ".stp", ""):
        return step_file_to_shape(filepath)
    raise ValueError(f"Unsupported file extension {ext!r}: {filepath!r}")


def _init_mesh_accumulators() -> tuple[
    list[dict],
    list[int],
    list[str],
    list[list[float]],
    list[list[int]],
    list[list[float]],
]:
    """Return six empty accumulator lists for mesh assembly."""
    face_data: list[dict] = []
    triangle_to_face: list[int] = []
    face_queries: list[str] = []
    all_vertices: list[list[float]] = []
    all_faces: list[list[int]] = []
    all_normals: list[list[float]] = []
    return face_data, triangle_to_face, face_queries, all_vertices, all_faces, all_normals


def _tessellate_and_assemble_faces(
    solid: cq_shapes.Shape,
    created_by: str | None,
    body_id: str | None,
) -> tuple[
    list[dict],
    list[int],
    list[str],
    list[list[float]],
    list[list[int]],
    list[list[float]],
]:
    """Iterate faces of solid and assemble mesh accumulators.

    Returns (face_data, triangle_to_face, face_queries, vertices, faces, normals).
    On exception all six lists are returned empty so the caller can detect failure.
    """
    face_data, triangle_to_face, face_queries, all_vertices, all_faces, all_normals = (
        _init_mesh_accumulators()
    )
    try:
        raw_faces = _sort_shape_faces(solid)
        for face_idx, (face, verts, idxs, centroid, normal, surface_type) in enumerate(raw_faces):
            face_area, triangle_count = _append_face_triangles(
                all_vertices, all_faces, all_normals,
                triangle_to_face, face_idx, verts, idxs,
            )
            if triangle_count > 0:
                face_data.append(
                    {"centroid": centroid, "normal": normal, "area": face_area, "surface_type": surface_type}
                )
                query = _build_face_query(created_by, body_id, face_idx, centroid, normal, face_area, surface_type)
                if query:
                    face_queries.append(query)
    except Exception as exc:
        logger.warning("solid_to_mesh tessellation failed, falling back to unit cube: %s", exc)
        return _init_mesh_accumulators()
    return face_data, triangle_to_face, face_queries, all_vertices, all_faces, all_normals


def solid_to_mesh(solid: TopoDS_Shape | str, created_by: str | None = None, body_id: str | None = None) -> MeshDict:
    """Tessellate a cadquery solid to a mesh dict.

    Iterates faces and tessellates each one individually so that face
    ordering and per-face metadata are preserved.

    Args:
        solid: Either a cadquery shape or a filepath string (STEP or STL file).
        created_by: Optional feature ID for ancestry queries.
        body_id: Optional body ID -- when set, face queries are scoped to this
            body so that multiple bodies from the same feature have unique queries.
    """
    if isinstance(solid, str):
        solid = _load_shape_from_path(solid)
    solid = _ensure_cq(solid)

    topo_shape = _ensure_occ(solid)
    try:
        ocp_mesh_shape(topo_shape, 0.1, 0.1)
    except Exception as exc:
        logger.warning("solid_to_mesh: BRepMesh_IncrementalMesh failed: %s", exc)

    fd, t2f, fq, verts, faces, normals = _tessellate_and_assemble_faces(solid, created_by, body_id)
    if not verts:
        logger.warning("solid_to_mesh produced no vertices; returning unit cube fallback")
        return _unit_cube_mesh()

    mesh: MeshDict = {
        "vertices": verts,
        "faces": faces,
        "normals": normals,
        "face_data": fd,
        "triangle_to_face": t2f,
        "face_queries": fq,
        "is_fallback": False,
    }
    _validate_mesh(mesh)
    return mesh


def solid_to_edges(solid: TopoDS_Shape, created_by: str | None = None, body_id: str | None = None) -> EdgeDict:
    """Extract exact edge geometry from a cadquery solid.

    Returns a dict with keys "edges" (list of edge dicts, one per unique edge,
    with kind "line", "circle", "arc", or "spline") and "edge_queries" (list of
    ancestry query strings, populated only when created_by is set).

    body_id: when set, edge queries are scoped to this body for uniqueness.
    """
    if _ensure_occ(solid).IsNull():
        return {"edges": [], "edge_queries": []}
    solid = _ensure_cq(solid)
    TWO_PI = 2.0 * math.pi
    CIRCLE_TOL = 1e-4

    raw_edges: list[tuple] = []
    seen_hashes: set[int] = set()

    for edge in solid.edges():
        h = hash(edge.wrapped)
        if h in seen_hashes:
            continue
        seen_hashes.add(h)

        gt = edge.geomType()

        if gt == "LINE":
            sp = edge.startPoint()
            ep = edge.endPoint()
            ed = {
                "kind": "line",
                "start": [sp.x, sp.y, sp.z],
                "end": [ep.x, ep.y, ep.z],
            }
            # type_order=0 keeps straight edges before curved so fillet arcs
            # don't shift line edge indices.
            sort_key = (0, "line", round(sp.x, 6), round(sp.y, 6), round(sp.z, 6),
                        round(ep.x, 6), round(ep.y, 6), round(ep.z, 6))

        elif gt == "CIRCLE":
            curve = edge._geomAdaptor()
            circ = curve.Circle()
            center = circ.Location()
            ax = circ.Axis().Direction()
            xdir = circ.XAxis().Direction()
            radius = circ.Radius()
            u0 = curve.FirstParameter()
            u1 = curve.LastParameter()
            span = u1 - u0
            is_full = abs(abs(span) - TWO_PI) < CIRCLE_TOL or abs(span) < CIRCLE_TOL
            edge_kind = "circle" if is_full else "arc"
            ed = {
                "kind": edge_kind,
                "center": [center.X(), center.Y(), center.Z()],
                "radius": radius,
                "axis": [ax.X(), ax.Y(), ax.Z()],
                "x_axis": [xdir.X(), xdir.Y(), xdir.Z()],
                "angle_start": u0,
                "angle_end": u1,
            }
            sort_key = (1, edge_kind, round(center.X(), 6), round(center.Y(), 6),
                        round(center.Z(), 6), round(radius, 6), round(u0, 6), round(u1, 6))

        else:
            n_pts = 16
            curve = edge._geomAdaptor()
            u0 = curve.FirstParameter()
            u1 = curve.LastParameter()
            points = []
            for i in range(n_pts + 1):
                t = u0 + (u1 - u0) * i / n_pts
                pt = edge.positionAt(t, mode="parameter")
                points.append([pt.x, pt.y, pt.z])
            ed = {"kind": "spline", "points": points}
            mid = points[n_pts // 2]
            sort_key = (1, "spline", round(mid[0], 6), round(mid[1], 6), round(mid[2], 6), 0.0, 0.0, 0.0)

        raw_edges.append((ed, sort_key))

    # Sort for deterministic edge indices across OCC iteration order variations.
    raw_edges.sort(key=lambda item: item[1])

    edges: list[dict] = []
    edge_queries: list[str] = []

    for idx, (ed, _) in enumerate(raw_edges):
        edges.append(ed)
        if created_by:
            from oversolved.kernel.geom_hash import edge_geometry_hash
            from oversolved.kernel.query import make_ancestry_query

            geom_hash = edge_geometry_hash(ed)
            edge_type = "straightedge" if ed["kind"] == "line" else "edge"
            if body_id:
                edge_queries.append(make_ancestry_query([f"@{geom_hash}", f"@{created_by}", f"@{body_id}"], edge_type))
            else:
                edge_queries.append(make_ancestry_query([f"@{created_by}edge{idx}", f"@{created_by}"], edge_type))

    return {"edges": edges, "edge_queries": edge_queries}


def solid_to_vertices(solid: TopoDS_Shape, created_by: str | None = None, body_id: str | None = None) -> VertexDict:
    """Extract unique B-rep vertices from a cadquery solid."""
    if _ensure_occ(solid).IsNull():
        return {"vertices": [], "vertex_queries": []}
    solid = _ensure_cq(solid)
    vertices: list[list[float]] = []
    vertex_queries: list[str] = []
    seen_hashes: set[int] = set()

    for v in solid.Vertices():
        h = hash(v.wrapped)
        if h in seen_hashes:
            continue
        seen_hashes.add(h)
        vertices.append([v.X, v.Y, v.Z])
        if created_by:
            from oversolved.kernel.geom_hash import vertex_geometry_hash
            from oversolved.kernel.query import make_ancestry_query

            idx = len(vertices) - 1
            geom_hash = vertex_geometry_hash([v.X, v.Y, v.Z])
            if body_id:
                vertex_queries.append(make_ancestry_query([f"@{geom_hash}", f"@{created_by}", f"@{body_id}"], "vertex"))
            else:
                vertex_queries.append(make_ancestry_query([f"@{created_by}vertex{idx}", f"@{created_by}"], "vertex"))

    return {"vertices": vertices, "vertex_queries": vertex_queries}
