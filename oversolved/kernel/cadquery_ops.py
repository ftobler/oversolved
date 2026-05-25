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

from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
    from OCP.gp import gp_Trsf

try:
    from cadquery.occ_impl import shapes as cq_shapes
    from cadquery.occ_impl.geom import Plane as CQPlane, Vector as CQVector
except ImportError:
    cq_shapes = None  # type: ignore[assignment,misc]
    CQPlane = None  # type: ignore[assignment,misc]
    CQVector = None  # type: ignore[assignment,misc]

from oversolved.kernel.ocp_ops import (
    ocp_face_uv_bounds,
    ocp_make_arc_edge,
    ocp_make_circle,
    ocp_make_cylinder,
    ocp_make_edge_from_circle,
    ocp_make_face_from_wire,
    ocp_make_mirror_trsf,
    ocp_make_prism,
    ocp_revolve,
    ocp_identity_trsf,
    ocp_make_scale_trsf,
    ocp_make_rotation_trsf,
    ocp_make_translation_trsf,
    ocp_transform_copy,
)
from oversolved.kernel.types3d import Frame3D

import math as _math


def _ensure_occ(shape: Any) -> TopoDS_Shape:
    """Unwrap a CadQuery Shape to its underlying TopoDS_Shape, or pass through raw OCC shapes."""
    return shape.wrapped if hasattr(shape, "wrapped") else shape


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


def to_cq_plane(plane: Frame3D | dict) -> CQPlane:
    """Convert a Frame3D or plane dict to a CQ Plane."""
    if isinstance(plane, Frame3D):
        return plane.to_cq_plane()
    return CQPlane(
        origin=tuple(plane.get("origin", [0.0, 0.0, 0.0])),
        xDir=tuple(plane.get("x_axis", [1.0, 0.0, 0.0])),
        normal=tuple(plane.get("normal", [0.0, 0.0, 1.0])),
    )


def from_cq_plane(cq_plane: CQPlane) -> Frame3D:
    """Convert CQ Plane to a Frame3D."""
    return Frame3D.from_cq_plane(cq_plane)


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
    n = CQVector(*normal).normalized()
    x = CQVector(*x_axis).normalized()
    c = CQVector(*center)

    span = abs(angle_end - angle_start)
    if span < 1e-6:
        raise ValueError(f"make_arc_edge: degenerate zero-span arc (span={span})")
    is_full = abs(span - 2 * _math.pi) < 1e-6

    circle = ocp_make_circle(c.toTuple(), n.toTuple(), x.toTuple(), radius)

    if is_full:
        return cq_shapes.Edge(ocp_make_edge_from_circle(circle))

    return cq_shapes.Edge(ocp_make_arc_edge(circle, angle_start, angle_end))


def make_wire(edges: list[cq_shapes.Edge]) -> cq_shapes.Wire:
    """Assemble edges into a wire."""
    return cq_shapes.Wire.assembleEdges(edges)


def make_face_from_wires(outer_wire: cq_shapes.Wire, inner_wires: list[cq_shapes.Wire] | None = None) -> cq_shapes.Face:
    """Create a face from an outer wire and optional hole wires.

    Uses ocp_make_face_from_wire instead of Face.makeFromWires to avoid the hidden
    ShapeFix_Shape pass that CadQuery applies to the outer wire before building the face.
    """
    hole_occs = [w.wrapped for w in (inner_wires or [])]
    return cq_shapes.Face(ocp_make_face_from_wire(outer_wire.wrapped, hole_occs))


def extrude_face(face: cq_shapes.Face, direction_vec: list[float], distance: float) -> cq_shapes.Solid:
    """Extrude a face along a direction vector.

    Uses ocp_make_prism directly so no ShapeUpgrade is applied to the tool solid.
    The single ShapeUpgrade call happens later in _boolean_with_diff after the boolean.
    """
    if distance == 0:
        raise ValueError("extrude distance must be non-zero")
    scaled = [v * distance for v in direction_vec]
    return cq_shapes.Solid(ocp_make_prism(_ensure_occ(face), scaled))


def revolve_face(face: cq_shapes.Face, axis_origin: list[float],
                 axis_direction: list[float], angle_deg: float) -> cq_shapes.Solid:
    """Revolve a face around an axis."""
    if angle_deg == 0:
        raise ValueError("revolve angle must be non-zero")
    return cq_shapes.Solid(ocp_revolve(_ensure_occ(face), axis_origin, axis_direction, _math.radians(angle_deg)))


def make_cylinder(center: list[float], axis: list[float], radius: float, height: float) -> cq_shapes.Solid:
    """Solid cylinder for hole cutting. center and axis are 3D world-space."""
    return cq_shapes.Solid(ocp_make_cylinder(center, axis, radius, height))


def _ensure_cq(target: Any) -> cq_shapes.Shape:
    """Convert any shape (TopoDS_Shape or cadquery Shape) to a cadquery Shape."""
    return cq_shapes.Shape.cast(_ensure_occ(target))


def _boolean_with_diff(target: Any, tool: Any, op: str) -> tuple[cq_shapes.Shape, Any]:
    """Run boolean (cut|fuse|common), then ShapeUpgrade.clean.

    Returns (cleaned cq.Shape, BrepDiff in cleaned-shape handle space).
    Uses OCP-direct path so we can capture history before clean and compose it
    through the clean step. See solver_arch.user.md §B-rep Operation Tracking.
    """
    from oversolved.kernel.ocp_ops import (
        ocp_boolean_with_history,
        ocp_clean_with_history,
        ocp_compose_diff_through_clean,
    )
    target_occ = _ensure_occ(target)
    tool_occ = _ensure_occ(tool)
    raw_result, raw_diff = ocp_boolean_with_history(target_occ, tool_occ, op)
    cleaned, clean_hist = ocp_clean_with_history(raw_result)
    composed_diff = ocp_compose_diff_through_clean(raw_diff, clean_hist, raw_result, cleaned)
    shape = cq_shapes.Shape.cast(cleaned)
    if not shape.isValid():
        raise ValueError(f"boolean {op!r} produced invalid shape")
    return shape, composed_diff


def boolean_cut(target: Any, tool: Any) -> cq_shapes.Shape:
    """Boolean cut: target - tool. Returns the cleaned shape only.

    For history-aware callers (ancestry registration), use boolean_cut_with_diff.
    """
    shape, _ = _boolean_with_diff(target, tool, "cut")
    return shape


def boolean_cut_with_diff(target: Any, tool: Any) -> tuple[cq_shapes.Shape, Any]:
    """Boolean cut: returns (shape, BrepDiff). See _boolean_with_diff."""
    return _boolean_with_diff(target, tool, "cut")


def boolean_union(target: Any, tool: Any) -> cq_shapes.Shape:
    """Boolean union: target + tool."""
    shape, _ = _boolean_with_diff(target, tool, "fuse")
    return shape


def boolean_union_with_diff(target: Any, tool: Any) -> tuple[cq_shapes.Shape, Any]:
    """Boolean union: returns (shape, BrepDiff)."""
    return _boolean_with_diff(target, tool, "fuse")


def boolean_intersection(target: Any, tool: Any) -> cq_shapes.Shape:
    """Boolean intersection: target ∩ tool."""
    shape, _ = _boolean_with_diff(target, tool, "common")
    return shape


def boolean_intersection_with_diff(target: Any, tool: Any) -> tuple[cq_shapes.Shape, Any]:
    """Boolean intersection: returns (shape, BrepDiff)."""
    return _boolean_with_diff(target, tool, "common")


def fuse_shapes(shapes: list[Any]) -> cq_shapes.Shape:
    """Fuse multiple shapes into one solid. Raises ValueError if shapes are disjoint."""
    if not shapes:
        raise ValueError("no shapes to fuse")
    if len(shapes) == 1:
        return _ensure_cq(shapes[0])
    result: cq_shapes.Shape = _ensure_cq(shapes[0])
    for shape in shapes[1:]:
        result = boolean_union(result, shape)
    if len(result.Solids()) != 1:
        raise ValueError(
            "fuse_shapes: shapes are disjoint, cannot fuse into a single solid"
        )
    return result


def make_mirror_trsf(origin: tuple[float, float, float], normal: tuple[float, float, float]) -> gp_Trsf:
    """Create a reflection transform across a plane."""
    return ocp_make_mirror_trsf(origin, normal)


def _compute_face_centroid(face: cq_shapes.Shape) -> list[float]:
    """Compute face centroid using cadquery."""
    c = face.Center()
    return [c.x, c.y, c.z]


def _compute_face_normal(face: cq_shapes.Shape) -> list[float]:
    """Compute face normal at the midpoint of its UV domain."""
    umin, umax, vmin, vmax = ocp_face_uv_bounds(_ensure_occ(face))
    u = (umin + umax) / 2.0
    v = (vmin + vmax) / 2.0
    n = face.normalAt(CQVector(u, v))  # type: ignore[attr-defined]
    return [n.x, n.y, n.z]


def _get_face_surface_type(face: cq_shapes.Shape) -> str:
    """Classify a face as flatface, cylinderface, or face."""
    gt = face.geomType()
    if gt == "PLANE":
        return "flatface"
    if gt == "CYLINDER":
        return "cylinderface"
    return "face"


def _face_sort_key(face: cq_shapes.Shape) -> tuple:
    """Sort key for a raw cadquery Face object.

    Flat faces sort before curved; within each group, sorted by normal then centroid.
    """
    n = _compute_face_normal(face)
    c = _compute_face_centroid(face)
    type_order = 0 if _get_face_surface_type(face) == "flatface" else 1
    return (type_order, round(n[0], 6), round(n[1], 6), round(n[2], 6),
            round(c[0], 6), round(c[1], 6), round(c[2], 6))


def apply_transform_shape(
    shape: TopoDS_Shape,
    translation: list[float] | None = None,
    rotation_axis_origin: list[float] | None = None,
    rotation_axis_direction: list[float] | None = None,
    rotation_angle_deg: float = 0.0,
    scale: float = 1.0,
    scale_center: tuple[float, float, float] | None = None,
) -> TopoDS_Shape:
    """Compose scale -> rotation -> translation into a single gp_Trsf and apply.

    Each component is skipped when it would be identity (scale==1, angle==0,
    translation==None) to avoid unnecessary B-rep invalidation.
    When rotation_angle_deg is set and rotation_axis_direction is None, defaults
    to Z-axis [0, 0, 1].
    Returns a new cq Shape (or TopoDS_Shape matching input type).
    """
    combined = ocp_identity_trsf()

    if scale != 1.0:
        sc = ocp_make_scale_trsf(scale_center or (0, 0, 0), scale)
        combined.Multiply(sc)

    if rotation_angle_deg:
        axis_direction = rotation_axis_direction or [0, 0, 1]
        rot = ocp_make_rotation_trsf(
            list(rotation_axis_origin or (0, 0, 0)),
            list(axis_direction),
            _math.radians(rotation_angle_deg),
        )
        combined.Multiply(rot)

    if translation:
        tr = ocp_make_translation_trsf(*translation)
        combined.Multiply(tr)

    return ocp_transform_copy(_ensure_occ(shape), combined)
