"""Thin OCP adapter — sole owner of all ``from OCP.xxx import`` statements.

Every function does one thing: lazy-import the OCP symbol it needs, call it,
and return a plain Python value or OCP object.  No geometry logic lives here.

Other kernel modules import these wrappers at module level; because the
actual ``from OCP.`` import is deferred inside each function body, loading
this module does not trigger OCP at import time and is safe in webapp-only
deployments where OCP is absent.
"""

from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

logger = logging.getLogger(__name__)

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


def ocp_edge_modifier_diff(
    maker: Any,
    old_shape: TopoDS_Shape,
    new_shape: TopoDS_Shape,
) -> Any:
    """Derive a BrepDiff from a built BRepFilletAPI_Make{Fillet,Chamfer} maker.

    Mirrors ocp_boolean_with_history's target-side classification, but uses the
    fillet/chamfer history API (IsDeleted / Modified / Generated) instead of the
    BRepAlgoAPI history. The fillet/chamfer surfaces generated from the modified
    edges land in new_faces (no input-face preimage), so the @created_by rewrite
    in builder.py attributes them to the modifying feature.

    Returns BrepDiff in new_shape handle space. There is no ShapeUpgrade.clean
    after fillet/chamfer, so no compose-through-clean step is needed here.
    """
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE  # noqa: PLC0415
    from oversolved.kernel.types3d import BrepDiff  # noqa: PLC0415

    diff = BrepDiff()

    def _classify_inputs(kind):
        modified_inputs: list[Any] = []
        deleted_inputs: list[Any] = []
        preimages_in_output: list[Any] = []
        exp = TopExp_Explorer(old_shape, kind)
        while exp.More():
            s = exp.Current()
            deleted = False
            try:
                deleted = bool(maker.IsDeleted(s))
            except Exception:
                deleted = False
            if deleted:
                deleted_inputs.append(s)
            else:
                mods = maker.Modified(s)
                if mods.Size() > 0:
                    modified_inputs.append(s)
                    for m in mods:
                        preimages_in_output.append(m)
                else:
                    # Untouched sub-shape: same handle appears in the output.
                    preimages_in_output.append(s)
            exp.Next()
        return modified_inputs, deleted_inputs, preimages_in_output

    mod_f, del_f, inherited_out_faces = _classify_inputs(TopAbs_FACE)
    mod_e, del_e, inherited_out_edges = _classify_inputs(TopAbs_EDGE)

    diff.modified_input_faces = mod_f
    diff.deleted_input_faces = del_f
    diff.modified_input_edges = mod_e
    diff.deleted_input_edges = del_e

    def _walk_outputs(kind, inherited_pool):
        new_list: list[Any] = []
        inherited_list: list[Any] = []
        exp = TopExp_Explorer(new_shape, kind)
        while exp.More():
            s = exp.Current()
            if any(s.IsSame(p) for p in inherited_pool):
                inherited_list.append(s)
            else:
                new_list.append(s)
            exp.Next()
        return new_list, inherited_list

    new_faces, inh_faces = _walk_outputs(TopAbs_FACE, inherited_out_faces)
    new_edges, inh_edges = _walk_outputs(TopAbs_EDGE, inherited_out_edges)
    diff.new_faces = new_faces
    diff.inherited_faces = inh_faces
    diff.new_edges = new_edges
    diff.inherited_edges = inh_edges

    return diff


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


def ocp_revolve(topo_face: TopoDS_Shape, axis_origin: list[float],
                axis_direction: list[float], angle_rad: float) -> TopoDS_Shape:
    """Revolve *topo_face* around an axis and return the resulting TopoDS_Shape.

    Copy=True prevents MakeRevol from modifying the input face in-place.
    """
    from OCP.gp import gp_Ax1, gp_Pnt, gp_Dir  # noqa: PLC0415
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol  # noqa: PLC0415
    ax = gp_Ax1(gp_Pnt(*axis_origin), gp_Dir(*axis_direction))
    return BRepPrimAPI_MakeRevol(topo_face, ax, angle_rad, True).Shape()


def ocp_make_revol_lineage(
    topo_face: TopoDS_Shape, axis_origin: list[float],
    axis_direction: list[float], angle_rad: float,
) -> tuple[TopoDS_Shape, Any]:
    """Like ocp_revolve but also returns the builder for
    Generated()/FirstShape()/LastShape() lineage queries.
    """
    from OCP.gp import gp_Ax1, gp_Pnt, gp_Dir  # noqa: PLC0415
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol  # noqa: PLC0415
    ax = gp_Ax1(gp_Pnt(*axis_origin), gp_Dir(*axis_direction))
    builder = BRepPrimAPI_MakeRevol(topo_face, ax, angle_rad, True)
    builder.Build()
    if not builder.IsDone():
        raise ValueError("BRepPrimAPI_MakeRevol failed")
    return builder.Shape(), builder


def ocp_make_face_from_wire(outer_wire: TopoDS_Shape, hole_wires: list) -> TopoDS_Shape:
    """Build a planar face directly from OCC wires without running ShapeFix on inputs.

    Applies only ShapeFix_Face.FixOrientation() after building — no ShapeFix_Shape
    on the outer wire, which CadQuery's Face.makeFromWires does and which can silently
    alter wire topology before the face is even constructed.
    """
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace  # noqa: PLC0415
    from OCP.ShapeFix import ShapeFix_Face  # noqa: PLC0415
    from OCP.TopoDS import TopoDS  # noqa: PLC0415
    builder = BRepBuilderAPI_MakeFace(TopoDS.Wire_s(outer_wire), True)
    for hw in hole_wires:
        builder.Add(TopoDS.Wire_s(hw))
    builder.Build()
    if not builder.IsDone():
        raise ValueError(f"BRepBuilderAPI_MakeFace failed: {builder.Error()}")
    face = builder.Face()
    fixer = ShapeFix_Face(face)
    fixer.FixOrientation()
    fixer.Perform()
    return fixer.Face()


def ocp_make_prism(face: TopoDS_Shape, scaled_vec: list[float]) -> TopoDS_Shape:
    """Linear extrusion: sweep *face* along *scaled_vec* (direction * distance).

    Copy=True prevents MakePrism from modifying the input face in-place.
    Returns raw TopoDS_Shape with no ShapeUpgrade applied — callers do that
    after the boolean, not here.
    """
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism  # noqa: PLC0415
    from OCP.gp import gp_Vec  # noqa: PLC0415
    vec = gp_Vec(*scaled_vec)
    builder = BRepPrimAPI_MakePrism(face, vec, True)  # Copy=True
    builder.Build()
    if not builder.IsDone():
        raise ValueError("BRepPrimAPI_MakePrism failed")
    return builder.Shape()


def ocp_make_prism_lineage(
    face: TopoDS_Shape, scaled_vec: list[float]
) -> tuple[TopoDS_Shape, Any]:
    """Like ocp_make_prism but also returns the builder for
    Generated()/FirstShape()/LastShape() lineage queries.
    """
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism  # noqa: PLC0415
    from OCP.gp import gp_Vec  # noqa: PLC0415
    vec = gp_Vec(*scaled_vec)
    builder = BRepPrimAPI_MakePrism(face, vec, True)
    builder.Build()
    if not builder.IsDone():
        raise ValueError("BRepPrimAPI_MakePrism failed")
    return builder.Shape(), builder


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

    Per-edge exceptions are logged at DEBUG; one aggregate WARNING is emitted
    if any edges are dropped.  Returns an empty list when no valid edges are found.
    """
    import math
    from OCP.BRepAdaptor import BRepAdaptor_Curve2d  # noqa: PLC0415
    from OCP.BRepTools import BRepTools_WireExplorer  # noqa: PLC0415
    from OCP.GeomAbs import GeomAbs_Circle  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_REVERSED  # noqa: PLC0415

    TWO_PI = 2.0 * math.pi
    loop: list[dict] = []
    dropped = 0
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
        except Exception as exc:
            logger.debug("ocp_extract_face_loops: dropping edge: %s", exc)
            dropped += 1
        we.Next()

    if dropped > 0:
        logger.warning("ocp_extract_face_loops: dropped %d edges from wire", dropped)
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


def ocp_face_area(topo_face: Any) -> float:
    """Surface area of a TopoDS_Face."""
    from OCP.BRepGProp import BRepGProp  # noqa: PLC0415
    from OCP.GProp import GProp_GProps  # noqa: PLC0415
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(topo_face, props)
    return float(props.Mass())


def ocp_boolean_with_history(
    target_shape: Any,
    tool_shape: Any,
    op: str,
) -> tuple[Any, Any]:
    """Run a BRepAlgoAPI_* boolean and return (result_shape, BrepDiff).

    op is one of 'cut', 'fuse', 'common'. The result shape is the raw output
    of the boolean (no ShapeUpgrade.clean). Callers that want clean topology
    must call ocp_clean_with_history() separately and compose the diffs.

    User invariant (solver_arch.user.md §B-rep Operation Tracking):
      "Old geometry from extrude1 still belongs to extrude1. New faces created
       by a cut in extrude2 track to extrude2 only."
    The BrepDiff returned here classifies each output sub-shape so the ancestry
    registration can tag new sub-shapes with the cutting feature instead of the
    body's original creator.
    """
    from OCP.BRepAlgoAPI import (  # noqa: PLC0415
        BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse, BRepAlgoAPI_Common,
    )
    from OCP.TopTools import TopTools_ListOfShape  # noqa: PLC0415
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE  # noqa: PLC0415

    from oversolved.kernel.types3d import BrepDiff  # noqa: PLC0415

    api_cls = {"cut": BRepAlgoAPI_Cut, "fuse": BRepAlgoAPI_Fuse, "common": BRepAlgoAPI_Common}.get(op)
    if api_cls is None:
        raise ValueError(f"unknown boolean op: {op!r}")

    algo = api_cls()
    args = TopTools_ListOfShape()
    args.Append(target_shape)
    tools = TopTools_ListOfShape()
    tools.Append(tool_shape)
    algo.SetArguments(args)
    algo.SetTools(tools)
    algo.SetToFillHistory(True)
    algo.Build()
    if not algo.IsDone():
        raise ValueError(f"boolean {op!r} did not complete")

    result = algo.Shape()
    history = algo.History() if algo.HasHistory() else None

    diff = BrepDiff()

    if history is not None:
        # Classify TARGET sub-shapes only as "inherited" preimages -- target geometry
        # that survives (unchanged or just reshaped) inherits @created_by from the
        # target body.
        # TOOL sub-shapes that appear in the output are NEW from the result's POV --
        # they are walls/faces introduced into the target body by this operation
        # (e.g. cut-hole inner walls came from the tool's side faces).
        def _classify_target(shape_in, kind):
            exp = TopExp_Explorer(shape_in, kind)
            modified_inputs: list[Any] = []
            deleted_inputs: list[Any] = []
            preimages_in_output: list[Any] = []  # outputs reachable from target inputs
            while exp.More():
                s = exp.Current()
                if history.IsRemoved(s):
                    deleted_inputs.append(s)
                else:
                    mods = history.Modified(s)
                    if mods.Size() > 0:
                        modified_inputs.append(s)
                        for m in mods:
                            preimages_in_output.append(m)
                    else:
                        # Unchanged: same TopoDS_Shape appears in output.
                        preimages_in_output.append(s)
                exp.Next()
            return modified_inputs, deleted_inputs, preimages_in_output

        mod_in_t, del_in_t, inherited_out_faces = _classify_target(target_shape, TopAbs_FACE)
        e_mod_in_t, e_del_in_t, inherited_out_edges = _classify_target(target_shape, TopAbs_EDGE)

        # Tool tracking: just record what was modified/deleted in tool inputs (informational).
        def _record_tool(shape_in, kind):
            exp = TopExp_Explorer(shape_in, kind)
            mod_in: list[Any] = []
            del_in: list[Any] = []
            while exp.More():
                s = exp.Current()
                if history.IsRemoved(s):
                    del_in.append(s)
                elif history.Modified(s).Size() > 0:
                    mod_in.append(s)
                exp.Next()
            return mod_in, del_in

        mod_in_u, del_in_u = _record_tool(tool_shape, TopAbs_FACE)
        e_mod_in_u, e_del_in_u = _record_tool(tool_shape, TopAbs_EDGE)

        diff.modified_input_faces = mod_in_t + mod_in_u
        diff.deleted_input_faces = del_in_t + del_in_u
        diff.modified_input_edges = e_mod_in_t + e_mod_in_u
        diff.deleted_input_edges = e_del_in_t + e_del_in_u

        # Walk the output and classify each sub-shape:
        #   IsSame any inherited_pool -> "inherited" (target lineage)
        #   else                      -> "new"       (from tool or genuinely new)
        def _walk_outputs(shape_out, kind, inherited_pool):
            new_list: list[Any] = []
            inherited_list: list[Any] = []
            exp = TopExp_Explorer(shape_out, kind)
            while exp.More():
                s = exp.Current()
                if any(s.IsSame(p) for p in inherited_pool):
                    inherited_list.append(s)
                else:
                    new_list.append(s)
                exp.Next()
            return new_list, inherited_list

        new_faces, inh_faces = _walk_outputs(result, TopAbs_FACE, inherited_out_faces)
        new_edges, inh_edges = _walk_outputs(result, TopAbs_EDGE, inherited_out_edges)
        diff.new_faces = new_faces
        diff.inherited_faces = inh_faces
        diff.new_edges = new_edges
        diff.inherited_edges = inh_edges

    return result, diff


def ocp_clean_with_history(shape: Any) -> tuple[Any, Any]:
    """Run ShapeUpgrade_UnifySameDomain and return (cleaned_shape, history).

    Equivalent to cadquery's Shape.clean() but exposes the upgrade history so
    callers can chain it with a prior boolean history when tracking ancestry
    through the cut → clean pipeline.
    """
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain  # noqa: PLC0415
    upgrader = ShapeUpgrade_UnifySameDomain(shape, True, True, True)
    upgrader.AllowInternalEdges(False)
    upgrader.Build()
    return upgrader.Shape(), upgrader.History()


def ocp_compose_diff_through_clean(
    diff: Any,
    clean_history: Any,
    raw_shape: Any,
    cleaned_shape: Any,
) -> Any:
    """Map a BrepDiff's sub-shape lists from raw_shape to cleaned_shape.

    After ShapeUpgrade, the TopoDS handles in `diff` reference faces/edges of
    `raw_shape`. This walks `clean_history` to translate each entry to its
    counterpart in `cleaned_shape`, dropping entries removed by the upgrade.
    Returns a NEW BrepDiff.

    Edge cases:
    - Shapes that ShapeUpgrade fully removes (IsRemoved) are dropped from the
      composed diff. A new face that the unifier merges away simply disappears
      from new_faces.
    - When the upgrade history reports no modifier for a shape (Modified Size()
      == 0), the shape is assumed pass-through and kept as-is (matched via IsSame
      against the cleaned pool, falling back to the raw handle). This is the
      conservative branch; an upgrade that internally replaced a shape without
      recording it would surface here as a stale handle.
    - `raw_shape` is currently unused; it is retained as a provenance hook for a
      future cross-check that mapped handles actually originate from raw_shape.
    """
    from OCP.TopExp import TopExp_Explorer  # noqa: PLC0415
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE  # noqa: PLC0415
    from oversolved.kernel.types3d import BrepDiff  # noqa: PLC0415

    # Collect cleaned-shape sub-shape handles to choose canonical instances.
    cleaned_faces: list[Any] = []
    exp = TopExp_Explorer(cleaned_shape, TopAbs_FACE)
    while exp.More():
        cleaned_faces.append(exp.Current())
        exp.Next()
    cleaned_edges: list[Any] = []
    exp = TopExp_Explorer(cleaned_shape, TopAbs_EDGE)
    while exp.More():
        cleaned_edges.append(exp.Current())
        exp.Next()

    def _map_one(s, pool):
        # Map s (in raw_shape) through clean_history; return list of replacements
        # actually present in cleaned_shape (matched via IsSame against `pool`).
        if clean_history.IsRemoved(s):
            return []
        mods = clean_history.Modified(s)
        if mods.Size() == 0:
            # Unchanged through clean step: same shape may appear in pool.
            return [p for p in pool if p.IsSame(s)] or [s]
        out: list[Any] = []
        for m in mods:
            matched = [p for p in pool if p.IsSame(m)]
            out.extend(matched or [m])
        return out

    def _map_list(items, pool):
        result: list[Any] = []
        seen_ids: set[int] = set()
        for s in items:
            for m in _map_one(s, pool):
                # Dedupe by Python id; IsSame may match the same wrapper repeatedly.
                if id(m) not in seen_ids:
                    seen_ids.add(id(m))
                    result.append(m)
        return result

    new_diff = BrepDiff(
        new_faces=_map_list(diff.new_faces, cleaned_faces),
        inherited_faces=_map_list(diff.inherited_faces, cleaned_faces),
        new_edges=_map_list(diff.new_edges, cleaned_edges),
        inherited_edges=_map_list(diff.inherited_edges, cleaned_edges),
        modified_input_faces=list(diff.modified_input_faces),
        deleted_input_faces=list(diff.deleted_input_faces),
        modified_input_edges=list(diff.modified_input_edges),
        deleted_input_edges=list(diff.deleted_input_edges),
    )
    # Silence the "raw_shape unused" lint -- accepted for future provenance hooks.
    _ = raw_shape
    return new_diff


def ocp_brep_diff_new_edge_data(diff) -> list[dict]:
    """Extract geometry data from brep_diff.new_edges as plain dicts.

    Each dict has:
      - type: "line" | "circle" | "arc"
      Line: start, end (each [x, y, z])
      Circle/arc: center ([x,y,z]), radius (float), angle_start, angle_end

    Returns [] if OCP imports fail or diff is empty.
    """
    if diff is None or not diff.new_edges:
        return []
    try:
        from OCP.BRepAdaptor import BRepAdaptor_Curve  # noqa: PLC0415
        from OCP.GeomAbs import GeomAbs_Line, GeomAbs_Circle  # noqa: PLC0415
        from OCP.gp import gp_Pnt  # noqa: PLC0415
        from OCP.TopoDS import TopoDS  # noqa: PLC0415
    except ImportError:
        return []
    _TWO_PI = 6.283185307179586
    results: list[dict] = []
    for topo_shape in diff.new_edges:
        try:
            topo_edge = TopoDS.Edge_s(topo_shape)
            adapt = BRepAdaptor_Curve(topo_edge)
            atype = adapt.GetType()
            u0, u1 = adapt.FirstParameter(), adapt.LastParameter()
            if atype == GeomAbs_Line:
                p0, p1 = gp_Pnt(), gp_Pnt()
                adapt.D0(u0, p0)
                adapt.D0(u1, p1)
                results.append({
                    "type": "line",
                    "start": [p0.X(), p0.Y(), p0.Z()],
                    "end": [p1.X(), p1.Y(), p1.Z()],
                })
            elif atype == GeomAbs_Circle:
                circ = adapt.Circle()
                c = circ.Location()
                is_full = abs(abs(u1 - u0) - _TWO_PI) < 1e-4 or abs(u1 - u0) < 1e-4
                results.append({
                    "type": "circle" if is_full else "arc",
                    "center": [c.X(), c.Y(), c.Z()],
                    "radius": circ.Radius(),
                    "angle_start": u0,
                    "angle_end": u1,
                })
        except Exception:
            continue
    return results


def ocp_brep_diff_vertex_endpoints(diff) -> tuple[set[tuple[float, float, float]], set[tuple[float, float, float]]]:
    """Extract vertex endpoints from brep_diff new/inherited edges.

    Returns (new_vertex_points, inherited_vertex_points) where each is
    a set of (x, y, z) tuples.  Used to identify purely-new vertices
    (endpoints of new_edges that do NOT appear in inherited_edges).
    Returns ({}, {}) if OCP imports fail.
    """
    if diff is None or (not diff.new_edges and not diff.inherited_edges):
        return set(), set()
    try:
        from OCP.BRepAdaptor import BRepAdaptor_Curve  # noqa: PLC0415
        from OCP.gp import gp_Pnt  # noqa: PLC0415
        from OCP.TopoDS import TopoDS  # noqa: PLC0415
    except ImportError:
        return set(), set()

    def _extract(edge_list) -> set[tuple[float, float, float]]:
        points: set[tuple[float, float, float]] = set()
        for topo_shape in edge_list:
            try:
                topo_edge = TopoDS.Edge_s(topo_shape)
                adapt = BRepAdaptor_Curve(topo_edge)
                p0, p1 = gp_Pnt(), gp_Pnt()
                adapt.D0(adapt.FirstParameter(), p0)
                adapt.D0(adapt.LastParameter(), p1)
                points.add((p0.X(), p0.Y(), p0.Z()))
                points.add((p1.X(), p1.Y(), p1.Z()))
            except Exception:
                continue
        return points

    new_verts = _extract(diff.new_edges or [])
    inherited_verts = _extract(diff.inherited_edges or [])
    return new_verts, inherited_verts
