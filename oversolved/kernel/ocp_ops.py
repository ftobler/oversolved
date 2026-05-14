"""Thin OCP adapter — sole owner of all ``from OCP.xxx import`` statements.

Every function does one thing: lazy-import the OCP symbol it needs, call it,
and return a plain Python value or OCP object.  No geometry logic lives here.

Other kernel modules import these wrappers at module level; because the
actual ``from OCP.`` import is deferred inside each function body, loading
this module does not trigger OCP at import time and is safe in webapp-only
deployments where OCP is absent.
"""

from __future__ import annotations

from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from OCP.TopoDS import TopoDS_Shape
    from OCP.gp import gp_Trsf, gp_Circ


def ocp_mesh_shape(topo: TopoDS_Shape, lin_deflection: float, ang_deflection: float) -> None:
    """Compute incremental mesh on *topo* in-place (BRepMesh_IncrementalMesh)."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: PLC0415
    BRepMesh_IncrementalMesh(topo, lin_deflection, False, ang_deflection)


def ocp_read_stl(filepath: str) -> TopoDS_Shape:
    """Read an STL file and return a TopoDS_Shape."""
    from OCP.StlAPI import StlAPI_Reader  # noqa: PLC0415
    from OCP.TopoDS import TopoDS_Shape  # noqa: PLC0415
    reader = StlAPI_Reader()
    shape = TopoDS_Shape()
    if not reader.Read(shape, filepath):
        raise ValueError(f"STL read failed for {filepath!r}")
    return shape


def ocp_write_stl(topo: TopoDS_Shape, filepath: str, deflection: float, angular_deflection: float) -> None:
    """Tessellate *topo* and write the result to *filepath* as ASCII STL."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: PLC0415
    from OCP.StlAPI import StlAPI_Writer  # noqa: PLC0415
    mesh = BRepMesh_IncrementalMesh(topo, deflection, False, angular_deflection, True)
    mesh.Perform()
    writer = StlAPI_Writer()
    writer.ASCIIMode = True
    writer.Write(topo, filepath)


def ocp_explore_edges(topo: TopoDS_Shape) -> list[TopoDS_Shape]:
    """Return all TopoDS_Edge objects in *topo* via TopExp_Explorer."""
    from OCP.TopAbs import TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415
    explorer = TopExp_Explorer(topo, TopAbs_EDGE)
    edges = []
    while explorer.More():
        edges.append(TopoDS.Edge_s(explorer.Current()))
        explorer.Next()
    return edges


def ocp_collect_edge_hashes(topo: TopoDS_Shape) -> set[int]:
    """Return topology hashes for all edges in *topo* (via TopoDS_Shape identity)."""
    from OCP.TopAbs import TopAbs_EDGE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    explorer = TopExp_Explorer(topo, TopAbs_EDGE)
    hashes: set[int] = set()
    while explorer.More():
        hashes.add(hash(explorer.Current()))
        explorer.Next()
    return hashes


def ocp_explore_solids(topo: TopoDS_Shape) -> list[TopoDS_Shape]:
    """Return all TopoDS_Solid objects in *topo* via TopExp_Explorer."""
    from OCP.TopAbs import TopAbs_SOLID  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415
    explorer = TopExp_Explorer(topo, TopAbs_SOLID)
    solids = []
    while explorer.More():
        solids.append(TopoDS.Solid_s(explorer.Current()))
        explorer.Next()
    return solids


def ocp_count_solids(topo: TopoDS_Shape) -> int:
    """Count solid sub-shapes in *topo*."""
    from OCP.TopAbs import TopAbs_SOLID, TopAbs_COMPOUND  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    if topo.ShapeType() != TopAbs_COMPOUND:
        return 1
    explorer = TopExp_Explorer(topo, TopAbs_SOLID)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def ocp_fillet_factory(topo: TopoDS_Shape) -> Any:
    """Return a BRepFilletAPI_MakeFillet builder for *topo*."""
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet  # noqa: PLC0415
    return BRepFilletAPI_MakeFillet(topo)


def ocp_chamfer_factory(topo: TopoDS_Shape) -> Any:
    """Return a BRepFilletAPI_MakeChamfer builder for *topo*."""
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer  # noqa: PLC0415
    return BRepFilletAPI_MakeChamfer(topo)


def ocp_transform_copy(topo: TopoDS_Shape, trsf: gp_Trsf) -> TopoDS_Shape:
    """Apply *trsf* to *topo* and return a new TopoDS_Shape (copy=True)."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform  # noqa: PLC0415
    builder = BRepBuilderAPI_Transform(topo, trsf, True)
    builder.Build()
    return builder.Shape()


def ocp_make_translation_trsf(dx: float, dy: float, dz: float) -> gp_Trsf:
    """Return a gp_Trsf for a pure translation."""
    from OCP.gp import gp_Trsf, gp_Vec  # noqa: PLC0415
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(dx, dy, dz))
    return t


def ocp_make_rotation_trsf(origin: list[float], direction: list[float], angle_rad: float) -> gp_Trsf:
    """Return a gp_Trsf for a rotation around an axis."""
    from OCP.gp import gp_Trsf, gp_Ax1, gp_Pnt, gp_Dir  # noqa: PLC0415
    ax = gp_Ax1(gp_Pnt(*origin), gp_Dir(*direction))
    t = gp_Trsf()
    t.SetRotation(ax, angle_rad)
    return t


def ocp_make_mirror_trsf(origin: tuple[float, float, float], normal: tuple[float, float, float]) -> gp_Trsf:
    """Return a gp_Trsf for a mirror across a plane defined by origin and normal."""
    from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir, gp_Trsf  # noqa: PLC0415
    ax = gp_Ax2(gp_Pnt(*origin), gp_Dir(*normal))
    trsf = gp_Trsf()
    trsf.SetMirror(ax)
    return trsf


def ocp_face_uv_bounds(topo_face: TopoDS_Shape) -> tuple[float, float, float, float]:
    """Return (umin, umax, vmin, vmax) UV parameter bounds for a face."""
    from OCP.BRepTools import BRepTools  # noqa: PLC0415
    return BRepTools.UVBounds_s(topo_face)


def ocp_copy_shape(topo: TopoDS_Shape) -> TopoDS_Shape:
    """Return an independent copy of *topo* via BRepBuilderAPI_Copy."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy  # noqa: PLC0415
    copier = BRepBuilderAPI_Copy(topo, True)
    copier.Build()
    if not copier.IsDone():
        raise RuntimeError("BRepBuilderAPI_Copy failed")
    return copier.Shape()


def ocp_make_circle(center: tuple, normal: tuple, x_axis: tuple, radius: float) -> gp_Circ:
    """Return a gp_Circ from center, normal, x_axis and radius."""
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Circ  # noqa: PLC0415
    ax2 = gp_Ax2(gp_Pnt(*center), gp_Dir(*normal), gp_Dir(*x_axis))
    return gp_Circ(ax2, radius)


def ocp_make_edge_from_circle(circle: gp_Circ) -> TopoDS_Shape:
    """Return a full-circle TopoDS_Edge from a gp_Circ."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge  # noqa: PLC0415
    return BRepBuilderAPI_MakeEdge(circle).Edge()


def ocp_make_arc_edge(circle: gp_Circ, angle_start: float, angle_end: float) -> TopoDS_Shape:
    """Return a partial arc TopoDS_Edge from a gp_Circ and angle range."""
    from OCP.GC import GC_MakeArcOfCircle  # noqa: PLC0415
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge  # noqa: PLC0415
    arc = GC_MakeArcOfCircle(circle, angle_start, angle_end, True)
    return BRepBuilderAPI_MakeEdge(arc.Value()).Edge()


def ocp_revolve(topo_face: TopoDS_Shape, axis_origin: list[float], axis_direction: list[float], angle_rad: float) -> TopoDS_Shape:
    """Revolve *topo_face* around an axis and return the resulting TopoDS_Shape."""
    from OCP.gp import gp_Ax1, gp_Pnt, gp_Dir  # noqa: PLC0415
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol  # noqa: PLC0415
    ax = gp_Ax1(gp_Pnt(*axis_origin), gp_Dir(*axis_direction))
    return BRepPrimAPI_MakeRevol(topo_face, ax, angle_rad).Shape()


def ocp_make_cylinder(center: list[float], axis: list[float], radius: float, height: float) -> TopoDS_Shape:
    """Return a solid cylinder TopoDS_Shape."""
    from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir  # noqa: PLC0415
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder  # noqa: PLC0415
    ax2 = gp_Ax2(gp_Pnt(*center), gp_Dir(*axis))
    return BRepPrimAPI_MakeCylinder(ax2, radius, height).Shape()


def ocp_make_scale_trsf(center: tuple[float, float, float], scale: float) -> gp_Trsf:
    """Return a gp_Trsf for a uniform scale around *center*."""
    from OCP.gp import gp_Trsf, gp_Pnt  # noqa: PLC0415
    t = gp_Trsf()
    t.SetScale(gp_Pnt(*center), scale)
    return t


def ocp_identity_trsf() -> gp_Trsf:
    """Return an identity gp_Trsf."""
    from OCP.gp import gp_Trsf  # noqa: PLC0415
    return gp_Trsf()


def ocp_curve_info(topo_edge: TopoDS_Shape) -> dict:
    """Classify a TopoDS_Edge and return its geometry as a plain dict.

    Keys always present: "type" ("line", "circle", or "other").
    Line: also has no extra keys (caller uses CQ edge API for start/end points).
    Circle: also has "center" [x,y,z], "radius", "angle_start", "angle_end".
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve  # noqa: PLC0415
    from OCP.GeomAbs import GeomAbs_Line, GeomAbs_Circle  # noqa: PLC0415
    adapt = BRepAdaptor_Curve(topo_edge)
    atype = adapt.GetType()
    if atype == GeomAbs_Line:
        return {"type": "line"}
    if atype == GeomAbs_Circle:
        circ = adapt.Circle()
        c = circ.Location()
        return {
            "type": "circle",
            "center": [c.X(), c.Y(), c.Z()],
            "radius": circ.Radius(),
            "angle_start": adapt.FirstParameter(),
            "angle_end": adapt.LastParameter(),
        }
    return {"type": "other"}


def _extract_occ_face(topo_shape: TopoDS_Shape, cq_faces_sorted: list | None, face_index: int) -> Any:
    """Return the TopoDS_Face at *face_index* from *topo_shape*.

    Tries the CQ-wrapper path first; falls back to a raw OCC TopExp_Explorer walk.
    Raises ValueError when the index is out of range.
    """
    from OCP.TopAbs import TopAbs_FACE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS_Face  # noqa: PLC0415

    def _face_from_explorer(topo: TopoDS_Shape, idx: int) -> TopoDS_Face:
        exp = TopExp_Explorer(topo, TopAbs_FACE)
        for _ in range(idx):
            if not exp.More():
                raise ValueError(f"face_index {idx} out of range")
            exp.Next()
        if not exp.More():
            raise ValueError(f"face_index {idx} out of range")
        face_shape = exp.Current()
        occ = TopoDS_Face()
        occ.TShape(face_shape.TShape())
        occ.Location(face_shape.Location())
        occ.Orientation(face_shape.Orientation())
        return occ

    occ_face = None
    if cq_faces_sorted is not None:
        try:
            if face_index >= len(cq_faces_sorted):
                raise ValueError(f"face_index {face_index} out of range")
            target_face = cq_faces_sorted[face_index]
            occ = TopoDS_Face()
            occ.TShape(target_face.wrapped.TShape())
            occ.Location(target_face.wrapped.Location())
            occ.Orientation(target_face.wrapped.Orientation())
            occ_face = occ
        except Exception:
            occ_face = None

    if occ_face is None:
        occ_face = _face_from_explorer(topo_shape, face_index)

    return occ_face


def _compute_face_plane(occ_face: Any) -> Any:
    """Return a Frame3D describing the plane of *occ_face*.

    Raises ValueError if the face is not planar.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Surface  # noqa: PLC0415
    from OCP.GeomAbs import GeomAbs_Plane  # noqa: PLC0415
    from oversolved.kernel.types3d import Frame3D

    adaptor = BRepAdaptor_Surface(occ_face, True)
    if adaptor.GetType() != GeomAbs_Plane:
        raise ValueError("Only flat faces can be used as extrude profiles")

    gp_pln = adaptor.Plane()
    ax3 = gp_pln.Position()
    loc = ax3.Location()
    xdir = ax3.XDirection()
    ydir = ax3.YDirection()
    ndir = ax3.Direction()

    return Frame3D(
        origin=[loc.X(), loc.Y(), loc.Z()],
        x_axis=[xdir.X(), xdir.Y(), xdir.Z()],
        y_axis=[ydir.X(), ydir.Y(), ydir.Z()],
        normal=[ndir.X(), ndir.Y(), ndir.Z()],
    )


def _collect_face_wires(occ_face: Any) -> tuple[Any, list[Any]]:
    """Return (outer_wire, hole_wires) for *occ_face*.

    The outer wire is obtained via BRepTools.OuterWire_s; all other wires on
    the face are collected as holes, deduplicated by hash.
    """
    from OCP.BRepTools import BRepTools  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_WIRE  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415

    outer_wire = BRepTools.OuterWire_s(occ_face)
    hole_wires: list[Any] = []
    seen: set[int] = {hash(outer_wire)}
    wire_exp = TopExp_Explorer(occ_face, TopAbs_WIRE)
    while wire_exp.More():
        w = TopoDS.Wire_s(wire_exp.Current())
        h = hash(w)
        if h not in seen:
            seen.add(h)
            hole_wires.append(w)
        wire_exp.Next()

    return outer_wire, hole_wires


def _build_loop_from_wire(wire: Any, occ_face: Any) -> list[dict]:
    """Build a list of edge dicts (kind "line" or "arc") for *wire* on *occ_face*.

    Per-edge exceptions are silently ignored so that one bad edge does not
    discard the whole loop.  Returns an empty list when no valid edges are found.
    """
    import math
    from OCP.BRepAdaptor import BRepAdaptor_Curve2d  # noqa: PLC0415
    from OCP.BRepTools import BRepTools_WireExplorer  # noqa: PLC0415
    from OCP.GeomAbs import GeomAbs_Circle  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_REVERSED  # noqa: PLC0415

    TWO_PI = 2.0 * math.pi
    loop: list[dict] = []
    we = BRepTools_WireExplorer(wire, occ_face)
    while we.More():
        edge = we.Current()
        try:
            c2d = BRepAdaptor_Curve2d(edge, occ_face)
            first = c2d.FirstParameter()
            last = c2d.LastParameter()
            # BRepAdaptor_Curve2d returns PCurve natural direction; for a
            # reversed edge the traversal goes last-to-first, so swap.
            if edge.Orientation() == TopAbs_REVERSED:
                first, last = last, first
            curve_type = c2d.GetType()
            if curve_type == GeomAbs_Circle:
                circ = c2d.Circle()
                center = circ.Location()
                radius = circ.Radius()
                span = last - first
                is_full = abs(abs(span) - TWO_PI) < 1e-6
                if is_full:
                    loop.append({
                        "kind": "arc",
                        "center": [center.X(), center.Y()],
                        "radius": radius,
                        "angle_start_deg": 0.0,
                        "angle_end_deg": 360.0,
                        "ccw": span >= 0,
                    })
                else:
                    p_start = c2d.Value(first)
                    p_end = c2d.Value(last)
                    cx, cy = center.X(), center.Y()
                    a0 = math.atan2(p_start.Y() - cy, p_start.X() - cx)
                    a1 = math.atan2(p_end.Y() - cy, p_end.X() - cx)
                    span_ccw = (a1 - a0 + 2 * math.pi) % TWO_PI
                    arc_ccw = span_ccw < math.pi
                    loop.append({
                        "kind": "arc",
                        "center": [cx, cy],
                        "radius": radius,
                        "angle_start_deg": math.degrees(a0),
                        "angle_end_deg": math.degrees(a1),
                        "ccw": arc_ccw,
                    })
            else:
                p_s = c2d.Value(first)
                p_e = c2d.Value(last)
                loop.append({
                    "kind": "line",
                    "start": [p_s.X(), p_s.Y()],
                    "end": [p_e.X(), p_e.Y()],
                })
        except Exception:
            pass
        we.Next()

    return loop


def ocp_extract_face_loops(
    topo_shape: TopoDS_Shape,
    cq_faces_sorted: list | None,
    face_index: int,
) -> tuple[list[list[dict]], Any]:
    """Extract 2D loops and plane from a face of *topo_shape*.

    *cq_faces_sorted* is a pre-sorted list of CadQuery Face objects (or None
    for raw TopoDS inputs).  The face at *face_index* is used.

    Returns (loops, effective_plane) where loops is a list of loop dicts and
    effective_plane is a Frame3D.
    """
    occ_face = _extract_occ_face(topo_shape, cq_faces_sorted, face_index)
    effective_plane = _compute_face_plane(occ_face)
    outer_wire, hole_wires = _collect_face_wires(occ_face)
    all_wires = [outer_wire] + hole_wires
    loops = [_build_loop_from_wire(w, occ_face) for w in all_wires]
    loops = [loop for loop in loops if loop]
    return loops, effective_plane
