/**
 * The thin OCC.js adapter: the shared build/read primitives the higher layers
 * (shapes.ts, tessellation.ts) call.
 *
 * Every function takes a [[DisposeScope]] and tracks its transient OCC objects (points, dirs,
 * builders, adaptors) in it. Functions that produce a shape the caller keeps return it WITHOUT
 * tracking it, so the caller decides its lifetime (typically `HandleTable.register`); the scope
 * still owns the builder that made it. This is the ownership pattern the handle table relies on.
 *
 * Overload suffixes and arities were verified against opencascade.js@1.1.1 (OCC 7.5).
 * Out-parameter APIs (BRepTools.UVBounds, BRepGProp_Face.Normal) do not
 * marshal in emscripten, so UV bounds come from BRepAdaptor_Surface's First/Last parameter
 * accessors and the normal from BRepLProp_SLProps, both direct-return.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccOrientedShape, OccSubShape, OccSurfaceAdaptor } from './occTypes'
import type { EdgeData } from '@/types/cad'

export type Vec3 = [number, number, number]

/** Heterogeneous edge sort key (type_order, kind, then rounded coords). */
export type EdgeSortKey = (number | string)[]

// ─── primitive solids ───

/** Axis-aligned box of given dimensions (BRepPrimAPI_MakeBox(dx, dy, dz)).
 * @returns untracked - caller owns. */
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

/** Cylinder around `axis` through `center` (BRepPrimAPI_MakeCylinder(ax2, r, h)).
 * @returns untracked - caller owns. */
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

// ─── profile -> face -> prism ───

/** A straight edge between two world points (cadquery Edge.makeLine).
 * @returns untracked - caller owns. */
export function makeLineEdge(oc: OccModule, scope: DisposeScope, start: Vec3, end: Vec3): OccShape {
  const a = scope.track(new oc.gp_Pnt_3(start[0], start[1], start[2]))
  const b = scope.track(new oc.gp_Pnt_3(end[0], end[1], end[2]))
  const builder = scope.track(new oc.BRepBuilderAPI_MakeEdge_3(a, b))
  return builder.Edge()
}

/** A full-circle edge (ocp_make_circle + ocp_make_edge_from_circle).
 * @returns untracked - caller owns. */
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
 * @returns untracked - caller owns.
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

/** A cubic Bezier edge from 4 control points (sketch spline -> OCC edge).
 * @returns untracked - caller owns. */
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
 * @returns untracked - caller owns.
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
  // gp_Elips_2 throws a raw Standard_ConstructionError for b > a, and the
  // bindings may not propagate it as a catchable JS error at all. Refuse the
  // degenerate input here so a sketch that flips its ellipse axes fails by name
  // instead of building a parameterized-but-wrong curve.
  if (!(a > 0) || !(b > 0) || a < b) {
    throw new Error(`make_ellipse_edge: needs a >= b > 0 (got a=${a}, b=${b})`)
  }
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

/**
 * Unique B-rep vertices of a wire (deduped by topological identity, the same
 * `SubShapeDedup` the solid readers use). The explorer visits a shared vertex
 * once per owning edge, so the raw visit count is useless; the DEDUPED count is
 * the closure oracle: BRepBuilderAPI_MakeWire fuses coincident endpoints, so a
 * closed wire has exactly as many vertices as edges and an open one has one
 * more. Verified against opencascade.js@1.1.1: a full-circle wire reads 1/1, a
 * closed square 4/4, a three-sided chain 4 vertices for 3 edges.
 */
export function wireVertexCount(oc: OccModule, scope: DisposeScope, wire: OccShape): number {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  const dedup = new SubShapeDedup()
  let n = 0
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const v = scope.track(oc.TopoDS.Vertex_1(raw)) as OccSubShape
    if (dedup.add(v)) n++
  }
  return n
}

/**
 * The 3D distance at each joint of an ordered edge list, read from the edges OCC
 * actually built rather than from the uv coordinates they were asked for. This
 * is the measurement that answers "what does the KERNEL think the gap is": an
 * arc endpoint is forced onto its ideal circle, so it can sit ~1e-7..1e-6 away
 * from the joint point the solver produced, which is exactly the band
 * BRepBuilderAPI_MakeWire refuses. The uv-space counterpart is `describeProfile`
 * in kernel/profileDiagnostics.ts.
 *
 * One entry per edge: index i is the gap from edge i's last point to edge
 * (i+1)'s first point, so the final entry is the loop's closure gap.
 */
export function wireEndpointGaps(oc: OccModule, scope: DisposeScope, edges: OccShape[]): number[] {
  const ends = edges.map((e) => {
    const ad = scope.track(new oc.BRepAdaptor_Curve_2(e))
    // gp_Pnt proxies are by-value returns; only the coordinates outlive them.
    const sp = ad.Value(ad.FirstParameter())
    const ep = ad.Value(ad.LastParameter())
    const first: Vec3 = [sp.X(), sp.Y(), sp.Z()]
    const last: Vec3 = [ep.X(), ep.Y(), ep.Z()]
    sp.delete()
    ep.delete()
    return { first, last }
  })
  return ends.map((e, i) => {
    const next = ends[(i + 1) % ends.length].first
    return Math.hypot(e.last[0] - next[0], e.last[1] - next[1], e.last[2] - next[2])
  })
}

/** Assemble ordered edges into a wire (BRepBuilderAPI_MakeWire), with
 *  ShapeFix_Wire gap-healing when the raw wire build fails on sub-micron joints.
 *
 *  Guards connectivity: BRepBuilderAPI_MakeWire silently drops an edge whose
 *  joint gap exceeds its confusion tolerance, and the heal fallback cannot
 *  re-attach it (ShapeFix only re-loads one wire), so the wire would collapse
 *  to a subset and the sweep/extrude would produce a wrong-shape or single-face
 *  solid while still reporting ok. We instead fail loudly: a missing edge means
 *  the joints need snapping upstream (see collectPathEdges).
 *
 *  `requireClosed` adds the check the edge count cannot make. A chain of N edges
 *  that connects head to tail but never closes the LAST joint yields a wire with
 *  all N edges and IsDone() true, so the count guard passes and the face builder
 *  happily produces a solid off an open profile. Opt in wherever the wire is a
 *  profile boundary; leave it off for a wire that is legitimately open (the
 *  sweep spine). Default off so no existing caller changes meaning. */
export function makeWire(
  oc: OccModule,
  scope: DisposeScope,
  edges: OccShape[],
  { requireClosed = false }: { requireClosed?: boolean } = {},
): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeWire_1())
  for (const e of edges) builder.Add_1(e)
  let wire: OccShape | null = null
  try {
    wire = builder.Wire()
  } catch {
    wire = healWireFromEdges(oc, scope, edges)
  }
  // The wire is returned UNTRACKED (the caller owns it), so a guard that throws
  // has to free it here or the rejected proxy is stranded on the heap -- and a
  // dirty feature retries the build on every edit.
  const refuse = (message: string): never => {
    scope.release(wire as OccShape)
    throw new Error(message)
  }
  const got = edgeCount(oc, scope, wire)
  if (got < edges.length) {
    refuse(
      `makeWire: only ${got} of ${edges.length} edges connected; a joint gap exceeds the kernel tolerance (snap the joints upstream)`,
    )
  }
  if (requireClosed) {
    // A closed wire has exactly one vertex per edge. MORE means a joint never
    // fused and the chain hangs open; FEWER means two non-adjacent vertices
    // fused, so the wire closes but pinches into a figure-eight. They are
    // opposite defects and lumping them under "the wire is open" sends the
    // reader looking for a gap that is not there.
    const verts = wireVertexCount(oc, scope, wire)
    if (verts > got) {
      refuse(
        `makeWire: the wire is open (${got} edges but ${verts} distinct vertices); ` +
        `its last joint never closed, so this is not a profile boundary`,
      )
    }
    if (verts < got) {
      refuse(
        `makeWire: the wire is pinched (${got} edges sharing only ${verts} distinct vertices); ` +
        `it touches itself, so it does not bound a single region`,
      )
    }
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
function healWireFromEdges(oc: OccModule, scope: DisposeScope, edges: OccShape[]): OccShape {
  const sfw = scope.track(new oc.ShapeFix_Wire_1())
  for (const e of edges) {
    const singleBuilder = scope.track(new oc.BRepBuilderAPI_MakeWire_1())
    singleBuilder.Add_1(e)
    // Wire() is a by-value shape the fixer copies on Load: drop it right after.
    const w = singleBuilder.Wire()
    try {
      sfw.Load_1(w)
    } finally {
      w.delete()
    }
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
 * @returns untracked - caller owns.
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
 * @returns untracked - caller owns.
 */
export function makeFaceFromWire(
  oc: OccModule,
  scope: DisposeScope,
  outerWire: OccShape,
  holeWires: OccShape[] = [],
): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(outerWire, true))
  // onlyPlane=true makes OCC refuse a non-coplanar wire by leaving the builder
  // not-done. Nobody read that: `Face()` on a not-done builder does not throw in
  // this build, it hands back a NULL shape, which then travels all the way into
  // the prism as a silently wrong (or empty) body. Same check the sibling
  // edge-profile builder in features/edgeProfile.ts already makes.
  if (!builder.IsDone()) {
    throw new Error(
      `makeFaceFromWire: the outer wire (${edgeCount(oc, scope, outerWire)} edges, ` +
      `${wireVertexCount(oc, scope, outerWire)} vertices) does not bound a planar face`,
    )
  }
  // No IsDone() check per hole: BRepLib_MakeFace::Add(W) ends with an
  // unconditional `myError = BRepLib_FaceDone; Done();`, so the builder reports
  // done however bad the wire was. A rejected hole has to be caught by
  // validating the wire before adding it, not by asking the builder afterwards.
  for (const hw of holeWires) builder.Add(hw)
  // The pre-fix raw face is fully consumed by the ShapeFix pass (the fixed face
  // shares its TShapes), so free it immediately instead of stranding one proxy
  // per profile build on the heap.
  const raw = builder.Face()
  try {
    const fixer = scope.track(new oc.ShapeFix_Face_2(raw))
    fixer.FixOrientation_1()
    fixer.Perform()
    return fixer.Face()
  } finally {
    raw.delete()
  }
}

/** Linear extrusion of a face along direction * distance (ocp_make_prism, Copy=True).
 * @returns untracked - caller owns. */
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

// ─── tessellation primitive ───

/**
 * BRepMesh_IncrementalMesh on a shape, matching cadquery's `Shape.mesh`:
 * `BRepMesh_IncrementalMesh(shape, tol, True, angTol)` -- isRelative=True,
 * parallel defaulting False.
 *
 * Callers mesh face-by-face, and should keep doing so. Not because isRelative
 * scales the deflection with the meshed shape's size: it does not (OCC derives
 * it per sub-shape, so a shape-level call triangulates identically, verified
 * node-for-node on a compound whose faces differ in size by three orders of
 * magnitude). The real reason is peak memory: one shape-level call builds a
 * meshing context spanning every face at once. On a 3468-face import that
 * raised the emscripten heap high-water mark from 77 to 191 MiB to buy ~5% wall
 * time, the wrong trade for a kernel whose large-import failure mode is running
 * out of heap.
 *
 * The mesher object is deleted immediately: it is needed only for its
 * constructor side effect (the triangulation is stored on the face's TShape and
 * outlives it), and tracking one per face left thousands live for the walk.
 */
function meshShape(
  oc: OccModule,
  shape: OccShape,
  linearDeflection: number,
  angularDeflection: number,
): void {
  new oc.BRepMesh_IncrementalMesh_2(shape, linearDeflection, true, angularDeflection, false).delete()
}

interface FaceTessellation {
  // Per-face vertices in world coordinates (location transform applied).
  vertices: Vec3[]
  // Triangles as 0-based indices into `vertices`, winding fixed for orientation.
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
  meshShape(oc, face, linearDeflection, angularDeflection)
  const loc = scope.track(new oc.TopLoc_Location_1())
  const handle = scope.track(oc.BRep_Tool.Triangulation(face, loc))
  if (handle.IsNull()) return { vertices: [], triangles: [] }
  const poly = handle.get()
  if (!poly) return { vertices: [], triangles: [] }

  const trsf = scope.track(loc.Transformation())
  const reverse = isReversed(oc, face)

  // `Node`/`Triangle` hand back embind proxies over freshly allocated COPIES
  // (verified: mutating the proxy does not write back into the triangulation),
  // so each one owns WASM memory and must be deleted here. Tracking them in the
  // scope instead would hold one live object per mesh node until the whole shape
  // finished -- linear in triangulation size, which is what ran the heap out on
  // a large STEP import. Deleting eagerly keeps the live set O(1) per face.
  // The node is transformed IN PLACE (`Transform`, not `Transformed`) so the
  // loop allocates one object per node rather than two.
  const vertices: Vec3[] = []
  const nbNodes = poly.NbNodes()
  for (let i = 1; i <= nbNodes; i++) {
    const n = poly.Node(i)
    n.Transform(trsf)
    vertices.push([n.X(), n.Y(), n.Z()])
    n.delete()
  }

  const triangles: [number, number, number][] = []
  const nbTri = poly.NbTriangles()
  for (let i = 1; i <= nbTri; i++) {
    const t = poly.Triangle(i)
    const a = t.Value(1) - 1
    const b = t.Value(2) - 1
    const c = t.Value(3) - 1
    t.delete()
    triangles.push(reverse ? [a, c, b] : [a, b, c])
  }
  return { vertices, triangles }
}

// ─── face geometry readers ───

export type SurfaceType = 'flatface' | 'cylinderface' | 'coneface' | 'sphereface' | 'torusface' | 'face'

// The typeRestriction vocabulary of an ancestry query, classified by the
// geometric kind it names. One shared copy so every consumer (queryLabel,
// projectionMutations, later g2-H1) agrees on what counts as a face or an
// edge, instead of each hand-maintaining a partial list (g2-M2).
export function isFaceRestriction(tr: string | null): boolean {
  return tr === 'flatface' || tr === 'cylinderface' || tr === 'coneface' || tr === 'sphereface' || tr === 'torusface' || tr === 'face'
}

export function isEdgeRestriction(tr: string | null): boolean {
  return tr === 'edge' || tr === 'straightedge'
}

export function isVertexRestriction(tr: string | null): boolean {
  return tr === 'vertex'
}

/** The GeomAbs_SurfaceType enum mapping, factored so every reader of an adaptor
 *  shares one copy (`faceSurfaceType` and `faceSurfaceTypeAndNormal` both call
 *  it). A surface type outside the six modelled kinds collapses to 'face'. */
function surfaceTypeOf(oc: OccModule, adaptor: OccSurfaceAdaptor): SurfaceType {
  const t = adaptor.GetType().value
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) return 'flatface'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) return 'cylinderface'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cone.value) return 'coneface'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Sphere.value) return 'sphereface'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Torus.value) return 'torusface'
  return 'face'
}

/** The outward normal read off an adaptor the caller already built, with the
 *  single `IsNormalDefined` refusal every normal reader shares. The REVERSED
 *  sign flip and the throw message are pinned by primitivesReal.test.ts. */
function normalFromAdaptor(oc: OccModule, scope: DisposeScope, adaptor: OccSurfaceAdaptor, face: OccShape): Vec3 {
  const u = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
  const v = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
  const props = scope.track(new oc.BRepLProp_SLProps_1(adaptor, u, v, 1, 1e-9))
  if (!props.IsNormalDefined()) {
    const kind = adaptor.GetType().value
    throw new Error(`faceNormal: normal is not defined at the UV midpoint (surface type ${kind})`)
  }
  const n = props.Normal()
  const sign = isReversed(oc, face) ? -1 : 1
  const out: Vec3 = [n.X() * sign, n.Y() * sign, n.Z() * sign]
  n.delete()
  return out
}

export function faceSurfaceType(oc: OccModule, scope: DisposeScope, face: OccShape): SurfaceType {
  return surfaceTypeOf(oc, scope.track(new oc.BRepAdaptor_Surface_2(face, true)))
}

/**
 * Surface type + outward normal from ONE BRepAdaptor_Surface. `faceSortKey`
 * wants both for every face of a shape, and building the adaptor twice per face
 * was the largest single term in the face-pick cost (M45). `faceNormal` and
 * `faceSurfaceType` stay as they are for the callers that want one.
 */
export function faceSurfaceTypeAndNormal(
  oc: OccModule, scope: DisposeScope, face: OccShape,
): { surfaceType: SurfaceType; normal: Vec3 } {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  return { surfaceType: surfaceTypeOf(oc, adaptor), normal: normalFromAdaptor(oc, scope, adaptor, face) }
}

export function faceCentroid(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false)
  const c = props.CentreOfMass()
  const out: Vec3 = [c.X(), c.Y(), c.Z()]
  c.delete()
  return out
}

export function faceArea(oc: OccModule, scope: DisposeScope, face: OccShape): number {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false)
  return props.Mass()
}

/**
 * Centre of mass of a solid. The volume integral (not the vertex hull) so the
 * split-sibling ordering key in `features/bodySplit.ts` follows where the
 * material actually is, which is what makes it survive a resize of the parent.
 */
export function solidCentroid(oc: OccModule, scope: DisposeScope, solid: OccShape): Vec3 {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumeProperties_1(solid, props, true, false, false)
  const c = props.CentreOfMass()
  const out: Vec3 = [c.X(), c.Y(), c.Z()]
  c.delete()
  return out
}

/**
 * Cylinder axis direction from the V-derivative at the UV mid-point. For a
 * `gp_Cylinder` the V parameter runs along the axis, so dv is the axis
 * direction (unnormalised). Returns null for non-cylinder faces or when the
 * dv vector is degenerate.
 */
export function faceCylinderAxis(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  if (adaptor.GetType().value !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) return null
  const u = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
  const v = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
  const p = scope.track(new oc.gp_Pnt_1())
  const du = scope.track(new oc.gp_Vec_1())
  const dv = scope.track(new oc.gp_Vec_1())
  adaptor.D1(u, v, p, du, dv)
  const x = dv.X()
  const y = dv.Y()
  const z = dv.Z()
  const len = Math.sqrt(x * x + y * y + z * z)
  if (len < 1e-12) return null
  return [x / len, y / len, z / len]
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
  return normalFromAdaptor(oc, scope, scope.track(new oc.BRepAdaptor_Surface_2(face, true)), face)
}

/**
 * A curved face's analytic rotation frame: the axis a cylinder/cone/torus
 * turns about (a sphere has no axis) and a point ON that axis, read directly
 * off the adaptor's analytic surface. This is deliberately NOT `faceNormal`:
 * a cylinder's normal is radial, not axial, and an anchor that mates on the
 * normal aligns two radial vectors instead of coinciding two axes. See
 * `faceSurfaceFrame`.
 */
export interface SurfaceFrame {
  axis: Vec3
  origin: Vec3
  radius?: number
}

/**
 * Read a curved face's analytic rotation axis + a point on it, straight off
 * `BRepAdaptor_Surface`'s typed surface accessor. Returns null for a plane
 * (the caller already has the right axis: the face normal) and for any
 * surface class without a dedicated reader (B-spline, Bezier, ...). Never
 * falls back to `faceNormal`: a wrong axis is worse than no anchor, so an
 * unreadable surface yields no frame and the caller must not emit an anchor
 * for it (see `extractBodyAnchors`).
 */
export function faceSurfaceFrame(oc: OccModule, scope: DisposeScope, face: OccShape): SurfaceFrame | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  const S = oc.GeomAbs_SurfaceType
  if (t === S.GeomAbs_Cylinder.value) {
    const cyl = scope.track(adaptor.Cylinder())
    // Every accessor below returns a fresh by-value gp_* proxy; read the
    // components, drop the proxies, keep the numbers.
    const axis = cyl.Axis()
    const dir = axis.Direction()
    const pos = cyl.Position()
    const loc = pos.Location()
    const out: SurfaceFrame = {
      axis: [dir.X(), dir.Y(), dir.Z()],
      origin: [loc.X(), loc.Y(), loc.Z()],
      radius: cyl.Radius(),
    }
    loc.delete()
    pos.delete()
    dir.delete()
    axis.delete()
    return out
  }
  if (t === S.GeomAbs_Cone.value) {
    const cone = scope.track(adaptor.Cone())
    const axis = cone.Axis()
    const dir = axis.Direction()
    const pos = cone.Position()
    const loc = pos.Location()
    const out: SurfaceFrame = {
      axis: [dir.X(), dir.Y(), dir.Z()],
      origin: [loc.X(), loc.Y(), loc.Z()],
      radius: cone.RefRadius(),
    }
    loc.delete()
    pos.delete()
    dir.delete()
    axis.delete()
    return out
  }
  if (t === S.GeomAbs_Sphere.value) {
    const sph = scope.track(adaptor.Sphere())
    const pos = sph.Position()
    const loc = pos.Location()
    const out: SurfaceFrame = {
      axis: [0, 0, 1],  // a sphere has no rotation axis; [0,0,1] is a convention only
      origin: [loc.X(), loc.Y(), loc.Z()],
      radius: sph.Radius(),
    }
    loc.delete()
    pos.delete()
    return out
  }
  if (t === S.GeomAbs_Torus.value) {
    const tor = scope.track(adaptor.Torus())
    const axis = tor.Axis()
    const dir = axis.Direction()
    const pos = tor.Position()
    const loc = pos.Location()
    const out: SurfaceFrame = {
      axis: [dir.X(), dir.Y(), dir.Z()],
      origin: [loc.X(), loc.Y(), loc.Z()],
      radius: tor.MajorRadius(),
    }
    loc.delete()
    pos.delete()
    dir.delete()
    axis.delete()
    return out
  }
  return null
}

// ─── edge / vertex geometry readers ───

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
    sp.delete()
    ep.delete()
    // type_order 0 keeps straight edges before curved (fillet-arc-stable indices).
    return {
      ed: { kind: 'line', start: s, end: e },
      sortKey: [0, 'line', round6(s[0]), round6(s[1]), round6(s[2]), round6(e[0]), round6(e[1]), round6(e[2])],
    }
  }

  if (t === oc.GeomAbs_CurveType.GeomAbs_Circle.value) {
    const circ = scope.track(ad.Circle())
    // Location/Axis/XAxis each hand back a fresh by-value proxy: read the
    // components, drop the proxies, keep the numbers.
    const c = circ.Location()
    const ax1 = circ.Axis()
    const axis = ax1.Direction()
    const xax1 = circ.XAxis()
    const xdir = xax1.Direction()
    const radius = circ.Radius()
    const center: Vec3 = [c.X(), c.Y(), c.Z()]
    const ax: Vec3 = [axis.X(), axis.Y(), axis.Z()]
    const xd: Vec3 = [xdir.X(), xdir.Y(), xdir.Z()]
    axis.delete()
    ax1.delete()
    xdir.delete()
    xax1.delete()
    c.delete()
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
    const ax1 = el.Axis()
    const axis = ax1.Direction()
    const xax1 = el.XAxis()
    const xdir = xax1.Direction()
    const a = el.MajorRadius()
    const b = el.MinorRadius()
    const center: Vec3 = [c.X(), c.Y(), c.Z()]
    const ax: Vec3 = [axis.X(), axis.Y(), axis.Z()]
    const xd: Vec3 = [xdir.X(), xdir.Y(), xdir.Z()]
    axis.delete()
    ax1.delete()
    xdir.delete()
    xax1.delete()
    c.delete()
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
    p.delete()
  }
  const mid = points[N / 2]
  return {
    ed: { kind: 'spline', points },
    sortKey: [1, 'spline', round6(mid[0]), round6(mid[1]), round6(mid[2]), 0, 0, 0],
  }
}

/** Upper bound handed to `TopoDS_Shape.HashCode`. The largest signed 32-bit int
 *  spreads TShapes across the full range so identity buckets stay tiny. */
const SHAPE_HASH_UPPER = 2147483647  // 2^31 - 1

/**
 * O(n) topological-identity dedup for TopExp_Explorer output. A solid's explorer
 * yields each shared edge/vertex once per owning face, so a growing-array
 * `some(IsSame)` scan is O(n^2) in C++/JS boundary crossings (a 12k-edge STEP
 * import is ~150M IsSame calls). OCC's `HashCode` is TShape-derived and
 * orientation-independent, matching `IsSame`, so it buckets identities in one
 * crossing each; the bucket is confirmed with `IsSame` because the hash is
 * bounded and can (rarely) collide, keeping the result exactly correct.
 */
export class SubShapeDedup {
  private readonly buckets = new Map<number, OccSubShape[]>()
  // Synthetic shapes (unit-test mocks) may lack HashCode; fall back to a flat
  // IsSame scan so the helper still dedups without a real OCC TShape.
  private readonly flat: OccSubShape[] = []
  // Register a shape; returns true the first time this identity is seen.
  add(shape: OccSubShape): boolean {
    const hashFn = (shape as unknown as { HashCode?: (n: number) => number }).HashCode
    if (typeof hashFn !== 'function') {
      if (this.flat.some((u) => u.IsSame(shape))) return false
      this.flat.push(shape)
      return true
    }
    const key = hashFn.call(shape, SHAPE_HASH_UPPER)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) {
      this.buckets.set(key, [shape])
      return true
    }
    if (bucket.some((u) => u.IsSame(shape))) return false
    bucket.push(shape)
    return true
  }
  // Pure membership test, read-only. `add` doubles as one only while the query
  // set never grows; the boolean lineage passes pre-seed a pool then query NEW
  // shapes against it, where `add` would register the queries and reclassify
  // their second explorer occurrence (every shared new edge appears twice).
  has(shape: OccSubShape): boolean {
    const hashFn = (shape as unknown as { HashCode?: (n: number) => number }).HashCode
    if (typeof hashFn !== 'function') return this.flat.some((u) => u.IsSame(shape))
    const bucket = this.buckets.get(hashFn.call(shape, SHAPE_HASH_UPPER))
    return bucket !== undefined && bucket.some((u) => u.IsSame(shape))
  }
}

/**
 * O(1)-amortised map from a sub-shape's topological identity to an index,
 * the lookup counterpart to `SubShapeDedup`. Same `HashCode` bucketing so a
 * per-face `sortedEdges.findIndex(IsSame)` (O(F x E x E)) collapses to one
 * hash + a tiny bucket scan. Buckets are confirmed with `IsSame` because the
 * hash is bounded and can (rarely) collide, keeping the result exact.
 */
export class SubShapeIndexMap {
  private readonly buckets = new Map<number, { shape: OccSubShape; index: number }[]>()
  // Record `shape -> index`; later duplicates of the same identity are kept but never win a lookup.
  set(shape: OccSubShape, index: number): void {
    const key = shape.HashCode(SHAPE_HASH_UPPER)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) {
      this.buckets.set(key, [{ shape, index }])
      return
    }
    if (bucket.some((b) => b.shape.IsSame(shape))) return
    bucket.push({ shape, index })
  }
  // Index registered for this identity, or -1 if none.
  get(shape: OccSubShape): number {
    const bucket = this.buckets.get(shape.HashCode(SHAPE_HASH_UPPER))
    if (bucket === undefined) return -1
    const hit = bucket.find((b) => b.shape.IsSame(shape))
    return hit ? hit.index : -1
  }
}

/**
 * Every value registered under a sub-shape's topological identity, not just the
 * first -- the multi-valued counterpart to `SubShapeIndexMap`. Same HashCode
 * bucketing, same IsSame bucket confirm, so a `pairs.filter((p) => x.IsSame(p.k))`
 * inside a loop over `pairs`'s own key space collapses from O(n^2) crossings to
 * O(n) hashes.
 *
 * `stepIo`'s `UnplacedFaceIndex` hand-rolls this same map over a
 * `SubShapeIndexMap`; it is left alone because its identity semantics are
 * placement-sensitive in ways this map is not, but the general shape is here.
 */
export class SubShapeMultiIndex<T> {
  private readonly buckets = new Map<number, { shape: OccSubShape; values: T[] }[]>()
  // Record `shape -> value`, appending to the identity's value list so `get`
  // returns values in insertion order (Change 4b's `find(!fromTool) ?? matches[0]`
  // tie-break depends on it).
  add(shape: OccSubShape, value: T): void {
    const key = shape.HashCode(SHAPE_HASH_UPPER)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) {
      this.buckets.set(key, [{ shape, values: [value] }])
      return
    }
    const entry = bucket.find((b) => b.shape.IsSame(shape))
    if (entry !== undefined) {
      entry.values.push(value)
      return
    }
    bucket.push({ shape, values: [value] })
  }
  // Every value registered for this identity, or [] when unknown.
  get(shape: OccSubShape): readonly T[] {
    const bucket = this.buckets.get(shape.HashCode(SHAPE_HASH_UPPER))
    if (bucket === undefined) return []
    const entry = bucket.find((b) => b.shape.IsSame(shape))
    return entry !== undefined ? entry.values : []
  }
}

/**
 * Strip a shape's placement, so `IsSame` and `HashCode` compare TShapes alone.
 *
 * Needed because a STEP file with several roots comes back with each root under
 * its own `TopLoc_Location`, and the transfer binders hold the UNPLACED faces:
 * across a two-solid file, binder face vs explorer face is `IsPartner` for all
 * 12 and `IsSame` for none, so a plain `SubShapeIndexMap` silently matched
 * nothing and the whole import went unnamed. Both sides are normalised here.
 *
 * Two placements of ONE part (a repeated assembly instance) therefore collapse
 * to the same key. That is handled, not tolerated: `UnplacedFaceIndex` hands
 * the entity id to every instance, and the per-solid index folded into the UUID
 * path keeps their queries apart.
 *
 * `keep` copies live in `scope` because the index holds them; `borrow` is for a
 * lookup that ends inside the callback, and releases immediately.
 */
export function unplacer(oc: OccModule, scope: DisposeScope): {
  keep: (shape: OccShape) => OccSubShape
  borrow: <T>(shape: OccShape, read: (bare: OccSubShape) => T) => T
} {
  const identity = scope.track(new oc.TopLoc_Location_1())
  const strip = (shape: OccShape): OccSubShape => (shape as OccSubShape).Located(identity) as OccSubShape
  return {
    keep: (shape) => scope.track(strip(shape)),
    borrow: (shape, read) => {
      const bare = strip(shape)
      try {
        return read(bare)
      } finally {
        bare.delete()
      }
    },
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
  const dedup = new SubShapeDedup()
  const uniq: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const edge = scope.track(oc.TopoDS.Edge_1(raw)) as OccSubShape
    if (!dedup.add(edge)) continue
    if (oc.BRep_Tool.Degenerated?.(edge)) continue
    uniq.push(edge)
  }
  return uniq.map((edge) => edgeToGeom(oc, scope, edge))
}

/** Unique B-rep vertices of a solid (deduped by topological identity). */
export function readSolidVertices(oc: OccModule, scope: DisposeScope, solid: OccShape): Vec3[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  const dedup = new SubShapeDedup()
  const out: Vec3[] = []
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const v = scope.track(oc.TopoDS.Vertex_1(raw)) as OccSubShape
    if (!dedup.add(v)) continue
    const p = oc.BRep_Tool.Pnt(v)
    out.push([p.X(), p.Y(), p.Z()])
    p.delete()
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
  const dedup = new SubShapeDedup()
  const out: Vec3[] = []
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const edge = scope.track(oc.TopoDS.Edge_1(raw)) as OccSubShape
    if (!dedup.add(edge)) continue
    if (oc.BRep_Tool.Degenerated?.(edge)) continue
    const ad = scope.track(new oc.BRepAdaptor_Curve_2(edge))
    const isLine = ad.GetType().value === oc.GeomAbs_CurveType.GeomAbs_Line.value
    const u0 = ad.FirstParameter()
    const u1 = ad.LastParameter()
    const segments = isLine ? 1 : Math.max(1, samplesPerEdge)  // lines: endpoints only
    for (let i = 0; i <= segments; i++) {
      const u = u0 + ((u1 - u0) * i) / segments
      const p = ad.Value(u)
      out.push([p.X(), p.Y(), p.Z()])
      p.delete()
    }
  }
  return out
}
