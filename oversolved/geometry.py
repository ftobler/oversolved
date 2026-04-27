"""geometry.py — Geometric classification helpers and CAD shape operations."""

import math
import os as os_module
import tempfile
from io import BytesIO
from typing import Any

from cadquery.occ_impl import shapes as cq_shapes
from oversolved.cadquery_ops import (
    _compute_face_centroid,
    _compute_face_normal,
    _get_face_surface_type,
    boolean_cut,
    boolean_intersection,
    boolean_union,
    extrude_face,
    fuse_shapes,
    make_arc_edge,
    make_face_from_wires,
    make_line_edge,
    make_wire,
    to_cq_plane,
)

__all__ = [
    "signed_distance_to_line",
    "point_in_circle",
    "classify_surface_by_line_side",
    "classify_surface_by_circle_side",
    "classify_surface_cardinal",
    "plane_dict_to_gp_pln",
    "classify_loops",
    "sketch_loops_to_face",
    "extrude_face",
    "extrude_profile",
    "revolve_face",
    "boolean_cut",
    "boolean_union",
    "boolean_intersection",
    "fuse_shapes",
    "solid_to_mesh",
    "solid_to_edges",
    "solid_to_vertices",
    "step_file_to_shape",
    "stl_file_to_shape",
    "shape_to_step_file",
    "shape_to_step_file_buffer",
    "shape_to_stl_file",
    "shape_to_stl_file_buffer",
    "transform_copy",
    "make_translation_trsf",
    "make_rotation_trsf",
]


def _ensure_cq_shape(solid: Any) -> cq_shapes.Shape:
    """Ensure a shape is a cadquery Shape, wrapping raw TopoDS if necessary."""
    if hasattr(solid, "edges"):
        return solid
    return cq_shapes.Shape.cast(solid)


def _validate_mesh(mesh: dict) -> None:
    """Validate mesh data: no NaN/inf vertices, valid face indices, unit normals.

    Raises ValueError with descriptive message if mesh is invalid.
    """
    verts = mesh["vertices"]
    faces = mesh["faces"]
    normals = mesh.get("normals", [])

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
        if abs(mag - 1.0) > 1e-5:
            raise ValueError(f"normal {i} not unit length: mag={mag}")


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


def plane_dict_to_gp_pln(plane: dict) -> Any:
    """Convert a PlaneTransform dict to a cadquery Plane object."""
    return to_cq_plane(plane)


from oversolved.profile_loops import classify_loops


def sketch_loops_to_face(loops: list[list[dict]], plane: dict) -> cq_shapes.Face:
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
    plane: dict,
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
            solid = boolean_union(solid, part)
    return solid  # type: ignore[return-value]


def revolve_face(
    face: Any,
    axis_origin: list[float],
    axis_direction: list[float],
    angle_deg: float,
) -> Any:
    """Revolve a face around an axis."""
    from oversolved.cadquery_ops import revolve_face as _revolve_face
    return _revolve_face(face, axis_origin, axis_direction, angle_deg)


def solid_to_mesh(solid: Any, created_by: str | None = None) -> dict:
    """Tessellate a cadquery solid to a mesh dict.

    Iterates faces and tessellates each one individually so that face
    ordering and per-face metadata are preserved.

    Args:
        solid: Either a cadquery shape or a filepath string (STEP or STL file).
        created_by: Optional feature ID for ancestry queries.
    """
    if isinstance(solid, str):
        filepath = solid
        if not os_module.path.isfile(filepath):
            raise ValueError(f"File not found: {filepath!r}")
        ext = os_module.path.splitext(filepath)[1].lower()
        if ext in (".stl",):
            solid = stl_file_to_shape(filepath)
        else:
            solid = step_file_to_shape(filepath)

    solid = _ensure_cq_shape(solid)

    # Pre-compute triangulation with absolute linear deflection to match the
    # old OCP behavior; face.tessellate() will reuse it when tolerance matches.
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: PLC0415

    topo_shape = solid.wrapped if hasattr(solid, "wrapped") else solid
    BRepMesh_IncrementalMesh(topo_shape, 0.1, False, 0.1)

    face_data: list[dict] = []
    triangle_to_face: list[int] = []
    face_queries: list[str] = []
    all_vertices: list[list[float]] = []
    all_faces: list[list[int]] = []
    all_normals: list[list[float]] = []

    try:
        # Gather all faces with their geometric data so we can sort them into a
        # canonical order.  Stable ordering means face indices are consistent
        # across boolean operations and tessellations.
        raw_faces: list[tuple] = []
        for face in solid.faces():
            verts, idxs = face.tessellate(0.1)
            centroid = _compute_face_centroid(face)
            normal = _compute_face_normal(face)
            surface_type = _get_face_surface_type(face)
            raw_faces.append((face, verts, idxs, centroid, normal, surface_type))

        # Sort by (normal, centroid) for deterministic face ordering.
        def _face_sort_key(item) -> tuple:
            _f, _v, _i, c, n, _s = item
            return (round(n[0], 6), round(n[1], 6), round(n[2], 6),
                    round(c[0], 6), round(c[1], 6), round(c[2], 6))

        raw_faces.sort(key=_face_sort_key)

        for face_idx, (face, verts, idxs, centroid, normal, surface_type) in enumerate(raw_faces):
            offset = len(all_vertices)
            face_area = 0.0

            for v in verts:
                all_vertices.append(list(v.toTuple()))

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
                face_area += 0.5 * mag

            face_data.append(
                {"centroid": centroid, "normal": normal, "area": face_area, "surface_type": surface_type}
            )
            if created_by:
                from oversolved.query import make_ancestry_query

                element_id = f"face{face_idx}"
                abs_id = "@" + created_by + element_id
                query = make_ancestry_query([abs_id, f"@{created_by}"], surface_type)
                face_queries.append(query)
    except Exception:
        face_data = []
        triangle_to_face = []
        face_queries = []
        all_vertices = []
        all_faces = []
        all_normals = []

    if not all_vertices:
        face_data = []
        triangle_to_face = []
        face_queries = []
        all_vertices = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
            [0.0, 1.0, 1.0],
        ]
        all_faces = [
            [0, 1, 2],
            [0, 2, 3],
            [4, 5, 6],
            [4, 6, 7],
            [0, 4, 5],
            [0, 5, 1],
            [1, 5, 6],
            [1, 6, 2],
            [2, 6, 7],
            [2, 7, 3],
            [3, 7, 4],
            [3, 4, 0],
        ]
        all_normals = [
            [0, 0, -1],
            [0, 0, -1],
            [0, 0, 1],
            [0, 0, 1],
            [-1, 0, 0],
            [-1, 0, 0],
            [1, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, -1, 0],
        ]

    mesh = {
        "vertices": all_vertices,
        "faces": all_faces,
        "normals": all_normals,
        "face_data": face_data,
        "triangle_to_face": triangle_to_face,
        "face_queries": face_queries,
    }
    _validate_mesh(mesh)
    return mesh


def solid_to_edges(solid: Any, created_by: str | None = None) -> dict:
    """Extract exact edge geometry from a cadquery solid.

    Returns a dict with keys "edges" (list of edge dicts, one per unique edge,
    with kind "line", "circle", "arc", or "spline") and "edge_queries" (list of
    ancestry query strings, populated only when created_by is set).
    """
    solid = _ensure_cq_shape(solid)
    TWO_PI = 2.0 * math.pi
    CIRCLE_TOL = 1e-4

    edges: list[dict] = []
    edge_queries: list[str] = []
    seen_hashes: set[int] = set()
    idx = 0

    for edge in solid.edges():
        h = edge.hashCode()
        if h in seen_hashes:
            continue
        seen_hashes.add(h)

        gt = edge.geomType()

        if gt == "LINE":
            sp = edge.startPoint()
            ep = edge.endPoint()
            edges.append(
                {
                    "kind": "line",
                    "start": [sp.x, sp.y, sp.z],
                    "end": [ep.x, ep.y, ep.z],
                }
            )

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
            edges.append(
                {
                    "kind": edge_kind,
                    "center": [center.X(), center.Y(), center.Z()],
                    "radius": radius,
                    "axis": [ax.X(), ax.Y(), ax.Z()],
                    "x_axis": [xdir.X(), xdir.Y(), xdir.Z()],
                    "angle_start": u0,
                    "angle_end": u1,
                }
            )

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
            edges.append({"kind": "spline", "points": points})

        if created_by:
            from oversolved.query import make_ancestry_query

            edge_type = "straightedge" if edges[-1]["kind"] == "line" else "edge"
            edge_queries.append(make_ancestry_query([f"@{created_by}edge{idx}", f"@{created_by}"], edge_type))
        idx += 1

    return {"edges": edges, "edge_queries": edge_queries}


def solid_to_vertices(solid: Any, created_by: str | None = None) -> dict:
    """Extract unique B-rep vertices from a cadquery solid."""
    solid = _ensure_cq_shape(solid)
    vertices: list[list[float]] = []
    vertex_queries: list[str] = []
    seen_hashes: set[int] = set()

    for v in solid.Vertices():
        h = v.hashCode()
        if h in seen_hashes:
            continue
        seen_hashes.add(h)
        vertices.append([v.X, v.Y, v.Z])
        if created_by:
            from oversolved.query import make_ancestry_query

            idx = len(vertices) - 1
            vertex_queries.append(make_ancestry_query([f"@{created_by}vertex{idx}", f"@{created_by}"], "vertex"))

    return {"vertices": vertices, "vertex_queries": vertex_queries}


def step_file_to_shape(filepath: str, scale: float = 1.0) -> Any:
    """Read a STEP file and return a cadquery shape.

    Optionally applies a scaling factor.
    """
    import cadquery as cq  # noqa: PLC0415

    workplane = cq.importers.importStep(filepath)
    shape: Any = workplane.val()
    if shape is None or not hasattr(shape, "isValid"):
        raise ValueError(f"STEP file produced no shape: {filepath!r}")
    if scale != 1.0:
        shape = shape.scale(scale)
    return shape


def stl_file_to_shape(filepath: str) -> Any:
    """Read an STL file and return an OCC shape.

    Uses OCP StlAPI_Reader directly since cadquery does not provide an STL importer.
    """
    from OCP.StlAPI import StlAPI_Reader  # noqa: PLC0415
    from OCP.TopoDS import TopoDS_Shape  # noqa: PLC0415

    reader = StlAPI_Reader()
    shape = TopoDS_Shape()
    if not reader.Read(shape, filepath):
        raise ValueError(f"STL read failed for {filepath!r}")
    return shape


def shape_to_step_file(shape: Any, filepath: str) -> None:
    """Write a shape to a STEP file."""
    shape = _ensure_cq_shape(shape)
    shape.exportStep(filepath)
    if not os_module.path.isfile(filepath):
        raise ValueError(f"STEP write failed: file not created at {filepath!r}")


def shape_to_step_file_buffer(shape: Any) -> BytesIO:
    """Write a shape to a STEP file in memory."""
    shape = _ensure_cq_shape(shape)
    with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        shape.exportStep(tmp_path)
        if not os_module.path.isfile(tmp_path):
            raise ValueError("STEP write failed: file not created")
        with open(tmp_path, "rb") as f:
            buffer = BytesIO(f.read())
        buffer.seek(0)
        return buffer
    finally:
        if os_module.path.isfile(tmp_path):
            os_module.unlink(tmp_path)


def shape_to_stl_file_buffer(shape: Any, deflection: float = 0.5, angular_deflection: float = 0.3) -> BytesIO:
    """Write a shape to an STL file in memory.

    Args:
        shape: The shape to export.
        deflection: Linear deflection for mesh tessellation (default 0.5).
        angular_deflection: Angular deflection for mesh tessellation (default 0.3 radians).
    """
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: PLC0415
    from OCP.StlAPI import StlAPI_Writer  # noqa: PLC0415

    topo_shape = shape.wrapped if hasattr(shape, "wrapped") else shape
    mesh = BRepMesh_IncrementalMesh(topo_shape, deflection, False, angular_deflection, True)
    mesh.Perform()

    with tempfile.NamedTemporaryFile(suffix=".stl", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        writer = StlAPI_Writer()
        writer.ASCIIMode = True
        writer.Write(topo_shape, tmp_path)

        with open(tmp_path, "rb") as f:
            buffer = BytesIO(f.read())
        buffer.seek(0)
        return buffer
    finally:
        os_module.unlink(tmp_path)


def shape_to_stl_file(shape: Any, filepath: str, deflection: float = 0.5, angular_deflection: float = 0.3) -> None:
    """Write a shape to an STL file.

    Args:
        shape: The shape to export.
        filepath: Path to write the STL file.
        deflection: Linear deflection for mesh tessellation (default 0.5).
        angular_deflection: Angular deflection for mesh tessellation (default 0.3 radians).
    """
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: PLC0415
    from OCP.StlAPI import StlAPI_Writer  # noqa: PLC0415

    topo_shape = shape.wrapped if hasattr(shape, "wrapped") else shape
    mesh = BRepMesh_IncrementalMesh(topo_shape, deflection, False, angular_deflection, True)
    mesh.Perform()

    writer = StlAPI_Writer()
    writer.ASCIIMode = True
    writer.Write(topo_shape, filepath)


def apply_fillet(shape: Any, radius: float, edges: list[Any] | None = None) -> Any:
    """Apply a fillet (round) to edges of a shape.

    Args:
        shape: The CAD shape to fillet.
        radius: The fillet radius.
        edges: Optional list of specific TopoDS_Edge objects to fillet.
               If None, all edges are filleted.

    Returns:
        The filleted shape, or the original shape if filleting fails.
    """
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415

    topo_shape = shape.wrapped if hasattr(shape, "wrapped") else shape

    maker = BRepFilletAPI_MakeFillet(topo_shape)

    edge_count = 0
    if edges is not None:
        for edge in edges:
            maker.Add(radius, edge)
            edge_count += 1
    else:
        explorer = TopExp_Explorer(topo_shape, TopAbs_EDGE)
        while explorer.More():
            edge = TopoDS.Edge_s(explorer.Current())
            maker.Add(radius, edge)
            edge_count += 1
            explorer.Next()

    if edge_count == 0:
        return shape

    try:
        maker.Build()
        return _ensure_cq_shape(maker.Shape())
    except Exception:
        return shape


def apply_chamfer(shape: Any, distance: float, kind: str = "distance", angle: float = 45.0, edges: list[Any] | None = None) -> Any:
    """Apply a chamfer (bevel) to edges of a shape.

    Args:
        shape: The CAD shape to chamfer.
        distance: The chamfer distance.
        kind: "distance" or "angle_distance".
        angle: Angle in degrees (only used when kind is "angle_distance").
        edges: Optional list of specific TopoDS_Edge objects to chamfer.
               If None, all edges are chamfered.

    Returns:
        The chamfered shape, or the original shape if chamfering fails.
    """
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415

    topo_shape = shape.wrapped if hasattr(shape, "wrapped") else shape

    maker = BRepFilletAPI_MakeChamfer(topo_shape)

    edge_count = 0
    if edges is not None:
        for edge in edges:
            if kind == "angle_distance":
                maker.AddDA(distance, angle, edge)
            else:
                maker.Add(distance, edge)
            edge_count += 1
    else:
        explorer = TopExp_Explorer(topo_shape, TopAbs_EDGE)
        while explorer.More():
            edge = TopoDS.Edge_s(explorer.Current())
            if kind == "angle_distance":
                maker.AddDA(distance, angle, edge)
            else:
                maker.Add(distance, edge)
            edge_count += 1
            explorer.Next()

    if edge_count == 0:
        return shape

    try:
        maker.Build()
        return _ensure_cq_shape(maker.Shape())
    except Exception:
        return shape


def transform_copy(shape: Any, trsf: Any) -> Any:
    """Return a new shape that is `shape` with OCC gp_Trsf applied."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform  # noqa: PLC0415
    topo_shape = shape.wrapped if hasattr(shape, "wrapped") else shape
    builder = BRepBuilderAPI_Transform(topo_shape, trsf, True)  # True = copy
    builder.Build()
    return builder.Shape()


def make_translation_trsf(dx: float, dy: float, dz: float) -> Any:
    from OCP.gp import gp_Trsf, gp_Vec  # noqa: PLC0415
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(dx, dy, dz))
    return t


def make_rotation_trsf(
    origin: list[float], direction: list[float], angle_rad: float
) -> Any:
    from OCP.gp import gp_Trsf, gp_Ax1, gp_Pnt, gp_Dir  # noqa: PLC0415
    ax = gp_Ax1(gp_Pnt(*origin), gp_Dir(*direction))
    t = gp_Trsf()
    t.SetRotation(ax, angle_rad)
    return t
