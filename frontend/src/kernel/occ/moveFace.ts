// Move-face, OCC only (no construction naming): move a B-rep face along its
// outward normal by a signed distance, extending the faces that bound it.
//
// Construction (probed against opencascade.js 1.1.1p1, OCCT 7.4.0p1; every
// volume pinned by occ/__tests__/moveFaceReal.test.ts and
// moveFaceCurvedReal.test.ts):
//
//   1. Slab: the region between the picked face's surface S and its target S_d,
//      built per surface kind by `moveFaceSurfaces.ts` (a large face on the
//      plane swept by n*d for a plane; the outer primitive minus the inner one
//      for a cylinder/cone/sphere/torus).
//   2. Extended neighbours: for every edge of the face, the adjacent face is
//      rebuilt as a large bounded face on its underlying surface (plane /
//      cylinder / cone), wide enough to cross the slab. A cone is stopped at
//      its apex so only one nappe splits. A seam edge (a full curved face
//      bounds itself on both sides) and a degenerated edge (a sphere pole, a
//      cone apex) belong to the face itself and are skipped.
//   3. Split: BRepAlgoAPI_Splitter splits the slab by those extended faces into
//      cells.
//   4. Cell selection: a cell's piece lying on S is classified against the
//      picked face's outer-wire region on the same surface (one interior
//      triangle centroid per piece -- a face centroid can fall outside an
//      annulus). Pieces inside an inner wire follow the hole/boss rule below.
//      A curved piece's centroid sits off the surface by the mesh deflection,
//      which the classifier tolerance absorbs.
//   5. Apply: outward Fuse, inward Cut, then clean through booleanWithDiff.
//
// No naming happens here: the leaf builds the tool name maps from `capFaces`
// (the moved face's UUID) and `extensionOf` (each lateral cell face's extended
// neighbour), and `booleanWithDiff` carries them.

import { type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import { canonicalFaces, canonicalEdges } from './bodyNames'
import { SubShapeMap } from './subshapeIdentity'
import { faceCentroid } from './primitives'
import { booleanWithDiff, type FaceOrigin } from './booleans'
import type { BrepDiff } from '../types3d'
import { TOL_MOVE_FACE_TANGENT } from '../solverConstants'
import type { Vec3 } from '@/utils/vec3'
import {
  extendedNeighbourSolid,
  faceSurfaceName,
  MoveFaceRefusal,
  movedSurface,
  pointInFace,
  representativePoints,
  sameAnalyticSurface,
  type MovedSurface,
} from './moveFaceSurfaces'

export { MoveFaceRefusal } from './moveFaceSurfaces'

/** The edge convexity BRepOffset_Analyse reports, narrowed to the four the
 *  move-face rules care about. */
export type EdgeKind = 'convex' | 'concave' | 'tangent' | 'other'

/** The three neighbour surface classes an extension can rebuild; anything
 *  else is refused by name. */
export type NeighbourSurface = 'plane' | 'cylinder' | 'cone'

export interface MoveFaceCells {
  // The picked cells (tool solids), in splitter order.
  cells: OccShape[]
  // Cell faces lying on the moved face's target surface (become the moved face).
  capFaces: OccShape[]
  // Cell lateral face -> the body face it extends (its naming source).
  extensionOf: SubShapeMap<OccShape>
}

/** The classifier tolerance for the planar tool-window test, the shipped
 *  on-plane distance. */
const TOOL_FACE_TOL = 1e-6

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

/** The surface class of a face, or null for the classes move face cannot
 *  extend. */
export function neighbourSurface(oc: OccModule, scope: DisposeScope, face: OccShape): NeighbourSurface | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) return 'plane'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) return 'cylinder'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cone.value) return 'cone'
  return null
}

/** A seam edge of `face`: it bounds the face on both sides (a full cylinder,
 *  cone, sphere or torus carries one) so it has no neighbour to look across,
 *  and the analyse reads the join across it as tangent. A degenerated edge (a
 *  sphere pole, a cone apex) is a point, not a boundary. */
function isSeamOrDegenerate(oc: OccModule, face: OccShape, edge: OccShape): boolean {
  if (oc.BRep_Tool.Degenerated?.(edge)) return true
  return oc.BRep_Tool.IsClosed_2(edge, face)
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
    throw new MoveFaceRefusal(`move_face: neighbour face of type ${name} cannot be extended`)
  }
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  // adaptor.Plane()/Cylinder()/Cone() each return a fresh by-value gp_* proxy
  // owning WASM memory; scope owns them for the read (the faceLoops.computeFacePlane
  // rule), and the face builder copies the surface it is handed.
  if (kind === 'plane') {
    return scope.track(
      new oc.BRepBuilderAPI_MakeFace_9(scope.track(adaptor.Plane()), -L, L, -L, L).Face(),
    )
  }
  if (kind === 'cylinder') {
    return scope.track(
      new oc.BRepBuilderAPI_MakeFace_10(scope.track(adaptor.Cylinder()), 0, 2 * Math.PI, -L, L).Face(),
    )
  }
  const cone = scope.track(adaptor.Cone())
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

/** The inner wires of `face` and the single edge kind each is made of. A wire
 *  with mixed kinds refuses rather than guessing the hole/boss rule. */
function innerWireKinds(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  outerWire: OccShape,
  edgeKind: (edge: OccShape) => EdgeKind,
  regionFace: (wire: OccShape) => OccShape,
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
    out.push({ face: regionFace(wire), kind })
  }
  return out
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

/** Does the cell have a piece on the source surface inside the picked face
 *  (honouring the inner wire hole/boss rule)? Returns the pieces so the
 *  enclosure guard can check them. */
function selectCell(
  oc: OccModule,
  scope: DisposeScope,
  cell: OccShape,
  surface: MovedSurface,
  outerRegion: OccShape,
  inner: { face: OccShape; kind: EdgeKind }[],
  d: number,
): { selected: boolean; sourceFaces: OccShape[] } {
  let selected = false
  const sourceFaces: OccShape[] = []
  for (const cf of exploreFaces(oc, scope, cell)) {
    if (!surface.onSource(cf)) continue
    sourceFaces.push(cf)
    for (const p of representativePoints(oc, scope, cf)) {
      // A hole mouth moves with the face on an inward move (the floor is
      // passed, the hole vanishes); a boss root moves with it on an outward
      // move (a short boss is swallowed).
      const applyLoopRule = (kind: EdgeKind): void => {
        if (kind === 'convex' && d < 0) selected = true
        if (kind === 'concave' && d > 0) selected = true
      }
      const inOuter = surface.inRegion(outerRegion, p)
      if (!inOuter) {
        // Not plainly in the face: outside the outer wire (skip) or inside an
        // inner loop (the loop rule decides). A plane's rebuilt outer region
        // already covers its loops, so this branch only fires for curved kinds.
        for (const loop of inner) {
          if (surface.inRegion(loop.face, p)) applyLoopRule(loop.kind)
        }
        continue
      }
      let insideInner = false
      for (const loop of inner) {
        if (!surface.inRegion(loop.face, p)) continue
        insideInner = true
        applyLoopRule(loop.kind)
      }
      if (!insideInner) selected = true
    }
  }
  return { selected, sourceFaces }
}

/** The extended tool face `cf` lies on (-1 when none): the analytic surface
 *  compare first (a curved cell piece's centroid sits off its own surface, so
 *  the classifier alone cannot see it), then the shipped window test. */
function toolFaceContaining(
  oc: OccModule,
  scope: DisposeScope,
  toolFaces: OccShape[],
  cf: OccShape,
): number {
  const p = faceCentroid(oc, scope, cf)
  for (let i = 0; i < toolFaces.length; i++) {
    if (sameAnalyticSurface(oc, scope, cf, toolFaces[i])) return i
    if (pointInFace(oc, scope, toolFaces[i], p, TOOL_FACE_TOL)) return i
  }
  return -1
}

/**
 * Build and select the cells for moving `face` by signed `d`. Throws
 * MoveFaceRefusal for every guard: an unsupported or tangent-bounded face, an
 * unsupported neighbour surface, an unbounded cell, a failed split or no cell.
 */
export function moveFaceCells(
  oc: OccModule,
  scope: DisposeScope,
  body: OccShape,
  face: OccShape,
  d: number,
): MoveFaceCells {
  const surface = movedSurface(oc, scope, face, d)

  const bboxL = bboxDiagonal(oc, scope, body)
  const L = 4 * (bboxL + Math.abs(d))

  const edgeKind = classifyFaceEdges(oc, scope, body)
  const edges = exploreEdges(oc, scope, face)

  // Extended neighbour per edge; a tangent-bound face has no meaningful
  // extension and is refused, an unsupported surface is refused by name. The
  // face's own seam and point-like (degenerated) edges are skipped.
  const toolFaces: OccShape[] = []
  const toolNeighbour: OccShape[] = []
  const solidTools: (OccShape | null)[] = []
  // A full curved splitter FACE is a closed shell with no free boundary and
  // does not partition the slab, so a cell can span a sibling the user did not
  // pick. Keep the shipped face tools by default and offer a solid replacement
  // only for a neighbour cylinder that lies inside the picked surface's radius
  // (the bore that fails to cut); a solid on a same-radius or larger neighbour
  // feeds UnifySameDomain an invalid weld.
  const sourceRadius =
    surface.kind === 'cylinder'
      ? scope.track(scope.track(new oc.BRepAdaptor_Surface_2(face, true)).Cylinder()).Radius()
      : null
  for (const e of edges) {
    if (isSeamOrDegenerate(oc, face, e)) continue
    const kind = edgeKind(e)
    if (kind === 'tangent') {
      throw new MoveFaceRefusal(
        'move_face: the picked face has a tangent neighbour (a fillet?); move it together or remove the fillet first',
      )
    }
    const neighbour = neighbourAcross(oc, scope, body, face, e)
    if (neighbour === null) continue
    toolFaces.push(extendNeighbourFace(oc, scope, neighbour, L))
    toolNeighbour.push(neighbour)
    let solid: OccShape | null = null
    if (sourceRadius !== null) {
      const nad = scope.track(new oc.BRepAdaptor_Surface_2(neighbour, true))
      if (nad.GetType().value === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) {
        const radius = scope.track(nad.Cylinder()).Radius()
        if (radius < sourceRadius - 1e-6) solid = extendedNeighbourSolid(oc, scope, neighbour, L)
      }
    }
    solidTools.push(solid)
  }
  if (toolFaces.length === 0) {
    throw new MoveFaceRefusal('move_face: the picked face has no neighbours to extend')
  }

  const slab = surface.slab(L)

  // The picked region and its inner loops.
  const outerRegion = surface.outerRegion()
  const outerWire = scope.track(oc.BRepTools.OuterWire(face))
  const inner = innerWireKinds(oc, scope, face, outerWire, edgeKind, surface.regionFace)
  const innerFaces = inner.map((l) => l.face)

  /** Split the slab with `tools` and select the cells the face claims. A
   *  refusal means the split is unusable (a cell reaching outside the picked
   *  region, or no cell at all), so the caller may retry with other tools. */
  const trySplit = (tools: OccShape[]): { picked: OccShape[]; refusal: string | null } => {
    let cells: OccShape[]
    try {
      cells = splitCells(oc, scope, slab, tools)
    } catch (e) {
      if (e instanceof MoveFaceRefusal) return { picked: [], refusal: e.message }
      throw e
    }
    const picked: OccShape[] = []
    for (const cell of cells) {
      const { selected, sourceFaces } = selectCell(oc, scope, cell, surface, outerRegion, inner, d)
      if (!selected) continue
      // Guard the cells the face actually claims: the neighbours must bound the
      // face's own region (a planar cell reaching the slab's lateral wall, or a
      // curved cell whose piece leaves the picked region, is an open shell the
      // analyse did not catch). A cell that is merely an outer piece (not under
      // the face) is skipped, not a refusal.
      try {
        surface.assertEnclosed(cell, sourceFaces, outerRegion, innerFaces, L)
      } catch (e) {
        if (e instanceof MoveFaceRefusal) return { picked: [], refusal: e.message }
        throw e
      }
      picked.push(cell)
    }
    if (picked.length === 0) {
      return { picked: [], refusal: 'move_face: no cell of the moved face could be selected' }
    }
    return { picked, refusal: null }
  }

  let result = trySplit(toolFaces)
  if (result.refusal !== null) {
    // Re-split with one or more neighbour tools replaced by a solid on the same
    // surface. The smallest replacement set that bounds the picked region wins,
    // so a single failing tool does not drag every lateral face into the
    // coincident-face merge that can spin on a pair of solid cuts.
    const usable = solidTools
      .map((solid, index) => (solid === null ? -1 : index))
      .filter((index) => index >= 0)
    const subsets: number[][] = []
    for (let mask = 1; mask < 1 << usable.length; mask++) {
      subsets.push(usable.filter((_, bit) => (mask & (1 << bit)) !== 0))
    }
    subsets.sort((a, b) => a.length - b.length)
    for (const subset of subsets) {
      const tools = toolFaces.map((f, index) =>
        subset.includes(index) ? solidTools[index] ?? f : f,
      )
      const attempt = trySplit(tools)
      if (attempt.refusal === null) {
        result = attempt
        break
      }
    }
  }
  if (result.refusal !== null) throw new MoveFaceRefusal(result.refusal)
  const picked = result.picked

  // Cap faces (on the target surface) and the neighbour each lateral face
  // extends.
  const capFaces: OccShape[] = []
  const extensionOf = new SubShapeMap<OccShape>()
  for (const cell of picked) {
    for (const cf of exploreFaces(oc, scope, cell)) {
      if (surface.onTarget(cf)) {
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

export interface ApplyMoveFaceResult {
  shape: OccShape
  faceOrigin: FaceOrigin[]
  diff: BrepDiff
  cells: MoveFaceCells
}

/** One picked face and the cells selected for it on the SAME body shape. */
export interface MoveFaceStep {
  face: OccShape
  cells: MoveFaceCells
}

export interface ApplyMoveFaceSetResult {
  shape: OccShape
  faceOrigin: FaceOrigin[]
  diff: BrepDiff
}

/**
 * Apply cells that were all selected on the SAME body shape in one boolean.
 * Moving several faces together is a function of the picked set, not its order:
 * computing every slab against the original body and fusing (or cutting) the
 * union avoids the interference a sequential move creates at a shared
 * boundary, where an earlier move can leave a neighbour surface that no longer
 * crosses the next slab.
 */
export function combineMoveFaceCells(
  oc: OccModule,
  scope: DisposeScope,
  body: OccShape,
  steps: MoveFaceStep[],
  d: number,
): ApplyMoveFaceSetResult {
  const compound = scope.track(new oc.TopoDS_Compound())
  const builder = scope.track(new oc.BRep_Builder())
  builder.MakeCompound(compound)
  for (const step of steps) for (const c of step.cells.cells) builder.Add(compound, c)
  const res = booleanWithDiff(oc, scope, body, compound, d > 0 ? 'fuse' : 'cut')
  return { shape: res.shape, faceOrigin: res.faceOrigin, diff: res.diff }
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
  const res = combineMoveFaceCells(oc, scope, body, [{ face, cells }], d)
  return { shape: res.shape, faceOrigin: res.faceOrigin, diff: res.diff, cells }
}

/** A face's outward normal + a point ON it, for the leaf's handle anchor. A
 *  planar face anchors at its centroid (the shipped behaviour); a curved one at
 *  its UV-domain midpoint (a full cylinder's centroid lies on its axis, where
 *  the normal is undefined). */
export function faceNormalAndCentroid(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): { normal: Vec3; centroid: Vec3 } {
  const anchor = movedSurface(oc, scope, face, 0).anchor()
  return { normal: anchor.normal, centroid: anchor.point }
}
