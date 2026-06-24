/**
 * The thin OCC.js adapter. Per the migration plan this is the ONLY module that touches OCC.js
 * types directly; everything above it (shapes.ts, tessellation.ts) calls these.
 *
 * Every function takes a [[DisposeScope]] and tracks its transient OCC objects (points, dirs,
 * builders, adaptors) in it. Functions that produce a shape the caller keeps return it WITHOUT
 * tracking it, so the caller decides its lifetime (typically `HandleTable.register`); the scope
 * still owns the builder that made it. This mirrors the spike's proven ownership pattern.
 *
 * Overload suffixes and arities were verified against opencascade.js@1.1.1 (OCC 7.5); see the
 * migration notes. Out-parameter APIs (BRepTools.UVBounds, BRepGProp_Face.Normal) do not
 * marshal in emscripten, so UV bounds come from BRepAdaptor_Surface's First/Last parameter
 * accessors and the normal from BRepLProp_SLProps, both direct-return.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccOrientedShape, OccSubShape } from './occTypes'
import type { EdgeData } from '@/types/cad'

export type Vec3 = [number, number, number]

/** Heterogeneous edge sort key (type_order, kind, then rounded coords). */
export type EdgeSortKey = (number | string)[]

// --- primitive solids -----------------------------------------------------

export function makeBox(oc: OccModule, scope: DisposeScope, dx: number, dy: number, dz: number): OccShape {
  const builder = scope.track(new oc.BRepPrimAPI_MakeBox_1(dx, dy, dz))
  return builder.Shape()
}

/** Axis-aligned box anchored at a corner point (BRepPrimAPI_MakeBox(corner, dx, dy, dz)). */
export function makeBoxAt(
  oc: OccModule,
  scope: DisposeScope,
  corner: Vec3,
  dx: number,
  dy: number,
  dz: number,
): OccShape {
  const pnt = scope.track(new oc.gp_Pnt_3(corner[0], corner[1], corner[2]))
  const builder = scope.track(new oc.BRepPrimAPI_MakeBox_2(pnt, dx, dy, dz))
  return builder.Shape()
}

export function makeCylinder(
  oc: OccModule,
  scope: DisposeScope,
  center: Vec3,
  axis: Vec3,
  radius: number,
  height: number,
): OccShape {
  // gp_Ax2(location, mainDirection) -- the 2-arg form, matching
  // ocp_make_cylinder; the X reference direction is chosen by OCC.
  const ax2 = scope.track(
    new oc.gp_Ax2_3(
      scope.track(new oc.gp_Pnt_3(center[0], center[1], center[2])),
      scope.track(new oc.gp_Dir_4(axis[0], axis[1], axis[2])),
    ),
  )
  const builder = scope.track(new oc.BRepPrimAPI_MakeCylinder_3(ax2, radius, height))
  return builder.Shape()
}

// --- profile -> face -> prism ---------------------------------------------

/** A straight edge between two world points (cadquery Edge.makeLine). */
export function makeLineEdge(oc: OccModule, scope: DisposeScope, start: Vec3, end: Vec3): OccShape {
  const a = scope.track(new oc.gp_Pnt_3(start[0], start[1], start[2]))
  const b = scope.track(new oc.gp_Pnt_3(end[0], end[1], end[2]))
  const builder = scope.track(new oc.BRepBuilderAPI_MakeEdge_3(a, b))
  return builder.Edge()
}

/** A full-circle edge (ocp_make_circle + ocp_make_edge_from_circle). */
export function makeCircleEdge(
  oc: OccModule,
  scope: DisposeScope,
  center: Vec3,
  normal: Vec3,
  xAxis: Vec3,
  radius: number,
): OccShape {
  const circ = makeCirc(oc, scope, center, normal, xAxis, radius)
  const builder = scope.track(new oc.BRepBuilderAPI_MakeEdge_8(circ))
  return builder.Edge()
}

/**
 * A circular or arc edge, mirroring cadquery `make_arc_edge`: a ~2pi span is a
 * full circle, otherwise a trimmed arc via GC_MakeArcOfCircle. Angles in radians.
 */
export function makeArcEdge(
  oc: OccModule,
  scope: DisposeScope,
  center: Vec3,
  normal: Vec3,
  xAxis: Vec3,
  radius: number,
  angleStart: number,
  angleEnd: number,
): OccShape {
  const span = Math.abs(angleEnd - angleStart)
  if (span < 1e-6) throw new Error(`make_arc_edge: degenerate zero-span arc (span=${span})`)
  if (Math.abs(span - 2 * Math.PI) < 1e-6) {
    return makeCircleEdge(oc, scope, center, normal, xAxis, radius)
  }
  const circ = makeCirc(oc, scope, center, normal, xAxis, radius)
  const arc = scope.track(new oc.GC_MakeArcOfCircle_1(circ, angleStart, angleEnd, true))
  const trimmed = scope.track(arc.Value())
  const curve = trimmed.get()
  if (!curve) throw new Error('make_arc_edge: GC_MakeArcOfCircle produced no curve')
  // Upcast Handle_Geom_TrimmedCurve -> Handle_Geom_Curve for MakeEdge.
  const geomCurve = scope.track(new oc.Handle_Geom_Curve_2(curve))
  const builder = scope.track(new oc.BRepBuilderAPI_MakeEdge_24(geomCurve))
  return builder.Edge()
}

/** A cubic Bezier edge from 4 control points (sketch spline -> OCC edge). */
export function makeBezierEdge(oc: OccModule, scope: DisposeScope, poles: Vec3[]): OccShape {
  const arr = scope.track(new oc.TColgp_Array1OfPnt_2(1, poles.length))
  poles.forEach((p, i) => arr.SetValue(i + 1, scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2]))))
  const bez = scope.track(new oc.Geom_BezierCurve_1(arr))
  // Upcast the raw Geom_BezierCurve to a Handle_Geom_Curve for MakeEdge.
  const geomCurve = scope.track(new oc.Handle_Geom_Curve_2(bez))
  const builder = scope.track(new oc.BRepBuilderAPI_MakeEdge_24(geomCurve))
  return builder.Edge()
}

/**
 * An ellipse edge. `majorAxis`/`normal` orient the ellipse frame; `a >= b` are
 * the semi-major/semi-minor radii. When `u0`/`u1` (eccentric angles, radians)
 * are given and do not span a full turn, a trimmed elliptical arc is built (the
 * sliced-ellipse case); otherwise the full closed ellipse.
 */
export function makeEllipseEdge(
  oc: OccModule,
  scope: DisposeScope,
  center: Vec3,
  normal: Vec3,
  majorAxis: Vec3,
  a: number,
  b: number,
  u0?: number,
  u1?: number,
): OccShape {
  const ax2 = scope.track(
    new oc.gp_Ax2_2(
      scope.track(new oc.gp_Pnt_3(center[0], center[1], center[2])),
      scope.track(new oc.gp_Dir_4(normal[0], normal[1], normal[2])),
      scope.track(new oc.gp_Dir_4(majorAxis[0], majorAxis[1], majorAxis[2])),
    ),
  )
  const elips = scope.track(new oc.gp_Elips_2(ax2, a, b))
  const isPartial =
    u0 !== undefined && u1 !== undefined && Math.abs(Math.abs(u1 - u0) - 2 * Math.PI) > 1e-9
  if (isPartial) {
    const arc = scope.track(new oc.GC_MakeArcOfEllipse_1(elips, u0 as number, u1 as number, true))
    const trimmed = scope.track(arc.Value())
    const curve = trimmed.get()
    if (!curve) throw new Error('make_ellipse_edge: GC_MakeArcOfEllipse produced no curve')
    const geomCurve = scope.track(new oc.Handle_Geom_Curve_2(curve))
    return scope.track(new oc.BRepBuilderAPI_MakeEdge_24(geomCurve)).Edge()
  }
  const ell = scope.track(new oc.Geom_Ellipse_1(elips))
  const geomCurve = scope.track(new oc.Handle_Geom_Curve_2(ell))
  const builder = scope.track(new oc.BRepBuilderAPI_MakeEdge_24(geomCurve))
  return builder.Edge()
}

function makeCirc(
  oc: OccModule,
  scope: DisposeScope,
  center: Vec3,
  normal: Vec3,
  xAxis: Vec3,
  radius: number,
): OccShape {
  const ax2 = scope.track(
    new oc.gp_Ax2_2(
      scope.track(new oc.gp_Pnt_3(center[0], center[1], center[2])),
      scope.track(new oc.gp_Dir_4(normal[0], normal[1], normal[2])),
      scope.track(new oc.gp_Dir_4(xAxis[0], xAxis[1], xAxis[2])),
    ),
  )
  return scope.track(new oc.gp_Circ_2(ax2, radius))
}

/** Number of edges in a wire/shape. */
function edgeCount(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const exp = scope.track(
    new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
  )
  let n = 0
  while (exp.More()) {
    n++
    exp.Next()
  }
  return n
}

/** Assemble ordered edges into a wire (BRepBuilderAPI_MakeWire), with
 *  ShapeFix_Wire gap-healing when the raw wire build fails on sub-micron joints.
 *
 *  Guards connectivity: BRepBuilderAPI_MakeWire silently drops an edge whose
 *  joint gap exceeds its confusion tolerance, and the heal fallback cannot
 *  re-attach it (ShapeFix only re-loads one wire), so the wire would collapse
 *  to a subset and the sweep/extrude would produce a wrong-shape or single-face
 *  solid while still reporting ok. We instead fail loudly: a missing edge means
 *  the joints need snapping upstream (see collectPathEdges). */
export function makeWire(oc: OccModule, scope: DisposeScope, edges: OccShape[]): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeWire_1())
  for (const e of edges) builder.Add_1(e)
  let wire: OccShape | null = null
  try {
    wire = builder.Wire()
  } catch {
    wire = healWireFromEdges(oc, scope, edges)
  }
  const got = edgeCount(oc, scope, wire)
  if (got < edges.length) {
    throw new Error(
      `makeWire: only ${got} of ${edges.length} edges connected; a joint gap exceeds the kernel tolerance (snap the joints upstream)`,
    )
  }
  return wire
}

/** Gap-closing tolerance for ShapeFix_Wire healing.  Spine joints are snapped to
 *  the arc's exact endpoints upstream (collectPathEdges), so a built wire's
 *  residual gaps are at solver precision (~1e-6) and this heal only tidies them.
 *  Large enough to absorb that, small enough not to merge distinct vertices on
 *  short edges.  Spine joints are typically several units apart. */
const WIRE_HEAL_TOL = 0.01

/**
 * Best-effort heal of a set of edges into one wire via ShapeFix_Wire. NOTE: the
 * current bindings only expose Load_1 (one wire), so this cannot re-attach edges
 * that BRepBuilderAPI_MakeWire already rejected; makeWire's connectivity guard
 * catches the resulting drop. Effective only when the edges already (nearly)
 * connect.
 */
export function healWireFromEdges(oc: OccModule, scope: DisposeScope, edges: OccShape[]): OccShape {
  const sfw = scope.track(new oc.ShapeFix_Wire_1())
  for (const e of edges) {
    const singleBuilder = scope.track(new oc.BRepBuilderAPI_MakeWire_1())
    singleBuilder.Add_1(e)
    sfw.Load_1(singleBuilder.Wire())
  }
  sfw.SetPrecision(WIRE_HEAL_TOL)
  sfw.FixReorder_1()
  sfw.FixConnected_1(WIRE_HEAL_TOL)
  sfw.Perform()
  return sfw.Wire()
}

/**
 * Run ShapeFix_Wire on an existing wire to close gaps at joints
 * (FixReorder + FixConnected). Use when the wire may have been built successfully
 * but carries endpoint imprecision that can destabilize downstream
 * operations (e.g. MakePipeShell).
 */
export function healWire(oc: OccModule, scope: DisposeScope, wire: OccShape): OccShape {
  const sfw = scope.track(new oc.ShapeFix_Wire_1())
  sfw.Load_1(wire)
  sfw.SetPrecision(WIRE_HEAL_TOL)
  sfw.FixReorder_1()
  sfw.FixConnected_1(WIRE_HEAL_TOL)
  sfw.Perform()
  return sfw.Wire()
}

/**
 * Planar face from an outer wire (+ optional hole wires), with the same
 * ShapeFix_Face.FixOrientation pass as `ocp_make_face_from_wire` so the face
 * normal sign matches Python. Hole wires are added with MakeFace.Add before the
 * orientation fix, mirroring the Python builder's `Add` loop.
 */
export function makeFaceFromWire(
  oc: OccModule,
  scope: DisposeScope,
  outerWire: OccShape,
  holeWires: OccShape[] = [],
): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(outerWire, true))
  for (const hw of holeWires) builder.Add(hw)
  const raw = builder.Face()
  const fixer = scope.track(new oc.ShapeFix_Face_2(raw))
  fixer.FixOrientation_1()
  fixer.Perform()
  return fixer.Face()
}

/** Linear extrusion of a face along direction * distance (ocp_make_prism, Copy=True). */
export function makePrism(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  direction: Vec3,
  distance: number,
): OccShape {
  if (distance === 0) throw new Error('extrude distance must be non-zero')
  const vec = scope.track(
    new oc.gp_Vec_4(direction[0] * distance, direction[1] * distance, direction[2] * distance),
  )
  const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, true, true))
  return builder.Shape()
}

// --- tessellation primitive ------------------------------------------------

/**
 * BRepMesh_IncrementalMesh on a shape, matching cadquery's `Shape.mesh`:
 * `BRepMesh_IncrementalMesh(shape, tol, True, angTol)` -- isRelative=True,
 * parallel defaulting False. The relative flag scales deflection by the shape's
 * size, so meshing each face individually (as cadquery does) is what reproduces
 * Python's per-face triangulation; do not substitute a single solid-level mesh.
 */
export function meshShape(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  linearDeflection: number,
  angularDeflection: number,
): void {
  scope.track(new oc.BRepMesh_IncrementalMesh_2(shape, linearDeflection, true, angularDeflection, false))
}

export interface FaceTessellation {
  /** Per-face vertices in world coordinates (location transform applied). */
  vertices: Vec3[]
  /** Triangles as 0-based indices into `vertices`, winding fixed for orientation. */
  triangles: [number, number, number][]
}

/**
 * Replicate cadquery `Face.tessellate(linear, angular)` for a single face:
 * mesh it, read its `Poly_Triangulation`, transform nodes by the location, and
 * emit triangles with REVERSED-orientation winding flipped -- node-for-node, so
 * the assembled mesh matches Python's. Returns empty when the face has no
 * triangulation.
 */
export function tessellateFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  linearDeflection: number,
  angularDeflection: number,
): FaceTessellation {
  meshShape(oc, scope, face, linearDeflection, angularDeflection)
  const loc = scope.track(new oc.TopLoc_Location_1())
  const handle = scope.track(oc.BRep_Tool.Triangulation(face, loc))
  if (handle.IsNull()) return { vertices: [], triangles: [] }
  const poly = handle.get()
  if (!poly) return { vertices: [], triangles: [] }

  const trsf = scope.track(loc.Transformation())
  const reverse = isReversed(oc, face)

  const vertices: Vec3[] = []
  const nbNodes = poly.NbNodes()
  for (let i = 1; i <= nbNodes; i++) {
    const n = scope.track(poly.Node(i).Transformed(trsf))
    vertices.push([n.X(), n.Y(), n.Z()])
  }

  const triangles: [number, number, number][] = []
  const nbTri = poly.NbTriangles()
  for (let i = 1; i <= nbTri; i++) {
    const t = poly.Triangle(i)
    const a = t.Value(1) - 1
    const b = t.Value(2) - 1
    const c = t.Value(3) - 1
    triangles.push(reverse ? [a, c, b] : [a, b, c])
  }
  return { vertices, triangles }
}

// --- face geometry readers -------------------------------------------------

export type SurfaceType = 'flatface' | 'cylinderface' | 'face'

export function faceCentroid(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false)
  const c = props.CentreOfMass()
  return [c.X(), c.Y(), c.Z()]
}

export function faceArea(oc: OccModule, scope: DisposeScope, face: OccShape): number {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false)
  return props.Mass()
}

export function faceSurfaceType(oc: OccModule, scope: DisposeScope, face: OccShape): SurfaceType {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) return 'flatface'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) return 'cylinderface'
  return 'face'
}

function isReversed(oc: OccModule, face: OccShape): boolean {
  return (face as OccOrientedShape).Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value
}

/**
 * Face normal at the UV-domain midpoint, oriented outward (flipped when the
 * face is REVERSED), matching `_compute_face_normal` + cadquery's
 * orientation-aware normal. Verified sign-for-sign against the Python box.
 */
export function faceNormal(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const u = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
  const v = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
  const props = scope.track(new oc.BRepLProp_SLProps_1(adaptor, u, v, 1, 1e-9))
  const n = props.Normal()
  const sign = isReversed(oc, face) ? -1 : 1
  return [n.X() * sign, n.Y() * sign, n.Z() * sign]
}

// --- edge / vertex geometry readers ---------------------------------------

const TWO_PI = 2 * Math.PI
const CIRCLE_TOL = 1e-4
// Sort-key quantisation only; exact banker's-rounding parity with Python's
// round() is unnecessary because the values compared are well-separated.
export const round6 = (x: number): number => Math.round(x * 1e6) / 1e6

/** Mirror of `edge_to_geom_dict`: (geometry, deterministic sort key) for an edge. */
export function edgeToGeom(
  oc: OccModule,
  scope: DisposeScope,
  edge: OccShape,
): { ed: EdgeData; sortKey: EdgeSortKey } {
  const ad = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const t = ad.GetType().value
  const u0 = ad.FirstParameter()
  const u1 = ad.LastParameter()

  if (t === oc.GeomAbs_CurveType.GeomAbs_Line.value) {
    const sp = ad.Value(u0)
    const ep = ad.Value(u1)
    const s: Vec3 = [sp.X(), sp.Y(), sp.Z()]
    const e: Vec3 = [ep.X(), ep.Y(), ep.Z()]
    // type_order 0 keeps straight edges before curved (fillet-arc-stable indices).
    return {
      ed: { kind: 'line', start: s, end: e },
      sortKey: [0, 'line', round6(s[0]), round6(s[1]), round6(s[2]), round6(e[0]), round6(e[1]), round6(e[2])],
    }
  }

  if (t === oc.GeomAbs_CurveType.GeomAbs_Circle.value) {
    const circ = scope.track(ad.Circle())
    const c = circ.Location()
    const axis = circ.Axis().Direction()
    const xdir = circ.XAxis().Direction()
    const radius = circ.Radius()
    const center: Vec3 = [c.X(), c.Y(), c.Z()]
    const ax: Vec3 = [axis.X(), axis.Y(), axis.Z()]
    const xd: Vec3 = [xdir.X(), xdir.Y(), xdir.Z()]
    const span = u1 - u0
    const isFull = Math.abs(Math.abs(span) - TWO_PI) < CIRCLE_TOL || Math.abs(span) < CIRCLE_TOL
    const kind: 'circle' | 'arc' = isFull ? 'circle' : 'arc'
    return {
      ed: { kind, center, radius, axis: ax, x_axis: xd, angle_start: u0, angle_end: u1 },
      // x_axis breaks the tie between the two semicircle halves OCC makes for a
      // full circle (same center/radius/span) so their order is stable.
      sortKey: [1, kind, round6(center[0]), round6(center[1]), round6(center[2]), round6(radius), round6(u0), round6(u1), round6(xd[0]), round6(xd[1]), round6(xd[2])],
    }
  }

  if (t === oc.GeomAbs_CurveType.GeomAbs_Ellipse.value) {
    // First-class elliptical edge. The matching `edgeGeometryHash` ellipse
    // branch keeps distinct ellipses on distinct geom hashes (selection ids /
    // ancestry queries); see edgeGeomHashCoupling.test.ts.
    const el = scope.track(ad.Ellipse())
    const c = el.Location()
    const axis = el.Axis().Direction()
    const xdir = el.XAxis().Direction()
    const a = el.MajorRadius()
    const b = el.MinorRadius()
    const center: Vec3 = [c.X(), c.Y(), c.Z()]
    const ax: Vec3 = [axis.X(), axis.Y(), axis.Z()]
    const xd: Vec3 = [xdir.X(), xdir.Y(), xdir.Z()]
    return {
      ed: { kind: 'ellipse', center, a, b, axis: ax, x_axis: xd, angle_start: u0, angle_end: u1 },
      // u0/u1 distinguish a partial elliptical arc from a full ellipse and keep
      // two arcs of the same conic on distinct geom hashes (mirrors the arc arm).
      sortKey: [1, 'ellipse', round6(center[0]), round6(center[1]), round6(center[2]), round6(a), round6(b), round6(u0), round6(u1), round6(xd[0]), round6(xd[1]), round6(xd[2])],
    }
  }

  // Fallback: sample the curve into a polyline (matches the Python spline arm;
  // NURBS curve_data extraction is a geom_hash concern deferred to 2c).
  const N = 32
  const points: Vec3[] = []
  for (let i = 0; i <= N; i++) {
    const u = u0 + ((u1 - u0) * i) / N
    const p = ad.Value(u)
    points.push([p.X(), p.Y(), p.Z()])
  }
  const mid = points[N / 2]
  return {
    ed: { kind: 'spline', points },
    sortKey: [1, 'spline', round6(mid[0]), round6(mid[1]), round6(mid[2]), 0, 0, 0],
  }
}

/** Unique edges of a solid (deduped by topological identity), with geometry + sort key. */
export function readSolidEdges(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
): { ed: EdgeData; sortKey: EdgeSortKey }[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const uniq: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const edge = scope.track(oc.TopoDS.Edge_1(exp.Current())) as OccSubShape
    if (!uniq.some((u) => u.IsSame(edge))) uniq.push(edge)
  }
  return uniq.map((edge) => edgeToGeom(oc, scope, edge))
}

/** Unique B-rep vertices of a solid (deduped by topological identity). */
export function readSolidVertices(oc: OccModule, scope: DisposeScope, solid: OccShape): Vec3[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  const uniq: OccSubShape[] = []
  const out: Vec3[] = []
  for (; exp.More(); exp.Next()) {
    const v = scope.track(oc.TopoDS.Vertex_1(exp.Current())) as OccSubShape
    if (uniq.some((u) => u.IsSame(v))) continue
    uniq.push(v)
    const p = oc.BRep_Tool.Pnt(v)
    out.push([p.X(), p.Y(), p.Z()])
  }
  return out
}

/**
 * Sample points along every edge of a solid, for a mesh-free bounding box.
 * Straight edges contribute only their endpoints; curved edges are sampled at
 * `samplesPerEdge` interior+boundary parameters via `BRepAdaptor_Curve.Value`
 * (the same adaptor the spline arm of `edgeToGeom` already drives). This lets a
 * cylinder's circular edges carry its full diameter into the AABB with no
 * triangulation, so `cls_*` classification never depends on the render mesh.
 */
export function readEdgeSamplePoints(
  oc: OccModule,
  scope: DisposeScope,
  solid: OccShape,
  samplesPerEdge: number,
): Vec3[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const seen: OccSubShape[] = []
  const out: Vec3[] = []
  for (; exp.More(); exp.Next()) {
    const edge = scope.track(oc.TopoDS.Edge_1(exp.Current())) as OccSubShape
    if (seen.some((u) => u.IsSame(edge))) continue
    seen.push(edge)
    const ad = scope.track(new oc.BRepAdaptor_Curve_2(edge))
    const isLine = ad.GetType().value === oc.GeomAbs_CurveType.GeomAbs_Line.value
    const u0 = ad.FirstParameter()
    const u1 = ad.LastParameter()
    const segments = isLine ? 1 : Math.max(1, samplesPerEdge)  // lines: endpoints only
    for (let i = 0; i <= segments; i++) {
      const u = u0 + ((u1 - u0) * i) / segments
      const p = ad.Value(u)
      out.push([p.X(), p.Y(), p.Z()])
    }
  }
  return out
}
