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
    revolve_face as _revolve_face,
    to_cq_plane,
)
from oversolved.kernel.geom_hash import (
    edge_geometry_hash,
    face_geometry_hash,
    vertex_geometry_hash,
)
from oversolved.kernel.geometry_io import stl_file_to_shape, step_file_to_shape
from oversolved.kernel.profile_loops import classify_loops
from oversolved.kernel.query import make_ancestry_query, ref
from oversolved.kernel.types3d import Frame3D

logger = logging.getLogger(__name__)


class MeshDict(TypedDict):
    vertices: list[list[float]]
    faces: list[list[int]]
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
    """Validate mesh data: no NaN/inf vertices, valid face indices.

    Raises ValueError with descriptive message if mesh is invalid.
    """
    verts = mesh["vertices"]
    faces = mesh["faces"]
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

    def full_circle_of(loop: list[dict]) -> dict | None:
        """If every edge of the loop is an arc on one shared circle, return a
        single full-circle edge dict for it, else None.

        The sketch layer represents a standalone circle as two 180 degree arcs
        (see topology._circle_arcs). Handed to OCC as two edges, that yields two
        half-cylinder faces on extrude. Emitting one closed circle edge instead
        makes OCC build a single cylindrical face with a proper periodic seam.
        """
        if len(loop) < 2 or any(e.get("kind") != "arc" for e in loop):
            return None
        c0 = loop[0].get("center")
        r0 = loop[0].get("radius")
        if c0 is None or r0 is None:
            return None
        for e in loop:
            c = e.get("center")
            r = e.get("radius")
            if c is None or r is None:
                return None
            if abs(r - r0) > 1e-9 or abs(c[0] - c0[0]) > 1e-9 or abs(c[1] - c0[1]) > 1e-9:
                return None
        return {
            "kind": "arc", "center": list(c0), "radius": r0,
            "angle_start_deg": 0.0, "angle_end_deg": 360.0, "ccw": True,
            "start": [c0[0] + r0, c0[1]], "end": [c0[0] + r0, c0[1]],
        }

    def build_wire(loop: list[dict]) -> cq_shapes.Wire:
        circle = full_circle_of(loop)
        if circle is not None:
            return make_wire([build_arc_edge(circle)])
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


def _entity_to_occ_edge_map(
    face: cq_shapes.Face, loops: list[list[dict]], plane: Frame3D | dict,
) -> dict[int, str]:
    """Map hash(occ_edge) -> sketch_entity_id by matching endpoint geometry.

    The OCC face edges are matched to sketch edge dicts by comparing their
    3D start/end points after applying the plane transform. Returns a dict
    suitable for subsequent MakePrism.Generated() queries.
    """
    def _uv_to_3d(uv: list) -> list[float]:
        origin = plane.get("origin", [0.0, 0.0, 0.0]) if isinstance(plane, dict) else plane.origin
        x_axis = plane.get("x_axis", [1.0, 0.0, 0.0]) if isinstance(plane, dict) else plane.x_axis
        y_axis = plane.get("y_axis", [0.0, 1.0, 0.0]) if isinstance(plane, dict) else plane.y_axis
        return [
            origin[i] + uv[0] * x_axis[i] + uv[1] * y_axis[i]
            for i in range(3)
        ]

    def _points_match(a: list[float], b: Any) -> bool:
        """Compare 3D list to a point-like object within tolerance."""
        bx, by, bz = b.x, b.y, b.z
        return (
            abs(a[0] - bx) < 1e-6 and abs(a[1] - by) < 1e-6 and abs(a[2] - bz) < 1e-6
        )

    occ_edges = list(face.Edges())
    mapping: dict[int, str] = {}
    for loop in loops:
        for entity in loop:
            eid = entity.get("id", "")
            if not eid:
                continue
            start_3d = _uv_to_3d(entity.get("start", [0.0, 0.0]))
            end_3d = _uv_to_3d(entity.get("end", [0.0, 0.0]))
            for occ_e in occ_edges:
                if hash(occ_e) in mapping:
                    continue
                sp = occ_e.startPoint()
                ep = occ_e.endPoint()
                if (_points_match(start_3d, sp) and _points_match(end_3d, ep)) or \
                   (_points_match(start_3d, ep) and _points_match(end_3d, sp)):
                    mapping[hash(occ_e)] = eid
                    break
    return mapping


def _build_prism_lineage_map(
    occ_face: Any, prism_builder: Any, entity_map: dict[int, str],
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Use MakePrism.Generated() to map solid subshapes to profile entity IDs.

    Returns (face_lineage, edge_lineage) where each maps solid subshape hash
    to a list of profile entity tokens.
    """
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415
    from OCP.TopTools import (  # noqa: PLC0415
        TopTools_IndexedDataMapOfShapeListOfShape,
    )

    solid_shape = prism_builder.Shape()

    # profile edge → solid lateral face via Generated()
    profile_edge_to_face: dict[int, int] = {}
    exp = TopExp_Explorer(occ_face, TopAbs_EDGE)
    while exp.More():
        occ_e = exp.Current()
        eh = hash(occ_e)
        if eh in entity_map:
            try:
                generated = prism_builder.Generated(occ_e)
                if not generated.IsNull():
                    gen_exp = TopExp_Explorer(generated, TopAbs_FACE)
                    while gen_exp.More():
                        profile_edge_to_face[hash(gen_exp.Current())] = eh
                        gen_exp.Next()
            except Exception:
                pass
        exp.Next()

    # solid face → profile entity tokens
    face_lineage: dict[str, list[str]] = {}
    face_exp = TopExp_Explorer(solid_shape, TopAbs_FACE)
    while face_exp.More():
        sf = face_exp.Current()
        sh = hash(sf)
        entity_ids: list[str] = []
        peh = profile_edge_to_face.get(sh)
        if peh is not None:
            eid = entity_map.get(peh, "")
            if eid:
                entity_ids.append(eid)
        face_lineage[str(sh)] = entity_ids
        face_exp.Next()

    # solid edge → profile entity tokens (from adjacent faces + vertices)
    # Build edge→face adjacency map
    e2f = TopTools_IndexedDataMapOfShapeListOfShape()
    from OCP.TopExp import TopExp  # noqa: PLC0415
    TopExp.MapShapesAndAncestors_s(solid_shape, TopAbs_EDGE, TopAbs_FACE, e2f)

    edge_lineage: dict[str, list[str]] = {}
    edge_exp = TopExp_Explorer(solid_shape, TopAbs_EDGE)
    while edge_exp.More():
        se = edge_exp.Current()
        sh = hash(se)
        edge_entity_ids: list[str] = []
        face_list = e2f.FindFromKey(se)
        seen: set[str] = set()
        for face in face_list:
            fh = hash(face)
            for eid in face_lineage.get(str(fh), []):
                if eid not in seen:
                    seen.add(eid)
                    edge_entity_ids.append(eid)
        edge_lineage[str(sh)] = edge_entity_ids
        edge_exp.Next()

    return face_lineage, edge_lineage


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


def extrude_profile_with_lineage(
    loops: list[list[dict]],
    plane: Frame3D | dict,
    direction_vec: list[float],
    distance: float,
    sketch_id: str = "",
) -> tuple[cq_shapes.Solid, dict[str, list[str]], dict[str, list[str]]]:
    """Extrude loops and return (solid, face_lineage, edge_lineage).

    Lineage maps solid subshape hash (str) to lists of source profile
    entity tokens (@sketch_id/entity). These are used by tessellation to
    attach per-entity ancestry to each face/edge, enabling within-profile
    disambiguation without relying on geometry hashes.
    """
    from oversolved.kernel.ocp_ops import ocp_make_prism_lineage  # noqa: PLC0415
    scaled_vec = [v * distance for v in direction_vec]
    groups = classify_loops(loops)
    if not groups:
        raise ValueError("no loops to extrude")

    solid = None
    all_face_lineage: dict[str, list[str]] = {}
    all_edge_lineage: dict[str, list[str]] = {}

    for outer, holes in groups:
        face = sketch_loops_to_face([outer] + holes, plane)
        entity_map = _entity_to_occ_edge_map(face, [outer] + holes, plane)
        occ_face = _ensure_occ(face)
        _prism_shape, builder = ocp_make_prism_lineage(occ_face, scaled_vec)
        lineage = _build_prism_lineage_map(occ_face, builder, entity_map)
        face_l, edge_l = lineage

        # Prepend sketch_id to entity tokens for full @sketch_id/entity format.
        token_prefix = f"@{sketch_id}/" if sketch_id else "@"
        for tokens in face_l.values():
            tokens[:] = [t if t.startswith("@") else token_prefix + t for t in tokens]
        for tokens in edge_l.values():
            tokens[:] = [t if t.startswith("@") else token_prefix + t for t in tokens]

        part = cq_shapes.Solid(_prism_shape)

        all_face_lineage.update(face_l)
        all_edge_lineage.update(edge_l)

        if solid is None:
            solid = part
        else:
            solid = boolean_union(solid, part)  # type: ignore[assignment]

    return solid, all_face_lineage, all_edge_lineage  # type: ignore[return-value]


def revolve_profile_with_lineage(
    loops: list[list[dict]],
    plane: Frame3D | dict,
    axis_origin: list[float],
    axis_direction: list[float],
    angle_deg: float,
    sketch_id: str = "",
) -> tuple[cq_shapes.Solid, dict[str, list[str]], dict[str, list[str]]]:
    """Revolve loops and return (solid, face_lineage, edge_lineage).

    Uses BRepPrimAPI_MakeRevol.Generated() to track per-face/edge lineage,
    analogous to extrude_profile_with_lineage for MakePrism.
    """
    from oversolved.kernel.ocp_ops import ocp_make_revol_lineage  # noqa: PLC0415
    import math as _math

    angle_rad = _math.radians(angle_deg)
    face = sketch_loops_to_face(loops, plane)
    entity_map = _entity_to_occ_edge_map(face, loops, plane)

    occ_face = _ensure_occ(face)
    shape, builder = ocp_make_revol_lineage(occ_face, axis_origin, axis_direction, angle_rad)
    face_lineage, edge_lineage = _build_prism_lineage_map(occ_face, builder, entity_map)

    # Prepend sketch_id to entity tokens.
    token_prefix = f"@{sketch_id}/" if sketch_id else "@"
    for tokens in face_lineage.values():
        tokens[:] = [t if t.startswith("@") else token_prefix + t for t in tokens]
    for tokens in edge_lineage.values():
        tokens[:] = [t if t.startswith("@") else token_prefix + t for t in tokens]

    solid = cq_shapes.Solid(shape)
    return solid, face_lineage, edge_lineage


def revolve_face(
    face: cq_shapes.Face,
    axis_origin: list[float],
    axis_direction: list[float],
    angle_deg: float,
) -> cq_shapes.Solid:
    """Revolve a face around an axis."""
    return _revolve_face(face, axis_origin, axis_direction, angle_deg)


def _sort_shape_faces(
    solid: cq_shapes.Shape,
    deflection: float = 0.1,
    angular_deflection: float = 0.1,
) -> list[tuple[Any, list, list, list, list, str]]:
    """Return sorted [(face, verts, idxs, centroid, normal, surface_type), ...].

    Sorting places flat faces before curved (so fillet never shifts indices).
    Within each group, sort by (normal, centroid) for determinism.
    """
    raw_faces: list[tuple] = []
    for face in solid.Faces():
        verts, idxs = face.tessellate(deflection, angular_deflection)
        centroid = _compute_face_centroid(face)
        normal = _compute_face_normal(face)
        surface_type = _get_face_surface_type(face)
        raw_faces.append((face, verts, idxs, centroid, normal, surface_type))
    raw_faces.sort(key=_face_sort_key_from_tuple)
    return raw_faces


def _append_face_triangles(
    all_vertices: list[list[float]],
    all_faces: list[list[int]],
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
    surface_type: str,
    profile_queries: list[str] | None = None,
    face_tokens: list[str] | None = None,
) -> str | None:
    """Return ancestry query string for a face, or None if created_by is None."""
    if not created_by:
        return None
    geom_hash = face_geometry_hash(centroid, normal)
    if body_id:
        ids = [ref(geom_hash), ref(created_by), ref(body_id)]
        if face_tokens:
            ids.extend(face_tokens)
        elif profile_queries:
            ids.extend(profile_queries)
        return make_ancestry_query(ids, surface_type)
    element_id = f"face{face_idx}"
    abs_id = ref(created_by) + "/" + element_id
    return make_ancestry_query([abs_id, ref(created_by)], surface_type)


def _face_tokens(face: Any, face_lineage: dict[str, list[str]] | None) -> list[str]:
    """Get per-face entity tokens from the lineage map, or empty list."""
    if face_lineage is None:
        return []
    try:
        fh = str(hash(face.wrapped))
    except Exception:
        return []
    return face_lineage.get(fh, [])


def _edge_lineage_tokens(ed: dict, edge_lineage: dict[str, list[str]] | None) -> list[str]:
    """Get per-edge entity tokens from the lineage map, or empty list."""
    if edge_lineage is None:
        return []
    eh = ed.get("_occ_hash", "")
    if not eh:
        return []
    return edge_lineage.get(eh, [])


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
        "face_data": [],
        "triangle_to_face": [],
        "face_queries": [],
        "is_fallback": True,
    }


def _load_shape_from_path(filepath: str) -> cq_shapes.Shape:
    """Load a shape from a STEP or STL file path.

    Raises ValueError for a missing file or unrecognised extension.
    """
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
]:
    """Return five empty accumulator lists for mesh assembly."""
    face_data: list[dict] = []
    triangle_to_face: list[int] = []
    face_queries: list[str] = []
    all_vertices: list[list[float]] = []
    all_faces: list[list[int]] = []
    return face_data, triangle_to_face, face_queries, all_vertices, all_faces


def _tessellate_and_assemble_faces(
    solid: cq_shapes.Shape,
    created_by: str | None,
    body_id: str | None,
    profile_queries: list[str] | None = None,
    face_lineage: dict[str, list[str]] | None = None,
    deflection: float = 0.1,
    angular_deflection: float = 0.1,
) -> tuple[
    list[dict],
    list[int],
    list[str],
    list[list[float]],
    list[list[int]],
]:
    """Iterate faces of solid and assemble mesh accumulators.

    Returns (face_data, triangle_to_face, face_queries, vertices, faces).
    On exception all five lists are returned empty so the caller can detect failure.
    """
    face_data, triangle_to_face, face_queries, all_vertices, all_faces = (
        _init_mesh_accumulators()
    )
    try:
        raw_faces = _sort_shape_faces(solid, deflection=deflection, angular_deflection=angular_deflection)
        for face_idx, (face, verts, idxs, centroid, normal, surface_type) in enumerate(raw_faces):
            face_area, triangle_count = _append_face_triangles(
                all_vertices, all_faces,
                triangle_to_face, face_idx, verts, idxs,
            )
            if triangle_count > 0:
                face_data.append(
                    {"centroid": centroid, "normal": normal, "area": face_area, "surface_type": surface_type}
                )
                query = _build_face_query(
                    created_by, body_id, face_idx, centroid, normal,
                    surface_type, profile_queries=profile_queries,
                    face_tokens=_face_tokens(face, face_lineage),
                )
                if query:
                    face_queries.append(query)
    except Exception as exc:
        logger.warning("solid_to_mesh tessellation failed, falling back to unit cube: %s", exc)
        return _init_mesh_accumulators()
    return face_data, triangle_to_face, face_queries, all_vertices, all_faces


def solid_to_mesh(
    solid: TopoDS_Shape | str,
    created_by: str | None = None,
    body_id: str | None = None,
    profile_queries: list[str] | None = None,
    face_lineage: dict[str, list[str]] | None = None,
    deflection: float = 0.1,
    angular_deflection: float = 0.1,
) -> MeshDict:
    """Tessellate a cadquery solid to a mesh dict.

    Iterates faces and tessellates each one individually so that face
    ordering and per-face metadata are preserved.

    Args:
        solid: Either a cadquery shape or a filepath string (STEP or STL file).
        created_by: Optional feature ID for ancestry queries.
        body_id: Optional body ID -- when set, face queries are scoped to this
            body so that multiple bodies from the same feature have unique queries.
        profile_queries: Optional profile-layer entity tokens to include in
            ancestry queries, so queries survive geometry changes.
        deflection: Linear deflection for tessellation (default 0.1).
        angular_deflection: Angular deflection in radians (default 0.1).
    """
    if isinstance(solid, str):
        solid = _load_shape_from_path(solid)
    solid = _ensure_cq(solid)

    fd, t2f, fq, verts, faces = _tessellate_and_assemble_faces(
        solid, created_by, body_id, profile_queries, face_lineage,
        deflection=deflection, angular_deflection=angular_deflection,
    )
    if not verts:
        logger.warning("solid_to_mesh produced no vertices; returning unit cube fallback")
        return _unit_cube_mesh()

    mesh: MeshDict = {
        "vertices": verts,
        "faces": faces,
        "face_data": fd,
        "triangle_to_face": t2f,
        "face_queries": fq,
        "is_fallback": False,
    }
    _validate_mesh(mesh)
    return mesh


def _build_seam_hashes(occ_solid: Any) -> set[int]:
    """Return Python hashes of TopoDS_Edge shapes that are seam edges.

    A seam edge has both its adjacent faces being the same face (the periodic
    surface wraps around). Detected by finding edges with only one unique
    adjacent face in the edge-to-face adjacency map.
    """
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape  # noqa: PLC0415
    from OCP.TopExp import TopExp  # noqa: PLC0415

    e2f: TopTools_IndexedDataMapOfShapeListOfShape = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(occ_solid, TopAbs_EDGE, TopAbs_FACE, e2f)

    seam_hashes: set[int] = set()
    for i in range(1, e2f.Size() + 1):
        face_list = e2f.FindFromIndex(i)
        unique: set[int] = {hash(face) for face in face_list}
        if len(unique) == 1:
            seam_hashes.add(hash(e2f.FindKey(i)))
    return seam_hashes


def _extract_nurbs_curve_data(curve: Any) -> dict[str, Any]:
    """Extract exact NURBS/analytic curve parameters from a BRepAdaptor_Curve.

    Returns a dict of stable geometry data that can be used to compute a
    geometry hash without evaluating the curve (no tessellation dependency).
    Returns an empty dict for unrecognized curve types.
    """
    from OCP.GeomAbs import (
        GeomAbs_BSplineCurve, GeomAbs_BezierCurve,
        GeomAbs_Ellipse, GeomAbs_Hyperbola, GeomAbs_Parabola,
        GeomAbs_OffsetCurve,
    )

    curve_type = curve.GetType()

    if curve_type == GeomAbs_BSplineCurve:
        bspline = curve.BSpline()
        np = bspline.NbPoles()
        return {
            "type": "BSpline",
            "degree": bspline.Degree(),
            "poles": [[round(float(bspline.Pole(i).X()), 4),
                       round(float(bspline.Pole(i).Y()), 4),
                       round(float(bspline.Pole(i).Z()), 4)]
                      for i in range(1, np + 1)],
            "weights": [round(float(bspline.Weight(i)), 4) for i in range(1, np + 1)],
            "knots": [round(float(bspline.Knot(i)), 4) for i in range(1, bspline.NbKnots() + 1)],
        }

    if curve_type == GeomAbs_BezierCurve:
        bezier = curve.Bezier()
        np = bezier.NbPoles()
        return {
            "type": "Bezier",
            "poles": [[round(float(bezier.Pole(i).X()), 4),
                       round(float(bezier.Pole(i).Y()), 4),
                       round(float(bezier.Pole(i).Z()), 4)]
                      for i in range(1, np + 1)],
        }

    if curve_type == GeomAbs_Ellipse:
        ell = curve.Ellipse()
        loc = ell.Location()
        return {
            "type": "Ellipse",
            "center": [round(float(loc.X()), 4), round(float(loc.Y()), 4), round(float(loc.Z()), 4)],
            "major_radius": round(float(ell.MajorRadius()), 4),
            "minor_radius": round(float(ell.MinorRadius()), 4),
        }

    if curve_type == GeomAbs_Hyperbola:
        hyp = curve.Hyperbola()
        loc = hyp.Location()
        return {
            "type": "Hyperbola",
            "center": [round(float(loc.X()), 4), round(float(loc.Y()), 4), round(float(loc.Z()), 4)],
            "major_radius": round(float(hyp.MajorRadius()), 4),
            "minor_radius": round(float(hyp.MinorRadius()), 4),
        }

    if curve_type == GeomAbs_Parabola:
        par = curve.Parabola()
        foc = par.Focus()
        return {
            "type": "Parabola",
            "focus": [round(float(foc.X()), 4), round(float(foc.Y()), 4), round(float(foc.Z()), 4)],
            "focal_length": round(float(par.Focal()), 4),
        }

    if curve_type == GeomAbs_OffsetCurve:
        return {
            "type": "Offset",
            "offset": round(float(curve.OffsetValue()), 4),
        }

    return {}


def edge_to_geom_dict(edge: Any) -> tuple[dict, tuple]:
    """Return (geometry dict, sort key) for a cadquery edge.

    Shared by solid_to_edges and the fillet edge resolver so both compute the
    exact same edge_geometry_hash. The sort key gives deterministic edge
    indices independent of OCC iteration order. The dict omits the "seam" flag
    (callers add it when relevant); "seam" is not part of the geometry hash.
    """
    TWO_PI = 2.0 * math.pi
    CIRCLE_TOL = 1e-4
    gt = edge.geomType()
    ed: dict[str, Any] = {}

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
        sort_key: tuple[Any, ...] = (0, "line", round(sp.x, 6), round(sp.y, 6), round(sp.z, 6),
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
        # x_axis breaks the tie between the two semicircle halves OCC
        # produces for a full circle (same center/radius/span); without it
        # their relative index would depend on OCC iteration order.
        sort_key = (1, edge_kind, round(center.X(), 6), round(center.Y(), 6),
                    round(center.Z(), 6), round(radius, 6), round(u0, 6), round(u1, 6),
                    round(xdir.X(), 6), round(xdir.Y(), 6), round(xdir.Z(), 6))

    else:
        curve = edge._geomAdaptor()
        u0 = curve.FirstParameter()
        u1 = curve.LastParameter()

        curve_data = _extract_nurbs_curve_data(curve)
        n_pts = 32
        points = []
        for i in range(n_pts + 1):
            t = u0 + (u1 - u0) * i / n_pts
            pt = edge.positionAt(t, mode="parameter")
            points.append([pt.x, pt.y, pt.z])
        ed = {"kind": "spline", "curve_data": curve_data, "points": points}
        mid = points[n_pts // 2]
        sort_key = (1, "spline", round(mid[0], 6), round(mid[1], 6), round(mid[2], 6), 0.0, 0.0, 0.0)

    return ed, sort_key


def solid_to_edges(solid: TopoDS_Shape, created_by: str | None = None, body_id: str | None = None, profile_queries: list[str] | None = None, edge_lineage: dict[str, list[str]] | None = None) -> EdgeDict:
    """Extract exact edge geometry from a cadquery solid.

    Returns a dict with keys "edges" (list of edge dicts, one per unique edge,
    with kind "line", "circle", "arc", or "spline") and "edge_queries" (list of
    ancestry query strings, populated only when created_by is set).

    body_id: when set, edge queries are scoped to this body for uniqueness.
    profile_queries: when set, included in ancestry queries for stable identity.
    """
    occ_solid = _ensure_occ(solid)
    if occ_solid.IsNull():
        return {"edges": [], "edge_queries": []}
    solid = _ensure_cq(solid)

    seam_hashes = _build_seam_hashes(occ_solid)

    raw_edges: list[tuple] = []
    seen_hashes: set[int] = set()

    for edge in solid.edges():
        h = hash(edge.wrapped)
        if h in seen_hashes:
            continue
        seen_hashes.add(h)

        ed, sort_key = edge_to_geom_dict(edge)
        if h in seam_hashes:
            ed["seam"] = True  # type: ignore[assignment]
        ed["_occ_hash"] = str(h)
        raw_edges.append((ed, sort_key))

    # Sort for deterministic edge indices across OCC iteration order variations.
    raw_edges.sort(key=lambda item: item[1])

    edges: list[dict] = []
    edge_queries: list[str] = []

    for idx, (ed, _) in enumerate(raw_edges):
        edges.append(ed)
        if created_by:
            geom_hash = edge_geometry_hash(ed)
            edge_type = "straightedge" if ed["kind"] == "line" else "edge"
            if body_id:
                ids = [ref(geom_hash), ref(created_by), ref(body_id)]
                e_tokens = _edge_lineage_tokens(ed, edge_lineage)
                if e_tokens:
                    ids.extend(e_tokens)
                elif profile_queries:
                    ids.extend(profile_queries)
                edge_queries.append(make_ancestry_query(ids, edge_type))
            else:
                # no body_id — geom-hash + created_by, never index-ref
                edge_queries.append(make_ancestry_query([ref(geom_hash), ref(created_by)], edge_type))

    return {"edges": edges, "edge_queries": edge_queries}


def solid_to_vertices(solid: TopoDS_Shape, created_by: str | None = None, body_id: str | None = None, profile_queries: list[str] | None = None) -> VertexDict:
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
            geom_hash = vertex_geometry_hash([v.X, v.Y, v.Z])
            if body_id:
                ids = [ref(geom_hash), ref(created_by), ref(body_id)]
                if profile_queries:
                    ids.extend(profile_queries)
                vertex_queries.append(make_ancestry_query(ids, "vertex"))
            else:
                # no body_id — geom-hash + created_by, never index-ref
                vertex_queries.append(make_ancestry_query([ref(geom_hash), ref(created_by)], "vertex"))

    return {"vertices": vertices, "vertex_queries": vertex_queries}
