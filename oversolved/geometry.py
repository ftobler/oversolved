"""geometry.py — Geometric classification helpers for topology surfaces."""


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

    # Vector from line start to line end
    dx = x2 - x1
    dy = y2 - y1

    # Vector from line start to point
    dpx = px - x1
    dpy = py - y1

    # Cross product: (line_vec) × (point_vec)
    # Positive = left side, Negative = right side
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

    # Use absolute values to determine dominant axis
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
#
# All OCC shape types are typed as Any to avoid import-time OCC dependency.
from typing import Any  # noqa: E402  # lazy import after docstring comment


def plane_dict_to_gp_pln(plane: dict) -> Any:
    """Convert a PlaneTransform dict to an OCP gp_Pln object.

    This ensures OCP's coordinate system is derived directly from the plane's
    axes, eliminating any risk of desynchronisation when constructing geometry.
    """
    from OCP.gp import gp_Pnt, gp_Dir, gp_Ax3, gp_Pln  # noqa: PLC0415

    origin = plane["origin"]
    normal = plane.get("normal", [0.0, 0.0, 1.0])
    x_axis = plane["x_axis"]
    ax3 = gp_Ax3(
        gp_Pnt(*origin),
        gp_Dir(*normal),
        gp_Dir(*x_axis),
    )
    return gp_Pln(ax3)


def sketch_loops_to_face(loops: list[list[dict]], plane: dict) -> Any:
    """Convert 2D profile boundary-edge loops to an OCC face with holes.

    loops[0] = outer boundary, loops[1:] = holes.
    Each loop is a list of edge dicts with keys: kind, start, end,
    and for arcs: center, radius, angle_start_deg, angle_end_deg, ccw.
    plane is a PlaneTransform dict with origin, x_axis, y_axis, normal (all [x,y,z]).
    Returns an OCC TopoDS_Face.
    """
    import math

    from OCP.BRepBuilderAPI import (
        BRepBuilderAPI_MakeEdge,
        BRepBuilderAPI_MakeWire,
        BRepBuilderAPI_MakeFace,
    )  # noqa: PLC0415
    from OCP.gp import gp_Pnt, gp_Ax2, gp_Circ  # noqa: PLC0415

    # Build a gp_Pln from the plane dict so that all OCP geometry is derived
    # from OCP's own coordinate system, preventing axis/normal mismatches.
    ocp_pln = plane_dict_to_gp_pln(plane)
    ax3 = ocp_pln.Position()
    origin_pt = ax3.Location()
    x_dir = ax3.XDirection()
    y_dir = ax3.YDirection()
    normal_dir = ax3.Direction()

    origin = [origin_pt.X(), origin_pt.Y(), origin_pt.Z()]
    x_axis = [x_dir.X(), x_dir.Y(), x_dir.Z()]
    y_axis = [y_dir.X(), y_dir.Y(), y_dir.Z()]

    def uv_to_gp_pnt(uv: list) -> Any:
        x = origin[0] + uv[0] * x_axis[0] + uv[1] * y_axis[0]
        y = origin[1] + uv[0] * x_axis[1] + uv[1] * y_axis[1]
        z = origin[2] + uv[0] * x_axis[2] + uv[1] * y_axis[2]
        return gp_Pnt(x, y, z)

    def uv_to_3d_list(uv: list) -> list:
        return [
            origin[0] + uv[0] * x_axis[0] + uv[1] * y_axis[0],
            origin[1] + uv[0] * x_axis[1] + uv[1] * y_axis[1],
            origin[2] + uv[0] * x_axis[2] + uv[1] * y_axis[2],
        ]

    def make_arc_edge(edge: dict) -> Any:
        center_uv = edge.get("center", [0.0, 0.0])
        radius = float(edge.get("radius", 1.0))
        a0_deg = float(edge.get("angle_start_deg", 0.0))
        a1_deg = float(edge.get("angle_end_deg", 360.0))
        ccw = edge.get("ccw", True)

        center_3d = uv_to_3d_list(center_uv)
        # Build the OCC circle using axes derived from gp_Pln to stay in sync.
        ax2 = gp_Ax2(
            gp_Pnt(*center_3d),
            normal_dir,
            x_dir,
        )
        circ = gp_Circ(ax2, radius)

        # Full circle when span is ~360 degrees.
        span = (
            ((a1_deg - a0_deg) + 360) % 360
            if ccw
            else -(((a0_deg - a1_deg) + 360) % 360)
        )
        if abs(abs(span) - 360.0) < 1e-6:
            return BRepBuilderAPI_MakeEdge(circ).Edge()

        # Partial arc: convert angles to OCC parametric angles on the circle.
        # OCC gp_Circ is parameterised from x_axis CCW in the plane defined by ax2.
        u0 = math.radians(a0_deg)
        u1 = math.radians(a1_deg)
        if ccw:
            if u1 <= u0:
                u1 += 2 * math.pi
        else:
            if u0 <= u1:
                u0 += 2 * math.pi
            u0, u1 = u1, u0  # MakeEdge expects u1 < u2

        return BRepBuilderAPI_MakeEdge(circ, u0, u1).Edge()

    def make_wire(loop: list[dict]) -> Any:
        wire_builder = BRepBuilderAPI_MakeWire()
        for edge in loop:
            kind = edge.get("kind", "line")
            if kind == "arc":
                occ_edge = make_arc_edge(edge)
            else:
                p1 = uv_to_gp_pnt(edge["start"])
                p2 = uv_to_gp_pnt(edge["end"])
                occ_edge = BRepBuilderAPI_MakeEdge(p1, p2).Edge()
            wire_builder.Add(occ_edge)
        return wire_builder.Wire()

    outer_wire = make_wire(loops[0])
    # Pass gp_Pln explicitly so OCP binds the face to the correct coordinate system.
    face_builder = BRepBuilderAPI_MakeFace(ocp_pln, outer_wire)
    for hole_loop in loops[1:]:
        hole_wire = make_wire(hole_loop)
        BRepBuilderAPI_MakeFace.Add(face_builder, hole_wire)
    return face_builder.Face()


def extrude_face(face: Any, direction_vec: list[float], distance: float) -> Any:
    """Extrude an OCC face along a direction vector.

    face: OCC TopoDS_Face
    direction_vec: list[float] - unit 3-vector
    distance: float - extrusion distance (must be non-zero)
    Returns OCC TopoDS_Solid.
    """
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism  # noqa: PLC0415
    from OCP.gp import gp_Vec  # noqa: PLC0415

    if distance == 0:
        raise ValueError("extrude distance must be non-zero")
    dx, dy, dz = direction_vec
    vec = gp_Vec(dx * distance, dy * distance, dz * distance)
    prism = BRepPrimAPI_MakePrism(face, vec)
    return prism.Shape()


def extrude_profile(
    loops: list[list[dict]],
    plane: dict,
    direction_vec: list[float],
    distance: float,
) -> Any:
    """Convenience wrapper to extrude boundary-edge loops to a solid.

    loops is a list of loops, each a list of edge dicts (see sketch_loops_to_face).
    Returns OCC solid (not mesh dict). Tessellation happens later in builder._tessellate_bodies.
    """
    face = sketch_loops_to_face(loops, plane)
    return extrude_face(face, direction_vec, distance)


def revolve_face(
    face: Any,
    axis_origin: list[float],
    axis_direction: list[float],
    angle_deg: float,
) -> Any:
    """Revolve an OCC face around an axis.

    Currently not implemented.
    """
    raise NotImplementedError("revolve_face is not yet implemented")


def boolean_cut(target: Any, tool: Any) -> Any:
    """Boolean cut: target - tool.

    Returns the resulting shape.
    """
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut  # noqa: PLC0415

    cut = BRepAlgoAPI_Cut(target, tool)
    cut.Build()
    if not cut.IsDone():
        raise ValueError("boolean cut failed")
    return cut.Shape()


def boolean_union(target: Any, tool: Any) -> Any:
    """Boolean union: target + tool.

    Returns the resulting shape.
    """
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse  # noqa: PLC0415

    fuse = BRepAlgoAPI_Fuse(target, tool)
    fuse.Build()
    if not fuse.IsDone():
        raise ValueError("boolean union failed")
    result = fuse.Shape()
    return _cleanup_shape(result)


def _cleanup_shape(shape: Any) -> Any:
    """Remove superfluous internal edges that share the same geometric support.

    After boolean operations, faces may have internal edges along the same
    geometric curve. This function fuses adjacent edges with matching
    geometry and removes the redundant vertices.
    """
    from OCP.BRepLib import BRepLib_FuseEdges  # noqa: PLC0415

    fuse = BRepLib_FuseEdges(shape, True)
    fuse.Perform()
    if fuse.NbVertices() > 0:
        return fuse.Shape()
    return shape


def fuse_shapes(shapes: list[Any]) -> Any:
    """Fuse multiple shapes into one compound.

    Returns a single shape representing all inputs fused together.
    """
    if not shapes:
        raise ValueError("no shapes to fuse")
    if len(shapes) == 1:
        return shapes[0]
    result = shapes[0]
    for shape in shapes[1:]:
        result = boolean_union(result, shape)
    return result


def _point_xyz(point) -> list[float]:
    """Return [x, y, z] for an OCC point-like object or 3-sequence."""
    if hasattr(point, "X"):
        return [point.X(), point.Y(), point.Z()]
    return [float(point[0]), float(point[1]), float(point[2])]


def _compute_face_centroid(face_shape) -> list[float]:
    """Compute the analytical centroid of an OCC face."""
    from OCP.BRepGProp import BRepGProp  # noqa: PLC0415
    from OCP.GProp import GProp_GProps  # noqa: PLC0415

    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face_shape, props)
    return _point_xyz(props.CentreOfMass())


def _compute_face_normal(face_shape) -> list[float]:
    """Compute the analytical face normal from the OCC surface."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface  # noqa: PLC0415
    from OCP.BRepTools import BRepTools  # noqa: PLC0415
    from OCP.GeomLProp import GeomLProp_SLProps  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_REVERSED  # noqa: PLC0415

    umin, umax, vmin, vmax = BRepTools.UVBounds_s(face_shape)
    u = (umin + umax) / 2.0
    v = (vmin + vmax) / 2.0

    surface = BRepAdaptor_Surface(face_shape, True).Surface().Surface()
    props = GeomLProp_SLProps(surface, u, v, 1, 1e-7)
    if not props.IsNormalDefined():
        return [0.0, 0.0, 1.0]

    normal = props.Normal()
    if face_shape.Orientation() == TopAbs_REVERSED:
        normal = normal.Reversed()
    return [normal.X(), normal.Y(), normal.Z()]


def _get_face_surface_type(face_shape) -> str:
    """Classify an OCC face as flatface, cylinderface, or face."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface  # noqa: PLC0415
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane  # noqa: PLC0415

    surface_type = BRepAdaptor_Surface(face_shape, True).GetType()
    if surface_type == GeomAbs_Plane:
        return "flatface"
    if surface_type == GeomAbs_Cylinder:
        return "cylinderface"
    return "face"


def solid_to_mesh(solid: Any, created_by: str | None = None) -> dict:
    """Tessellate an OCC solid to a mesh dict.

    Uses BRepMesh_IncrementalMesh to compute tessellation, then extracts
    triangulation data from each face of the solid.
    """
    import math

    from OCP.BRep import BRep_Tool  # noqa: PLC0415
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_FACE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopLoc import TopLoc_Location  # noqa: PLC0415
    from OCP.TopoDS import TopoDS_Face  # noqa: PLC0415

    def get_mesh_from_solid(s):
        nonlocal face_data, triangle_to_face

        mesh = BRepMesh_IncrementalMesh(s, 0.1, False, 0.1)
        mesh.Perform()

        verts = []
        faces = []
        normals = []
        face_data = []
        triangle_to_face = []

        explorer = TopExp_Explorer(s, TopAbs_FACE)

        face_idx = 0

        while explorer.More():
            face_shape = explorer.Current()
            try:
                face = TopoDS_Face()
                face.TShape(face_shape.TShape())
                face.Location(face_shape.Location())
                face.Orientation(face_shape.Orientation())
                location = TopLoc_Location()
                tri = BRep_Tool.Triangulation_s(face, location)
                face_area = 0.0
                if tri is not None:
                    node_count = tri.NbNodes()
                    tri_count = tri.NbTriangles()
                    offset = len(verts)
                    trsf = location.Transformation()

                    for i in range(1, node_count + 1):
                        pt = tri.Node(i)
                        # Apply face location transformation
                        x = (
                            trsf.Value(1, 1) * pt.X()
                            + trsf.Value(1, 2) * pt.Y()
                            + trsf.Value(1, 3) * pt.Z()
                            + trsf.Value(1, 4)
                        )
                        y = (
                            trsf.Value(2, 1) * pt.X()
                            + trsf.Value(2, 2) * pt.Y()
                            + trsf.Value(2, 3) * pt.Z()
                            + trsf.Value(2, 4)
                        )
                        z = (
                            trsf.Value(3, 1) * pt.X()
                            + trsf.Value(3, 2) * pt.Y()
                            + trsf.Value(3, 3) * pt.Z()
                            + trsf.Value(3, 4)
                        )
                        transformed = [x, y, z]
                        verts.append(transformed)

                    for i in range(1, tri_count + 1):
                        tri_data = tri.Triangle(i)
                        faces.append(
                            [
                                offset + tri_data.Value(1) - 1,
                                offset + tri_data.Value(2) - 1,
                                offset + tri_data.Value(3) - 1,
                            ]
                        )
                        p1 = verts[faces[-1][0]]
                        p2 = verts[faces[-1][1]]
                        p3 = verts[faces[-1][2]]
                        v1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]
                        v2 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]]
                        nx = v1[1] * v2[2] - v1[2] * v2[1]
                        ny = v1[2] * v2[0] - v1[0] * v2[2]
                        nz = v1[0] * v2[1] - v1[1] * v2[0]
                        mag = math.sqrt(nx * nx + ny * ny + nz * nz)
                        if mag > 0:
                            normals.append([nx / mag, ny / mag, nz / mag])
                        else:
                            normals.append([0.0, 0.0, 1.0])
                        triangle_to_face.append(face_idx)
                        face_area += 0.5 * mag
                centroid = _compute_face_centroid(face)
                normal = _compute_face_normal(face)
                surface_type = _get_face_surface_type(face)
                face_data.append({"centroid": centroid, "normal": normal, "area": face_area, "surface_type": surface_type})
                if created_by:
                    from oversolved.query import make_ancestry_query

                    element_id = f"face{face_idx}"
                    abs_id = "@" + created_by + element_id
                    query = make_ancestry_query([abs_id, f"@{created_by}"], surface_type)
                    face_queries.append(query)
            except TypeError:
                face_data.append(
                    {"centroid": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0], "area": 0.0, "surface_type": "face"}
                )
                if created_by:
                    from oversolved.query import make_ancestry_query

                    element_id = f"face{face_idx}"
                    abs_id = "@" + created_by + element_id
                    query = make_ancestry_query([abs_id, f"@{created_by}"], "face")
                    face_queries.append(query)
            explorer.Next()
            face_idx += 1

        return verts, faces, normals

    face_data: list[dict] = []
    triangle_to_face: list[int] = []
    face_queries: list[str] = []
    all_vertices = []
    all_faces = []
    all_normals = []

    try:
        v, f, n = get_mesh_from_solid(solid)
        all_vertices = v
        all_faces = f
        all_normals = n
    except Exception:
        face_data = []
        triangle_to_face = []
        face_queries = []
        pass

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

    return {
        "vertices": all_vertices,
        "faces": all_faces,
        "normals": all_normals,
        "face_data": face_data,
        "triangle_to_face": triangle_to_face,
        "face_queries": face_queries,
    }


def solid_to_edges(solid: Any, created_by: str | None = None) -> dict:
    """Extract exact edge geometry from an OCC solid.

    Returns a dict with keys "edges" (list of edge dicts, one per unique edge,
    with kind "line", "circle", "arc", or "spline") and "edge_queries" (list of
    ancestry query strings, populated only when created_by is set).
    """
    import math

    from OCP.BRepAdaptor import BRepAdaptor_Curve  # noqa: PLC0415
    from OCP.GeomAbs import (  # noqa: PLC0415
        GeomAbs_Line,
        GeomAbs_Circle,
    )
    from OCP.TopAbs import TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415

    TWO_PI = 2.0 * math.pi
    CIRCLE_TOL = 1e-4

    edges: list[dict] = []
    edge_queries: list[str] = []
    seen: list[Any] = []  # TopoDS_Edge objects for IsSame deduplication
    idx = 0

    explorer = TopExp_Explorer(solid, TopAbs_EDGE)
    while explorer.More():
        edge_typed = TopoDS.Edge_s(explorer.Current())
        if any(edge_typed.IsSame(s) for s in seen):
            explorer.Next()
            continue
        seen.append(edge_typed)

        c = BRepAdaptor_Curve(edge_typed)
        kind = c.GetType()

        if kind == GeomAbs_Line:
            p1 = c.Value(c.FirstParameter())
            p2 = c.Value(c.LastParameter())
            edges.append(
                {
                    "kind": "line",
                    "start": [p1.X(), p1.Y(), p1.Z()],
                    "end": [p2.X(), p2.Y(), p2.Z()],
                }
            )

        elif kind == GeomAbs_Circle:
            circ = c.Circle()
            center = circ.Location()
            ax = circ.Axis().Direction()
            xdir = circ.XAxis().Direction()
            radius = circ.Radius()
            u0 = c.FirstParameter()
            u1 = c.LastParameter()
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
            # Fallback: tessellate the edge
            n_pts = 16
            u0 = c.FirstParameter()
            u1 = c.LastParameter()
            points = []
            for i in range(n_pts + 1):
                t = u0 + (u1 - u0) * i / n_pts
                pt = c.Value(t)
                points.append([pt.X(), pt.Y(), pt.Z()])
            edges.append({"kind": "spline", "points": points})

        if created_by:
            from oversolved.query import make_ancestry_query  # noqa: PLC0415
            edge_type = "straightedge" if edges[-1]["kind"] == "line" else "edge"
            edge_queries.append(make_ancestry_query([f"@{created_by}edge{idx}", f"@{created_by}"], edge_type))
        idx += 1
        explorer.Next()

    return {"edges": edges, "edge_queries": edge_queries}


def solid_to_vertices(solid: Any, created_by: str | None = None) -> dict:
    """Extract unique B-rep vertices from an OCC solid."""
    from OCP.BRep import BRep_Tool  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_VERTEX  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415

    vertices: list[list[float]] = []
    vertex_queries: list[str] = []
    seen: list[Any] = []

    explorer = TopExp_Explorer(solid, TopAbs_VERTEX)
    while explorer.More():
        v = TopoDS.Vertex_s(explorer.Current())
        if any(v.IsSame(s) for s in seen):
            explorer.Next()
            continue
        seen.append(v)
        pt = BRep_Tool.Pnt_s(v)
        vertices.append([pt.X(), pt.Y(), pt.Z()])
        if created_by:
            from oversolved.query import make_ancestry_query  # noqa: PLC0415
            idx = len(vertices) - 1
            vertex_queries.append(make_ancestry_query([f"@{created_by}vertex{idx}", f"@{created_by}"], "vertex"))
        explorer.Next()

    return {"vertices": vertices, "vertex_queries": vertex_queries}


def step_file_to_shape(filepath: str, scale: float = 1.0) -> Any:
    """Read a STEP file and return an OCC shape.

    Optionally applies a scaling factor.
    """
    from OCP.STEPControl import STEPControl_Reader  # noqa: PLC0415
    from OCP.IFSelect import IFSelect_RetDone  # noqa: PLC0415

    reader = STEPControl_Reader()
    status = reader.ReadFile(filepath)
    if status != IFSelect_RetDone:
        raise ValueError(f"STEP read failed for {filepath!r}")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape.IsNull():
        raise ValueError(f"STEP file produced no shape: {filepath!r}")
    if scale != 1.0:
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform  # noqa: PLC0415
        from OCP.gp import gp_Trsf  # noqa: PLC0415

        t = gp_Trsf()
        t.SetScaleFactor(scale)
        shape = BRepBuilderAPI_Transform(shape, t, True).Shape()
    return shape


def stl_file_to_shape(filepath: str) -> Any:
    """Read an STL file and return an OCC shape.

    Uses StlAPI_Reader to parse the STL file and create a TopoDS_Shape.
    """
    from OCP.StlAPI import StlAPI_Reader  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415

    reader = StlAPI_Reader()
    shape = TopoDS.Shape()
    if not reader.Read(shape, filepath):
        raise ValueError(f"STL read failed for {filepath!r}")
    return shape


def shape_to_step_file(shape: Any, filepath: str) -> None:
    """Write an OCC shape to a STEP file."""
    from OCP.STEPControl import STEPControl_Writer, STEPControl_StepModelType  # noqa: PLC0415
    from OCP.IFSelect import IFSelect_RetDone  # noqa: PLC0415

    writer = STEPControl_Writer()
    status = writer.Transfer(shape, STEPControl_StepModelType.STEPControl_AsIs)
    if status != IFSelect_RetDone:
        raise ValueError(f"STEP write failed: transfer returned {status}")
    write_status = writer.Write(filepath)
    if write_status != IFSelect_RetDone:
        raise ValueError(f"STEP write failed: write returned {write_status}")


def shape_to_stl_file(shape: Any, filepath: str, deflection: float = 0.5, angular_deflection: float = 0.3) -> None:
    """Write an OCC shape to an STL file.

    Args:
        shape: The OCC shape to export.
        filepath: Path to write the STL file.
        deflection: Linear deflection for mesh tessellation (default 0.5).
        angular_deflection: Angular deflection for mesh tessellation (default 0.3 radians).
    """
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: PLC0415
    from OCP.StlAPI import StlAPI_Writer  # noqa: PLC0415

    mesh = BRepMesh_IncrementalMesh(shape, deflection, False, angular_deflection, True)
    mesh.Perform()

    writer = StlAPI_Writer()
    writer.ASCIIMode = True
    writer.Write(shape, filepath)
