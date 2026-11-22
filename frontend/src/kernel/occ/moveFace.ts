// Move-face, OCC only (no construction naming): move a B-rep face along its
// outward normal by a signed distance, extending the faces that bound it.
//
// Construction (every volume pinned by occ/__tests__/moveFaceReal.test.ts and
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
import { canonicalFaces, canonicalEdges } from './partNames'
import { SubShapeMap } from './subshapeIdentity'
import { faceCentroid, faceArea, bboxDiagonal, shapeBndBox } from './primitives'
import { volumeForMeasure } from './volume'
import { noProgress } from './defaultArgs'
import { booleanWithDiff, type FaceOrigin } from './booleans'
import type { BrepDiff } from '../types3d'
import type { EdgeKind } from '@/types/cad'
import { TOL_MOVE_FACE_TANGENT, TOL_SURFACE_IDENTITY } from '../solverConstants'
import type { Vec3 } from '@/utils/vec3'
import {
  extendedNeighbourSolid,
  MoveFaceRefusal,
  movedSurface,
  pointInFace,
  representativePoints,
  sameAnalyticSurface,
  type MovedSurface,
} from './moveFaceSurfaces'
import { extendNeighbour } from './moveFaceExtend'
import { RUNG_1, rungCatalog } from './moveFaceRungs'

export { MoveFaceRefusal } from './moveFaceSurfaces'

/** The edge convexity BRepOffset_Analyse reports, narrowed to the four the
 *  move-face rules care about. The union itself lives beside EdgeData in
 *  `types/cad.ts`, because the solve now publishes it on every edge too. */
export type { EdgeKind } from '@/types/cad'

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
  // A neighbour needed a non-analytic extension: a sphere/torus full face with
  // its solid, or the rung-2/rung-2b freeform patch or strip. The volume
  // oracle only runs for these moves: the analytic kinds' volumes are pinned
  // exactly, and a hole/boss loop can move volume the first-order oracle would
  // misjudge.
  usedFreeformExtension: boolean
}

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
 *  cone, sphere or torus carries one) so it has no neighbour to look across.
 *  BRepOffset_Analyse has only one face to read there and leaves the edge
 *  unclassified (the solve publishes that as `other`, not `tangent`). A
 *  degenerated edge (a sphere pole, a cone apex) is a point, not a boundary. */
function isSeamOrDegenerate(oc: OccModule, face: OccShape, edge: OccShape): boolean {
  if (oc.BRep_Tool.Degenerated?.(edge)) return true
  return oc.BRep_Tool.IsClosed_2(edge, face)
}

/**
 * A large bounded face on `face`'s underlying surface, spanning the slab. The
 * analytic kinds keep the shipped windows (plane/cylinder v in [-L, L], a cone
 * clipped at its apex); a freeform kind gets rung 2's widened patch (see
 * moveFaceExtend.ts), whose margin is `margin` (defaults to L for callers that
 * only want a big tool). Throws MoveFaceRefusal naming every rung.
 */
export function extendNeighbourFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  L: number,
  margin: number = L,
  edge?: OccShape,
  normal: Vec3 = [0, 0, 1],
  d: number = 0,
): OccShape {
  if (edge === undefined) {
    // A caller that only wants a large tool gets rung 1, or rung 2's patch when
    // it is valid; without the shared edge and the move there is no strip.
    return extendNeighbour(oc, scope, face, null, normal, 0, L, margin).face
  }
  return extendNeighbour(oc, scope, face, edge, normal, d, L, margin).face
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
  part: OccShape,
): (edge: OccShape) => EdgeKind {
  const analyse = scope.track(new oc.BRepOffset_Analyse_2(part, TOL_MOVE_FACE_TANGENT))
  const names: Record<number, EdgeKind> = {
    [oc.ChFiDS_TypeOfConcavity.ChFiDS_Convex.value]: 'convex',
    [oc.ChFiDS_TypeOfConcavity.ChFiDS_Concave.value]: 'concave',
    [oc.ChFiDS_TypeOfConcavity.ChFiDS_Tangential.value]: 'tangent',
    [oc.ChFiDS_TypeOfConcavity.ChFiDS_Other.value]: 'other',
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
  part: OccShape,
  face: OccShape,
  edge: OccShape,
): OccShape | null {
  for (const other of exploreFaces(oc, scope, part)) {
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
  splitter.Build(noProgress(oc))
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
    if (pointInFace(oc, scope, toolFaces[i], p, TOL_SURFACE_IDENTITY)) return i
  }
  return -1
}

/** The retry ladder for a refused split: each replacement tool alone, then
 *  the whole set, then refuse. A fixed budget on purpose: trying every subset
 *  would be 2^n - 1 full splitters, 1023 for ten bores, each able to hang. */
export function replacementLadders(usable: number[]): number[][] {
  const singles = usable.map((index) => [index])
  return usable.length > 1 ? [...singles, usable] : singles
}

export interface SplitAttempt {
  picked: OccShape[]
  refusal: string | null
}

/** Run the replacement ladder, stopping at the first split that selects a
 *  cell. A refused ladder returns a named refusal carrying the budget and the
 *  last reason, so a red chip says why instead of only "no cell". */
export function retryReplacementSplits(
  usable: number[],
  trySplit: (subset: number[]) => SplitAttempt,
): SplitAttempt & { attempts: number } {
  let last: SplitAttempt = { picked: [], refusal: null }
  let attempts = 0
  for (const subset of replacementLadders(usable)) {
    attempts++
    last = trySplit(subset)
    if (last.refusal === null) return { ...last, attempts }
  }
  if (attempts === 0) return { picked: [], refusal: last.refusal, attempts }
  const ladder = usable.length > 1 ? '(each tool alone, then the whole set)' : '(the only usable tool)'
  return {
    picked: [],
    refusal:
      `move_face: no replacement bounded the picked face after ${attempts} split(s) ${ladder}: ` +
      `${last.refusal ?? 'no cell was selected'}`,
    attempts,
  }
}

/**
 * Build and select the cells for moving `face` by signed `d`. Throws
 * MoveFaceRefusal for every guard: an unsupported or tangent-bounded face, an
 * unsupported neighbour surface, an unbounded cell, a failed split or no cell.
 */
export function moveFaceCells(
  oc: OccModule,
  scope: DisposeScope,
  part: OccShape,
  face: OccShape,
  d: number,
): MoveFaceCells {
  const surface = movedSurface(oc, scope, face, d)
  // The rung-2b strip follows this normal. It is the picked face's outward
  // normal at its anchor, exact for a plane; a curved picked face's strip is a
  // first-order approximation at that one normal and the volume oracle only
  // validates a planar picked face.
  const moveNormal = surface.anchor().normal

  const bboxL = bboxDiagonal(oc, scope, part)
  const L = 4 * (bboxL + Math.abs(d))

  const edgeKind = classifyFaceEdges(oc, scope, part)
  const edges = exploreEdges(oc, scope, face)

  // Extended neighbour per edge; a tangent-bound face is refused (an extension
  // of a surface tangent to S only crosses the slab on one side and produces a
  // kink rather than a blend, so the whole rung ladder is named in the
  // refusal). The face's own seam and point-like (degenerated) edges are
  // skipped. A freeform patch is only widened past the face by the slab
  // margin: short continuations are where polynomial extension stays faithful.
  const toolFaces: OccShape[] = []
  // What actually goes to the splitter. A closed sphere/torus face cannot
  // partition a slab, so its solid stands in; the mapping face above still
  // names the cell's piece of that surface.
  const splitTools: OccShape[] = []
  const toolNeighbour: OccShape[] = []
  const solidTools: (OccShape | null)[] = []
  const margin = Math.max(3 * Math.abs(d), 1e-3)
  let usedFreeformExtension = false
  // A full curved splitter FACE is a closed shell with no free boundary and
  // does not partition the slab, so a cell can span a sibling the user did not
  // pick. Keep the shipped face tools by default and offer a solid replacement
  // only for a neighbour cylinder that lies inside the picked surface's radius
  // (the bore that fails to cut); a solid on a same-radius or larger neighbour
  // feeds UnifySameDomain an invalid weld. A closed sphere/torus neighbour
  // always carries its own solid replacement for the same reason.
  const sourceRadius =
    surface.kind === 'cylinder'
      ? scope.track(scope.track(new oc.BRepAdaptor_Surface_2(face, true)).Cylinder()).Radius()
      : null
  for (const e of edges) {
    if (isSeamOrDegenerate(oc, face, e)) continue
    const kind = edgeKind(e)
    if (kind === 'tangent') {
      throw new MoveFaceRefusal(
        `move_face: the picked face has a tangent neighbour (a fillet?); moving it alone leaves a tangent split. ` +
        `Rungs: ${rungCatalog(oc)}. Move the tangent chain together or remove the fillet first`,
      )
    }
    const neighbour = neighbourAcross(oc, scope, part, face, e)
    if (neighbour === null) continue
    const tool = extendNeighbour(oc, scope, neighbour, e, moveNormal, d, L, margin)
    if (tool.rung !== RUNG_1 || tool.solid !== null) usedFreeformExtension = true
    toolFaces.push(tool.face)
    // A closed sphere/torus face is no splitter; its solid is the tool.
    splitTools.push(tool.solid ?? tool.face)
    toolNeighbour.push(neighbour)
    let solid: OccShape | null = null
    if (tool.solid === null && sourceRadius !== null) {
      const nad = scope.track(new oc.BRepAdaptor_Surface_2(neighbour, true))
      if (nad.GetType().value === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) {
        const radius = scope.track(nad.Cylinder()).Radius()
        if (radius < sourceRadius - TOL_SURFACE_IDENTITY) solid = extendedNeighbourSolid(oc, scope, neighbour, L)
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
      // A freeform extension can leave a cell merged with material the picked
      // face does not cover (the ruled strip closes the slab on one side but
      // the cell may wrap around its free end). Every on-source point of a cell
      // claimed for a freeform move must therefore classify inside the picked
      // region, the same all-points rule the curved kinds use; the shipped
      // planar path keeps its wall-only guard so its pinned volumes do not move.
      if (usedFreeformExtension) {
        for (const sf of sourceFaces) {
          for (const p of representativePoints(oc, scope, sf)) {
            if (surface.inRegion(outerRegion, p)) continue
            if (inner.some((loop) => surface.inRegion(loop.face, p))) continue
            return {
              picked: [],
              refusal:
                'move_face: a selected cell reaches outside the picked face; ' +
                'the freeform extension did not bound the cell to the moved region',
            }
          }
        }
      }
      picked.push(cell)
    }
    if (picked.length === 0) {
      return { picked: [], refusal: 'move_face: no cell of the moved face could be selected' }
    }
    return { picked, refusal: null }
  }

  let result = trySplit(splitTools)
  if (result.refusal !== null) {
    // Re-split with one or more neighbour tools replaced by a solid on the same
    // surface. A single failing tool must not drag every lateral face into the
    // coincident-face merge that can spin on a pair of solid cuts, so each
    // replacement is tried alone first, then the whole set. Trying every
    // subset would be 2^n - 1 full splitters (1023 for ten bores), each able
    // to hang.
    const usable = solidTools
      .map((solid, index) => (solid === null ? -1 : index))
      .filter((index) => index >= 0)
    const retry = retryReplacementSplits(usable, (subset) => {
      const tools = splitTools.map((f, index) =>
        subset.includes(index) ? solidTools[index] ?? f : f,
      )
      return trySplit(tools)
    })
    // No usable tool (an empty ladder) leaves the original refusal in place.
    if (retry.attempts > 0) result = { picked: retry.picked, refusal: retry.refusal }
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

  return { cells: picked, capFaces, extensionOf, usedFreeformExtension }
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
 * The pick index pairs whose faces share an edge. The set path applies every
 * slab in one boolean, and each slab is bounded by its picked face's
 * neighbours on their ORIGINAL surfaces: for two picks that share an edge,
 * neither slab covers the strip beyond that edge, so the fused result notches
 * at every shared edge and corner. The leaf uses the pairs to refuse those
 * picks by name instead of shipping that geometry.
 */
export function adjacentMoveFacePicks(
  oc: OccModule,
  scope: DisposeScope,
  faces: OccShape[],
): [number, number][] {
  const edges = faces.map((face) => exploreEdges(oc, scope, face))
  const out: [number, number][] = []
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const shares = edges[i].some((a) => edges[j].some((b) => (a as OccSubShape).IsSame(b as OccSubShape)))
      if (shares) out.push([i, j])
    }
  }
  return out
}

/**
 * Apply cells that were all selected on the SAME body shape in one boolean.
 * Moving several faces together is a function of the picked set, not its order:
 * computing every slab against the original body and fusing (or cutting) the
 * union avoids the interference a sequential move creates at a shared
 * boundary, where an earlier move can leave a neighbour surface that no longer
 * crosses the next slab. The leaf refuses a set whose picks share an edge
 * before calling this (see `adjacentMoveFacePicks`): two slabs bounded by each
 * other's original neighbours leave the strip beyond the shared edge unfilled.
 *
 * The tool is ordered canonically (by each cell's lower bbox corner, then its
 * upper one) before the
 * compound is filled. OCCT 8's fuse is order-sensitive when the cells overlap
 * each other: the same four-face set built in reverse came back with a
 * different face count and a 3.75 mm wider body, where 7.4 did not. The set is
 * unordered, so the tool must be too; the sort makes the result a function of
 * the picks alone.
 */
export function combineMoveFaceCells(
  oc: OccModule,
  scope: DisposeScope,
  part: OccShape,
  steps: MoveFaceStep[],
  d: number,
): ApplyMoveFaceSetResult {
  const cells = steps.flatMap((step) => step.cells.cells)
  const keyed = cells.map((cell) => {
    const box = shapeBndBox(oc, scope, cell)
    return { cell, min: box.min, max: box.max }
  })
  keyed.sort((a, b) =>
    a.min[0] - b.min[0] || a.min[1] - b.min[1] || a.min[2] - b.min[2]
    || a.max[0] - b.max[0] || a.max[1] - b.max[1] || a.max[2] - b.max[2])
  const compound = scope.track(new oc.TopoDS_Compound())
  const builder = scope.track(new oc.BRep_Builder())
  builder.MakeCompound(compound)
  for (const { cell } of keyed) builder.Add(compound, cell)
  const res = booleanWithDiff(oc, scope, part, compound, d > 0 ? 'fuse' : 'cut')
  return { shape: res.shape, faceOrigin: res.faceOrigin, diff: res.diff }
}

/**
 * The first-order volume oracle for a move that used a non-analytic neighbour
 * extension. Moving a planar face by d sweeps its own region, so the body's
 * volume changes by `area * d` to first order; the curvature/freeform
 * neighbours only add an O(d^2) wedge at the boundary. A cell selection that
 * missed or double-counted a sibling region breaks that estimate immediately,
 * which is why a widened patch is not trusted without it.
 *
 * It runs only for the extension rungs (see `usedFreeformExtension`): the
 * analytic kinds are pinned by exact volumes, and a hole/boss loop moving with
 * the face changes volume in a way the first-order estimate does not model.
 */
function assertVolumeOracle(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  before: number,
  after: number,
): void {
  const S = oc.GeomAbs_SurfaceType
  const type = scope.track(new oc.BRepAdaptor_Surface_2(face, true)).GetType().value
  if (type !== S.GeomAbs_Plane.value) return
  const area = faceArea(oc, scope, face)
  const want = area * d
  const got = after - before
  const slack = 0.05 * Math.abs(want)
  if (Math.abs(got - want) > slack) {
    throw new MoveFaceRefusal(
      `move_face: the move changed the volume by ${got.toFixed(3)} mm3, not the first-order ` +
      `${want.toFixed(3)} (area ${area.toFixed(3)} x d ${d}); refused rather than shipping a wrong solid`,
    )
  }
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
  part: OccShape,
  face: OccShape,
  d: number,
): ApplyMoveFaceResult {
  const cells = moveFaceCells(oc, scope, part, face, d)
  const before = cells.usedFreeformExtension ? volumeForMeasure(oc, scope, part) : 0
  const res = combineMoveFaceCells(oc, scope, part, [{ face, cells }], d)
  if (cells.usedFreeformExtension) {
    assertVolumeOracle(oc, scope, face, d, before, volumeForMeasure(oc, scope, res.shape))
  }
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
