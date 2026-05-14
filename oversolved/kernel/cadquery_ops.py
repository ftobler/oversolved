"""CAD operations adapter using cadquery.occ_impl.

Wraps cadquery.occ_impl shapes and geom primitives so the rest of the
application can work with higher-level CAD operations instead of raw OCP.

OCP imports stay inside function bodies (lazy) so that module-level import
of this file does not require OCP to be installed.  This is critical for
the webapp-only deployment where ``oversolved[solver]`` (cadquery/OCP) is
not installed — the import boundary test
(``tests/test_import_boundary.py``) enforces this.

The solver daemon's worker subprocess imports ``oversolved.kernel.builder``
at runtime, which triggers this module's cadquery imports at module level
(under try/except).  OCP is then loaded lazily inside each function when
the worker calls build().
"""

from __future__ import annotations

from typing import Any

try:
    from cadquery.occ_impl import shapes as cq_shapes
    from cadquery.occ_impl.geom import Plane as CQPlane, Vector as CQVector
except ImportError:
    cq_shapes = None  # type: ignore[assignment,misc]
    CQPlane = None  # type: ignore[assignment,misc]
    CQVector = None  # type: ignore[assignment,misc]


import math as _math


def _triangle_area(p0: list, p1: list, p2: list) -> float:
    """Return the area of a triangle defined by three 3D points."""
    v1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
    v2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
    nx = v1[1] * v2[2] - v1[2] * v2[1]
    ny = v1[2] * v2[0] - v1[0] * v2[2]
    nz = v1[0] * v2[1] - v1[1] * v2[0]
    return 0.5 * _math.sqrt(nx * nx + ny * ny + nz * nz)


def _normal_to_frame(normal: list) -> tuple[list, list]:
    """Compute orthonormal (x_axis, y_axis) for a plane given its unit normal.

    Chooses an arbitrary axis to cross with, avoiding near-parallel vectors.
    """
    nx, ny, nz = normal
    if abs(nz) < 0.9:
        ax, ay, az = 0.0, 0.0, 1.0
    else:
        ax, ay, az = 1.0, 0.0, 0.0
    cx = ny * az - nz * ay
    cy = nz * ax - nx * az
    cz = nx * ay - ny * ax
    mag = _math.sqrt(cx * cx + cy * cy + cz * cz)
    if mag > 1e-12:
        cx, cy, cz = cx / mag, cy / mag, cz / mag
    else:
        cx, cy, cz = 1.0, 0.0, 0.0
    yx = ny * cz - nz * cy
    yy = nz * cx - nx * cz
    yz = nx * cy - ny * cx
    return [cx, cy, cz], [yx, yy, yz]


def _face_sort_key_from_tuple(item: tuple) -> tuple:
    """Sort key for a precomputed face tuple (face, verts, idxs, centroid, normal, surface_type)."""
    _f, _v, _i, c, n, s = item
    type_order = 0 if s == "flatface" else 1
    return (type_order, round(n[0], 6), round(n[1], 6), round(n[2], 6),
            round(c[0], 6), round(c[1], 6), round(c[2], 6))


def to_cq_plane(plane: dict) -> CQPlane:
    """Convert our plane dict to a CQ Plane."""
    return CQPlane(
        origin=tuple(plane.get("origin", [0.0, 0.0, 0.0])),
        xDir=tuple(plane.get("x_axis", [1.0, 0.0, 0.0])),
        normal=tuple(plane.get("normal", [0.0, 0.0, 1.0])),
    )


def from_cq_plane(cq_plane: CQPlane) -> dict:
    """Convert CQ Plane to our plane dict."""
    return {
        "origin": list(cq_plane.origin.toTuple()),
        "x_axis": list(cq_plane.xDir.toTuple()),
        "y_axis": list(cq_plane.yDir.toTuple()),
        "normal": list(cq_plane.zDir.toTuple()),
    }


def make_line_edge(start: list, end: list) -> cq_shapes.Edge:
    """Create a line edge from two 3D points."""
    return cq_shapes.Edge.makeLine(CQVector(*start), CQVector(*end))


def make_arc_edge(
    center: list,
    radius: float,
    normal: list,
    x_axis: list,
    angle_start: float,
    angle_end: float,
) -> cq_shapes.Edge:
    """Create a circular or arc edge.

    Angles are in radians.  If the span is ~2*pi a full circle is returned.
    The x_axis parameter is honoured so the arc orientation matches the sketch plane.
    """
    import math

    n = CQVector(*normal).normalized()
    x = CQVector(*x_axis).normalized()
    c = CQVector(*center)

    span = abs(angle_end - angle_start)
    is_full = abs(span - 2 * math.pi) < 1e-6 or span < 1e-6

    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Circ  # noqa: PLC0415
    ax2 = gp_Ax2(gp_Pnt(*c.toTuple()), gp_Dir(*n.toTuple()), gp_Dir(*x.toTuple()))
    circle = gp_Circ(ax2, radius)

    if is_full:
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge  # noqa: PLC0415
        builder = BRepBuilderAPI_MakeEdge(circle)
        return cq_shapes.Edge(builder.Edge())

    from OCP.GC import GC_MakeArcOfCircle  # noqa: PLC0415
    arc = GC_MakeArcOfCircle(circle, angle_start, angle_end, True)
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge  # noqa: PLC0415
    builder = BRepBuilderAPI_MakeEdge(arc.Value())
    return cq_shapes.Edge(builder.Edge())


def make_wire(edges: list[cq_shapes.Edge]) -> cq_shapes.Wire:
    """Assemble edges into a wire."""
    return cq_shapes.Wire.assembleEdges(edges)


def make_face_from_wires(outer_wire: cq_shapes.Wire, inner_wires: list[cq_shapes.Wire] | None = None) -> cq_shapes.Face:
    """Create a face from an outer wire and optional hole wires."""
    if inner_wires:
        return cq_shapes.Face.makeFromWires(outer_wire, inner_wires)
    return cq_shapes.Face.makeFromWires(outer_wire)


def extrude_face(face: cq_shapes.Face, direction_vec: list[float], distance: float) -> cq_shapes.Solid:
    """Extrude a face along a direction vector."""
    if distance == 0:
        raise ValueError("extrude distance must be non-zero")
    vec = CQVector(*direction_vec) * distance
    return cq_shapes.Solid.extrudeLinear(face, vec).clean()


def revolve_face(face: Any, axis_origin: list[float], axis_direction: list[float], angle_deg: float) -> cq_shapes.Solid:
    """Revolve a face around an axis."""
    if angle_deg == 0:
        raise ValueError("revolve angle must be non-zero")
    import math
    from OCP.gp import gp_Ax1, gp_Pnt, gp_Dir  # noqa: PLC0415
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol  # noqa: PLC0415
    ax = gp_Ax1(gp_Pnt(*axis_origin), gp_Dir(*axis_direction))
    topo_face = face.wrapped if hasattr(face, "wrapped") else face
    revol = BRepPrimAPI_MakeRevol(topo_face, ax, math.radians(angle_deg))
    return cq_shapes.Solid(revol.Shape())


def make_cylinder(center: list[float], axis: list[float], radius: float, height: float) -> cq_shapes.Solid:
    """Solid cylinder for hole cutting. center and axis are 3D world-space."""
    from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir  # noqa: PLC0415
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder  # noqa: PLC0415
    ax2 = gp_Ax2(gp_Pnt(*center), gp_Dir(*axis))
    return cq_shapes.Solid(BRepPrimAPI_MakeCylinder(ax2, radius, height).Shape())


def _ensure_cq(target: Any) -> cq_shapes.Shape:
    """Wrap raw TopoDS shape in cadquery Shape if necessary."""
    if hasattr(target, "cut"):
        return target
    return cq_shapes.Shape.cast(target)


def boolean_cut(target: Any, tool: Any) -> cq_shapes.Solid:
    """Boolean cut: target - tool."""
    target = _ensure_cq(target)
    tool = _ensure_cq(tool)
    result = target.cut(tool).clean()
    if not result.isValid():
        raise ValueError("boolean cut produced invalid shape")
    return result


def boolean_union(target: Any, tool: Any) -> cq_shapes.Solid:
    """Boolean union: target + tool."""
    target = _ensure_cq(target)
    tool = _ensure_cq(tool)
    result = target.fuse(tool).clean()
    if not result.isValid():
        raise ValueError("boolean union produced invalid shape")
    return result


def boolean_intersection(target: Any, tool: Any) -> cq_shapes.Solid:
    """Boolean intersection: target ∩ tool."""
    target = _ensure_cq(target)
    tool = _ensure_cq(tool)
    result = target.intersect(tool).clean()
    if not result.isValid():
        raise ValueError("boolean intersection produced invalid shape")
    return result


def fuse_shapes(shapes: list[Any]) -> Any:
    """Fuse multiple shapes into one."""
    if not shapes:
        raise ValueError("no shapes to fuse")
    if len(shapes) == 1:
        return shapes[0]
    result = shapes[0]
    for shape in shapes[1:]:
        result = boolean_union(result, shape)
    return result


def make_mirror_trsf(origin: tuple[float, float, float], normal: tuple[float, float, float]):
    """Create a reflection transform across a plane."""
    from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir, gp_Trsf  # noqa: PLC0415
    ax = gp_Ax2(gp_Pnt(*origin), gp_Dir(*normal))
    trsf = gp_Trsf()
    trsf.SetMirror(ax)
    return trsf


def _compute_face_centroid(face: cq_shapes.Face) -> list[float]:
    """Compute face centroid using cadquery."""
    c = face.Center()
    return [c.x, c.y, c.z]


def _compute_face_normal(face: cq_shapes.Face) -> list[float]:
    """Compute face normal at the midpoint of its UV domain."""
    bounds = face._uvBounds()
    u = (bounds[0] + bounds[1]) / 2.0
    v = (bounds[2] + bounds[3]) / 2.0
    n = face.normalAt(CQVector(u, v))
    return [n.x, n.y, n.z]


def _get_face_surface_type(face: cq_shapes.Face) -> str:
    """Classify a face as flatface, cylinderface, or face."""
    gt = face.geomType()
    if gt == "PLANE":
        return "flatface"
    if gt == "CYLINDER":
        return "cylinderface"
    return "face"


def _face_sort_key(face: cq_shapes.Face) -> tuple:
    """Sort key for a raw cadquery Face object.

    Flat faces sort before curved; within each group, sorted by normal then centroid.
    """
    n = _compute_face_normal(face)
    c = _compute_face_centroid(face)
    type_order = 0 if _get_face_surface_type(face) == "flatface" else 1
    return (type_order, round(n[0], 6), round(n[1], 6), round(n[2], 6),
            round(c[0], 6), round(c[1], 6), round(c[2], 6))


def apply_transform_shape(
    shape,
    translation=None,
    rotation_axis_origin=None,
    rotation_axis_direction=None,
    rotation_angle_deg=0.0,
    scale=1.0,
    scale_center=None,
):
    """Compose scale -> rotation -> translation into a single gp_Trsf and apply.

    Each component is skipped when it would be identity (scale==1, angle==0,
    translation==None) to avoid unnecessary B-rep invalidation.
    Returns a new cq Shape (or TopoDS_Shape matching input type).
    """
    import math
    from OCP.gp import gp_Trsf, gp_Vec, gp_Pnt, gp_Dir, gp_Ax1  # noqa: PLC0415
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform  # noqa: PLC0415

    combined = gp_Trsf()  # identity

    if scale != 1.0:
        sc = gp_Trsf()
        center = gp_Pnt(*(scale_center or (0, 0, 0)))
        sc.SetScale(center, scale)
        combined.Multiply(sc)

    if rotation_angle_deg and rotation_axis_direction:
        rot = gp_Trsf()
        origin = gp_Pnt(*(rotation_axis_origin or (0, 0, 0)))
        direction = gp_Dir(*rotation_axis_direction)
        ax1 = gp_Ax1(origin, direction)
        rot.SetRotation(ax1, math.radians(rotation_angle_deg))
        combined.Multiply(rot)

    if translation:
        tr = gp_Trsf()
        tr.SetTranslation(gp_Vec(*translation))
        combined.Multiply(tr)

    raw = shape.wrapped if hasattr(shape, "wrapped") else shape
    builder = BRepBuilderAPI_Transform(raw, combined, True)  # copy=True
    result_shape = builder.Shape()
    if hasattr(shape, "wrapped"):
        return cq_shapes.Shape.cast(result_shape)
    return result_shape
