"""CAD operations adapter using cadquery.occ_impl.

Wraps cadquery.occ_impl shapes and geom primitives so the rest of the
application can work with higher-level CAD operations instead of raw OCP.
"""

from typing import Any

from cadquery.occ_impl import shapes as cq_shapes
from cadquery.occ_impl.geom import Plane as CQPlane, Vector as CQVector


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


def make_wire(edges: list) -> cq_shapes.Wire:
    """Assemble edges into a wire."""
    return cq_shapes.Wire.assembleEdges(edges)


def make_face_from_wires(outer_wire: cq_shapes.Wire, inner_wires: list | None = None) -> cq_shapes.Face:
    """Create a face from an outer wire and optional hole wires."""
    if inner_wires:
        return cq_shapes.Face.makeFromWires(outer_wire, inner_wires)
    return cq_shapes.Face.makeFromWires(outer_wire)


def extrude_face(face: Any, direction_vec: list[float], distance: float) -> cq_shapes.Solid:
    """Extrude a face along a direction vector."""
    if distance == 0:
        raise ValueError("extrude distance must be non-zero")
    vec = CQVector(*direction_vec) * distance
    return cq_shapes.Solid.extrudeLinear(face, vec)


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


def _compute_face_centroid(face: cq_shapes.Face) -> list[float]:
    """Compute face centroid using cadquery."""
    c = face.Center()
    return [c.x, c.y, c.z]


def _compute_face_normal(face: cq_shapes.Face) -> list[float]:
    """Compute face normal at the midpoint of its UV domain."""
    bounds = face.uvBounds()
    u = (bounds[0] + bounds[1]) / 2.0
    v = (bounds[2] + bounds[3]) / 2.0
    n = face.normalAt((u, v))
    return [n.x, n.y, n.z]


def _get_face_surface_type(face: cq_shapes.Face) -> str:
    """Classify a face as flatface, cylinderface, or face."""
    gt = face.geomType()
    if gt == "PLANE":
        return "flatface"
    if gt == "CYLINDER":
        return "cylinderface"
    return "face"
