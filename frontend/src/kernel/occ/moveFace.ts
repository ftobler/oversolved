// Move-face, OCC only (no construction naming): move a planar B-rep face along
// its outward normal by a signed distance, extending the faces that bound it.
//
// Construction (probed against opencascade.js 1.1.0p1, OCCT 7.4.0p1; every
// volume pinned by occ/__tests__/moveFaceReal.test.ts):
//
//   1. Slab: a big planar face on the picked face's plane, swept by n*d, is the
//      region between the face and its target plane.
//   2. Extended neighbours: for every edge of the face, the adjacent face is
//      rebuilt as a large bounded face on its underlying surface (plane /
//      cylinder / cone), wide enough to cross the slab. A cone is stopped at
//      its apex so only one nappe splits.
//   3. Split: BRepAlgoAPI_Splitter splits the slab by those extended faces into
//      cells.
//   4. Cell selection: a cell's face lying on the picked plane is classified
//      against the picked face's outer wire (one interior triangle centroid per
//      piece -- a face centroid can fall outside an annulus). Cells inside an
//      inner wire follow the hole/boss rule below.
//   5. Apply: outward Fuse, inward Cut, then clean through booleanWithDiff.
//
// No naming happens here: the leaf builds the tool name maps from `capFaces`
// (the moved face's UUID) and `extensionOf` (each lateral cell face's extended
// neighbour), and `booleanWithDiff` carries them.

import { type DisposeScope } from './disposeScope'
import type { OccEnumValue, OccModule, OccPnt, OccShape, OccSubShape } from './occTypes'
import { canonicalFaces, canonicalEdges } from './bodyNames'
import { SubShapeMap } from './subshapeIdentity'
import { faceCentroid, faceNormal } from './primitives'
import { booleanWithDiff, type FaceOrigin } from './booleans'
import type { BrepDiff } from '../types3d'
import { TOL_MOVE_FACE_TANGENT } from '../solverConstants'

type Vec3 = [number, number, number]

/** The edge convexity BRepOffset_Analyse reports, narrowed to the four the
 *  move-face rules care about. */
export type EdgeKind = 'convex' | 'concave' | 'tangent' | 'other'

/** The three neighbour surface classes a v1 extension can rebuild; anything
 *  else is refused by name. */
export type NeighbourSurface = 'plane' | 'cylinder' | 'cone'

export interface MoveFaceCells {
  // The picked cells (tool solids), in splitter order.
  cells: OccShape[]
  // Cell faces lying on the moved face's target plane (become the moved face).
  capFaces: OccShape[]
  // Cell lateral face -> the body face it extends (its naming source).
  extensionOf: SubShapeMap<OccShape>
}

/** A guard refusal. The message reaches the user through the feature failure
 *  path, so it names the geometry that blocked the move. */
export class MoveFaceRefusal extends Error {}

// ─── small OCC readers ───

function exploreFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return canonicalFaces(oc, scope, shape) as OccShape[]
}
function exploreEdges(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return canonicalEdges(oc, scope, shape) as OccShape[]
}
function exploreSolids(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_SOLID, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Solid_1(scope.track(exp.Current()))))
  return out
}
function exploreWires(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Wire_1(scope.track(exp.Current()))))
  return out
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/** The surface class of a face, or null for the classes v1 cannot extend. */
export function neighbourSurface(oc: OccModule, scope: DisposeScope, face: OccShape): NeighbourSurface | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) return 'plane'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) return 'cylinder'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cone.value) return 'cone'
  return null
}

function isPlanar(oc: OccModule, scope: DisposeScope, face: OccShape): boolean {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  return adaptor.GetType().value === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value
}

/**
 * A large bounded face on `face`'s underlying surface, spanning the slab. The
 * plane/cylinder v range is [-L, L]; the cone is clipped at its apex so the
 * second nappe never splits the slab.
 */
export function extendNeighbourFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  L: number,
): OccShape {
  const kind = neighbourSurface(oc, scope, face)
  if (kind === null) {
    const name = faceSurfaceName(oc, scope, face)
    throw new MoveFaceRefusal(`move_face: neighbour face of type ${name} cannot be extended (v1)`)
  }
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  if (kind === 'plane') {
    return scope.track(
      new oc.BRepBuilderAPI_MakeFace_9(adaptor.Plane(), -L, L, -L, L).Face(),
    )
  }
  if (kind === 'cylinder') {
    return scope.track(
      new oc.BRepBuilderAPI_MakeFace_10(adaptor.Cylinder(), 0, 2 * Math.PI, -L, L).Face(),
    )
  }
  const cone = adaptor.Cone()
  const semi = cone.SemiAngle()
  const refR = cone.RefRadius()
  // v runs along the slant; the apex is where the radius reaches zero.
  const vApex = -refR / Math.sin(semi)
  let lo = -L
  let hi = L
  if (semi < 0) hi = vApex
  else lo = vApex
  return scope.track(new oc.BRepBuilderAPI_MakeFace_11(cone, 0, 2 * Math.PI, lo, hi).Face())
}

/** The GeomAbs surface type name, for a refusal message. */
function faceSurfaceName(oc: OccModule, scope: DisposeScope, face: OccShape): string {
  const t = scope.track(new oc.BRepAdaptor_Surface_2(face, true)).GetType().value
  const S = oc.GeomAbs_SurfaceType
  for (const [name, v] of Object.entries(S) as [string, OccEnumValue][]) {
    if (v.value === t) return name.replace(/^GeomAbs_/, '')
  }
  return `type ${t}`
}

/**
 * One `BRepOffset_Analyse_2(body, tol)` per call; the returned function reports
 * each edge's convexity. `TOL_MOVE_FACE_TANGENT` is the angular tolerance, the
 * same "tangent" the project treats a smooth join as. An edge the analyse does
 * not know reports 'other'.
 */
export function classifyFaceEdges(
  oc: OccModule,
  scope: DisposeScope,
  body: OccShape,
): (edge: OccShape) => EdgeKind {
  const analyse = scope.track(new oc.BRepOffset_Analyse_2(body, TOL_MOVE_FACE_TANGENT))
  const names: Record<number, EdgeKind> = {
    [oc.BRepOffset_Type.BRepOffset_Convex.value]: 'convex',
    [oc.BRepOffset_Type.BRepOffset_Concave.value]: 'concave',
    [oc.BRepOffset_Type.BRepOffset_Tangent.value]: 'tangent',
    [oc.BRepOffset_Type.BRepOffset_Other.value]: 'other',
  }
  return (edge: OccShape): EdgeKind => {
    const list = scope.track(analyse.Type(edge))
    if (list.Size() === 0) return 'other'
    return names[scope.track(list.First_1()).Type_2().value] ?? 'other'
  }
}

/** One interior point per planar piece of a face: a mesh triangle centroid.
 *  A face centroid can sit in a hole of an annulus; a triangle centroid cannot. */
function representativePoints(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3[] {
  const mesher = scope.track(new oc.BRepMesh_IncrementalMesh_2(face, 0.05, false, 0.3, false))
  void mesher
  const loc = scope.track(new oc.TopLoc_Location_1())
  const handle = scope.track(oc.BRep_Tool.Triangulation(face, loc))
  if (handle.IsNull()) return []
  const tri = handle.get()
  if (tri === null) return []
  const out: Vec3[] = []
  for (let i = 1; i <= tri.NbTriangles(); i++) {
    const t = scope.track(tri.Triangle(i))
    const a = scope.track(tri.Node(t.Value(1)))
    const b = scope.track(tri.Node(t.Value(2)))
    const c = scope.track(tri.Node(t.Value(3)))
    out.push([(a.X() + b.X() + c.X()) / 3, (a.Y() + b.Y() + c.Y()) / 3, (a.Z() + b.Z() + c.Z()) / 3])
  }
  return out
}

/** Classify `p` against `face`: true when IN or ON (tolerance exercised at the
 *  boundary of an inner wire). */
function pointInFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  p: Vec3,
): boolean {
  const pnt: OccPnt = scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2]))
  const classifier = scope.track(new oc.BRepClass_FaceClassifier_1())
  classifier.Perform_2(face, pnt, 1e-6)
  const state = classifier.State().value
  return state === oc.TopAbs_State.TopAbs_IN.value || state === oc.TopAbs_State.TopAbs_ON.value
}

/** A face on `wire`'s plane (the outer-wire region or an inner hole/boss loop). */
function faceFromWire(oc: OccModule, scope: DisposeScope, wire: OccShape): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(wire, true))
  if (!builder.IsDone()) throw new MoveFaceRefusal('move_face: a face loop could not be rebuilt as a planar face')
  return scope.track(builder.Face())
}

/** The inner wires of `face` and the single edge kind each is made of. A wire
 *  with mixed kinds refuses rather than guessing the hole/boss rule. */
function innerWireKinds(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  outerWire: OccShape,
  edgeKind: (edge: OccShape) => EdgeKind,
): { face: OccShape; kind: EdgeKind }[] {
  const out: { face: OccShape; kind: EdgeKind }[] = []
  for (const wire of exploreWires(oc, scope, face)) {
    if ((wire as OccSubShape).IsSame(outerWire as OccSubShape)) continue
    const kinds = new Set(exploreEdges(oc, scope, wire).map(edgeKind))
    if (kinds.size !== 1) {
      throw new MoveFaceRefusal('move_face: an inner loop has mixed edge types; cannot decide the hole/boss rule')
    }
    const kind = [...kinds][0]
    if (kind !== 'convex' && kind !== 'concave') {
      throw new MoveFaceRefusal('move_face: an inner loop is not a plain hole or boss (a tangent or free-boundary edge)')
    }
    out.push({ face: faceFromWire(oc, scope, wire), kind })
  }
  return out
}

/** Is the picked cell's planar piece on the picked plane? (parallel normal and
 *  a centroid on the plane through `c0`). */
function onPickedPlane(oc: OccModule, scope: DisposeScope, face: OccShape, n: Vec3, c0: Vec3): boolean {
  if (!isPlanar(oc, scope, face)) return false
  const c = faceCentroid(oc, scope, face)
  return Math.abs(dot(sub(c, c0), n)) <= 1e-6
}

/**
 * Build and select the cells for moving `face` by signed `d`. Throws
 * MoveFaceRefusal for every guard: a non-planar or tangent-bounded face, an
 * unsupported neighbour surface, an unbounded cell, a failed split or no cell.
 */
export function moveFaceCells(
  oc: OccModule,
  scope: DisposeScope,
  body: OccShape,
  face: OccShape,
  d: number,
): MoveFaceCells {
  if (!isPlanar(oc, scope, face)) {
    throw new MoveFaceRefusal('move_face: only planar faces can be moved (v1)')
  }
  const n = faceNormal(oc, scope, face)
  const c0 = faceCentroid(oc, scope, face)

  // The plane frame gives the slab's lateral walls their u/v at +-L.
  const planeAdaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const position = scope.track(planeAdaptor.Plane().Position())
  const origin = position.Location()
  const pOrigin: Vec3 = [origin.X(), origin.Y(), origin.Z()]
  const xd = position.XDirection()
  const yd = position.YDirection()
  const pX: Vec3 = [xd.X(), xd.Y(), xd.Z()]
  const pY: Vec3 = [yd.X(), yd.Y(), yd.Z()]

  const bboxL = bboxDiagonal(oc, scope, body)
  const L = 4 * (bboxL + Math.abs(d))

  const edgeKind = classifyFaceEdges(oc, scope, body)
  const edges = exploreEdges(oc, scope, face)

  // Extended neighbour per edge; a tangent-bound face has no meaningful
  // extension and is refused, an unsupported surface is refused by name.
  const toolFaces: OccShape[] = []
  const toolNeighbour: OccShape[] = []
  for (const e of edges) {
    const kind = edgeKind(e)
    if (kind === 'tangent') {
      throw new MoveFaceRefusal(
        'move_face: the picked face has a tangent neighbour (a fillet?); move it together or remove the fillet first',
      )
    }
    const neighbour = neighbourAcross(oc, scope, body, face, e)
    if (neighbour === null) continue
    const extended = extendNeighbourFace(oc, scope, neighbour, L)
    toolFaces.push(extended)
    toolNeighbour.push(neighbour)
  }
  if (toolFaces.length === 0) {
    throw new MoveFaceRefusal('move_face: the picked face has no neighbours to extend')
  }

  // Slab: a big face on the picked plane, swept by n*d.
  const bigFace = scope.track(
    new oc.BRepBuilderAPI_MakeFace_9(planeAdaptor.Plane(), -L, L, -L, L).Face(),
  )
  const slab = makePrism(oc, scope, bigFace, n, d)

  const cells = splitCells(oc, scope, slab, toolFaces)

  // The picked region and its inner loops.
  const outerWire = scope.track(oc.BRepTools.OuterWire(face))
  const outerFace = faceFromWire(oc, scope, outerWire)
  const inner = innerWireKinds(oc, scope, face, outerWire, edgeKind)

  const picked: OccShape[] = []
  for (const cell of cells) {
    if (isUnbounded(oc, scope, cell, pOrigin, pX, pY, L)) continue
    if (cellSelected(oc, scope, cell, n, c0, d, outerFace, inner)) picked.push(cell)
  }
  if (picked.length === 0) {
    throw new MoveFaceRefusal('move_face: no cell of the moved face could be selected')
  }

  // Cap faces (on the target plane) and the neighbour each lateral face extends.
  const pTarget: Vec3 = [c0[0] + n[0] * d, c0[1] + n[1] * d, c0[2] + n[2] * d]
  const capFaces: OccShape[] = []
  const extensionOf = new SubShapeMap<OccShape>()
  for (const cell of picked) {
    for (const cf of exploreFaces(oc, scope, cell)) {
      if (onPickedPlane(oc, scope, cf, n, pTarget)) {
        capFaces.push(cf)
        continue
      }
      const at = toolFaceContaining(oc, scope, toolFaces, cf)
      if (at >= 0) extensionOf.set(cf as OccSubShape, toolNeighbour[at] as OccSubShape)
    }
  }

  return { cells: picked, capFaces, extensionOf }
}

function bboxDiagonal(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const box = scope.track(new oc.Bnd_Box_1())
  oc.BRepBndLib.Add(shape, box, false)
  return Math.hypot(
    box.GetXmax() - box.GetXmin(),
    box.GetYmax() - box.GetYmin(),
    box.GetZmax() - box.GetZmin(),
  )
}

function makePrism(
  oc: OccModule,
  scope: DisposeScope,
  profile: OccShape,
  dir: Vec3,
  distance: number,
): OccShape {
  const vec = scope.track(new oc.gp_Vec_4(dir[0] * distance, dir[1] * distance, dir[2] * distance))
  const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(profile, vec, true, true))
  return scope.track(builder.Shape())
}

/** The one body face adjacent to `face` across `edge` (not `face` itself). */
function neighbourAcross(
  oc: OccModule,
  scope: DisposeScope,
  body: OccShape,
  face: OccShape,
  edge: OccShape,
): OccShape | null {
  for (const other of exploreFaces(oc, scope, body)) {
    if ((other as OccSubShape).IsSame(face as OccSubShape)) continue
    if (exploreEdges(oc, scope, other).some((e) => (e as OccSubShape).IsSame(edge as OccSubShape))) {
      return other
    }
  }
  return null
}

function splitCells(
  oc: OccModule,
  scope: DisposeScope,
  slab: OccShape,
  tools: OccShape[],
): OccShape[] {
  const splitter = scope.track(new oc.BRepAlgoAPI_Splitter_1())
  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(slab)
  const toolList = scope.track(new oc.TopTools_ListOfShape_1())
  for (const t of tools) toolList.Append_1(t)
  splitter.SetArguments(args)
  splitter.SetTools(toolList)
  splitter.Build()
  if (!splitter.IsDone()) throw new MoveFaceRefusal('move_face: the split of the moved face did not complete')
  return exploreSolids(oc, scope, scope.track(splitter.Shape()))
}

/** A picked cell reaching the slab's lateral wall (u or v at +-L) is not
 *  enclosed by the neighbours: an open shell the analyse did not catch. */
function isUnbounded(
  oc: OccModule,
  scope: DisposeScope,
  cell: OccShape,
  origin: Vec3,
  xd: Vec3,
  yd: Vec3,
  L: number,
): boolean {
  const eps = 1e-6 * L
  for (const f of exploreFaces(oc, scope, cell)) {
    const c = faceCentroid(oc, scope, f)
    const rel = sub(c, origin)
    if (Math.abs(dot(rel, xd)) >= L - eps || Math.abs(dot(rel, yd)) >= L - eps) return true
  }
  return false
}

/** Does the cell have an on-plane piece inside the picked face (honouring the
 *  inner wire hole/boss rule)? */
function cellSelected(
  oc: OccModule,
  scope: DisposeScope,
  cell: OccShape,
  n: Vec3,
  c0: Vec3,
  d: number,
  outerFace: OccShape,
  inner: { face: OccShape; kind: EdgeKind }[],
): boolean {
  let selected = false
  for (const cf of exploreFaces(oc, scope, cell)) {
    if (!onPickedPlane(oc, scope, cf, n, c0)) continue
    for (const p of representativePoints(oc, scope, cf)) {
      if (!pointInFace(oc, scope, outerFace, p)) continue
      let insideInner = false
      for (const loop of inner) {
        if (!pointInFace(oc, scope, loop.face, p)) continue
        insideInner = true
        // A hole mouth moves with the face on an inward move (the floor is
        // passed, the hole vanishes); a boss root moves with it on an outward
        // move (a short boss is swallowed).
        if (loop.kind === 'convex' && d < 0) selected = true
        if (loop.kind === 'concave' && d > 0) selected = true
      }
      if (!insideInner) selected = true
    }
  }
  return selected
}

/** The extended tool face `cf` lies on (-1 when none): matched by classifying a
 *  point of `cf` against each tool face's window. */
function toolFaceContaining(
  oc: OccModule,
  scope: DisposeScope,
  toolFaces: OccShape[],
  cf: OccShape,
): number {
  const p = faceCentroid(oc, scope, cf)
  for (let i = 0; i < toolFaces.length; i++) {
    if (pointInFace(oc, scope, toolFaces[i], p)) return i
  }
  return -1
}

export interface ApplyMoveFaceResult {
  shape: OccShape
  faceOrigin: FaceOrigin[]
  diff: BrepDiff
  cells: MoveFaceCells
}

/**
 * Move `face` on `body` by signed `d`: select the cells, then fuse (d > 0) or
 * cut (d < 0) them through `booleanWithDiff` (history + clean + soundness). The
 * picked cells are gathered into one compound tool so the shared boolean path is
 * used, not a private fuse.
 */
export function applyMoveFace(
  oc: OccModule,
  scope: DisposeScope,
  body: OccShape,
  face: OccShape,
  d: number,
): ApplyMoveFaceResult {
  const cells = moveFaceCells(oc, scope, body, face, d)
  const compound = scope.track(new oc.TopoDS_Compound())
  const builder = scope.track(new oc.BRep_Builder())
  builder.MakeCompound(compound)
  for (const c of cells.cells) builder.Add(compound, c)
  const res = booleanWithDiff(oc, scope, body, compound, d > 0 ? 'fuse' : 'cut')
  return { shape: res.shape, faceOrigin: res.faceOrigin, diff: res.diff, cells }
}

/** A face's outward normal + a point on it, for the leaf's handle anchor. */
export function faceNormalAndCentroid(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): { normal: Vec3; centroid: Vec3 } {
  return { normal: faceNormal(oc, scope, face), centroid: faceCentroid(oc, scope, face) }
}
