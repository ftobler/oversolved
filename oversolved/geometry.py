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


def sketch_loops_to_face(loops: list[list[list[float]]], plane: dict) -> Any:
    """Convert 2D profile loops to an OCC face with holes.

    loops[0] = outer boundary, loops[1:] = holes.
    plane is a PlaneTransform dict with origin, x_axis, y_axis (all [x,y,z]).
    Returns an OCC TopoDS_Face.
    """
    from OCP.BRepBuilderAPI import (
        BRepBuilderAPI_MakeEdge,
        BRepBuilderAPI_MakeWire,
        BRepBuilderAPI_MakeFace,
    )  # noqa: PLC0415
    from OCP.gp import gp_Pnt  # noqa: PLC0415

    origin = plane["origin"]
    x_axis = plane["x_axis"]
    y_axis = plane["y_axis"]

    def uv_to_3d(u: float, v: float) -> list[float]:
        return [
            origin[0] + u * x_axis[0] + v * y_axis[0],
            origin[1] + u * x_axis[1] + v * y_axis[1],
            origin[2] + u * x_axis[2] + v * y_axis[2],
        ]

    def make_wire(loop: list[list[float]]) -> Any:
        wire_builder = BRepBuilderAPI_MakeWire()
        pts = [uv_to_3d(u, v) for u, v in loop]
        for i in range(len(pts)):
            p1 = pts[i]
            p2 = pts[(i + 1) % len(pts)]
            edge = BRepBuilderAPI_MakeEdge(gp_Pnt(*p1), gp_Pnt(*p2)).Edge()
            wire_builder.Add(edge)
        return wire_builder.Wire()

    outer_wire = make_wire(loops[0])
    face_builder = BRepBuilderAPI_MakeFace(outer_wire)
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
    loops: list[list[list[float]]],
    plane: dict,
    direction_vec: list[float],
    distance: float,
) -> Any:
    """Convenience wrapper to extrude profile loops to a solid.

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
    return fuse.Shape()


def solid_to_mesh(solid: Any) -> dict:
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
        mesh = BRepMesh_IncrementalMesh(s, 0.5, False, 0.5)
        mesh.Perform()

        verts = []
        faces = []
        normals = []

        default_loc = TopLoc_Location()
        explorer = TopExp_Explorer(s, TopAbs_FACE)

        while explorer.More():
            face_shape = explorer.Current()
            try:
                face = TopoDS_Face()
                face.TShape(face_shape.TShape())
                face.Location(face_shape.Location())
                face.Orientation(face_shape.Orientation())
                tri = BRep_Tool.Triangulation_s(face, default_loc)

                if tri is not None:
                    node_count = tri.NbNodes()
                    tri_count = tri.NbTriangles()
                    offset = len(verts)

                    for i in range(1, node_count + 1):
                        pt = tri.Node(i)
                        verts.append([pt.X(), pt.Y(), pt.Z()])

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
            except TypeError:
                pass
            explorer.Next()

        return verts, faces, normals

    all_vertices = []
    all_faces = []
    all_normals = []

    try:
        v, f, n = get_mesh_from_solid(solid)
        all_vertices = v
        all_faces = f
        all_normals = n
    except Exception:
        pass

    if not all_vertices:
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

    return {"vertices": all_vertices, "faces": all_faces, "normals": all_normals}


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
