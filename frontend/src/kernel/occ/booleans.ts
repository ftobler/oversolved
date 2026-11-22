/**
 * This is the BrepDiff producer the boolean name transfer consumes: it classifies each output
 * sub-shape as inherited (target lineage survives) or new (introduced by the tool), so ancestry
 * registration tags new faces with the cutting feature rather than the body's creator.
 *
 * Binding quirks pinned here (probed against the real build): - history.Modified()
 * returns a TopTools_ListOfShape with no iterator binding; drain via
 * Size()/First_1()/RemoveFirst() (the same sharp edge as the lineage drain). -
 * TopTools_IndexedDataMapOfShapeListOfShape / TopExp.MapShapesAndAncestors's map type are
 * absent, so any edge->face adjacency (e.g. deriveEdgeNames) is built face-by-face, not via the
 * indexed map.
 *
 * Like primitives.ts, every function takes a DisposeScope and tracks its transients there. The
 * returned result shape is NOT tracked (the caller owns its lifetime); the BrepDiff's sub-shape
 * handles are tracked in the passed scope and are valid only while that scope is alive -- the
 * builder keeps the scope open across the lineage transfer that reads them.
 */

import { drainList, DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import { canonicalizeCylinderFaces } from './canonicalSurfaces'
import { SubShapeDedup, SubShapeIndexMap, SubShapeMultiIndex, shapeBndBox } from './primitives'
import { volumeOf, volumeOfDefault } from './volume'
import { foldCavitySolids } from './cavities'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import type { FaceOrigin } from './cleanup/types'
import {
  explore,
  mapDiffThroughRebase,
  mapOriginThroughRebase,
} from './cleanup/compose'
import { isClosedByVolume, shapeIsValid } from './cleanup/guard'
import { runCleanup } from './cleanup/pipeline'
import { booleanPlan } from './cleanup/presets'
import { swallowUnlessTrap } from '../errors'
import { OCC_CONFUSION } from '../solverConstants'
import { mergeTolerance, type KernelPrecision, type MergeTolerance } from '../precision'
import { markFeatureProgress } from '../featureProgress'
import { noProgress } from './defaultArgs'

// The clean lives in the cleanup layer now; the boolean, prism and test paths
// keep importing it from here.
export { cleanWithHistory, type CleanTolerances } from './cleanup/unifySameDomain'
export { composeDiffThroughClean, composeOriginThroughClean } from './cleanup/compose'
export { shapeIsValid } from './cleanup/guard'
export type { FaceOrigin } from './cleanup/types'

// Re-exported for the callers that read a body's volume.
export { volumeOf }

export type BooleanOp = 'cut' | 'fuse' | 'common'

/** Solids of a shape, cast to TopoDS_Solid (mirrors ocp_explore_solids). */
export function exploreSolids(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_SOLID, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    out.push(scope.track(oc.TopoDS.Solid_1(raw)))
  }
  return out
}

/** Count sub-shapes of the given enum kind (TopExp walk, no dedup). */
export function countSubShapes(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  kind: object,
): number {
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, kind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  let count = 0
  for (; exp.More(); exp.Next()) count++
  return count
}

/** Number of solid sub-shapes (mirrors ocp_count_solids). */
export function countSolids(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  return countSubShapes(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID)
}

/**
 * Do these two shapes share any material? A bare Common with history off: the
 * probe's only output is a boolean, so nothing downstream of the algorithm --
 * history classification, cylinder canonicalisation, the unify pass, the diff
 * and origin composition -- is worth paying for (M18). Its own DisposeScope is
 * disposed in a finally, so no probe proxy reaches the caller's build scope.
 *
 * The verdict is a solid count, not a volume: an intersection whose shell is
 * not closed integrates to zero mass under volumeOf's OnlyClosed=true and
 * would read as disjoint while being a plain overlap (L5). The narrow face
 * fallback (neither operand is a solid) exists so a shell-only imported body
 * still probes true on a face Common; two solids that merely touch face-to-face
 * are correctly answered false.
 *
 * Returns TRUE when the probe itself fails. A failed probe is not evidence of
 * disjointness; skipping on a throw reported "does not intersect" for cuts the
 * real cut would have performed. `features/bodyOpsProbeFallback.test.ts` pins
 * all three outcomes.
 *
 * The intended next step this deliberately skips is an AABB (Bnd_Box) prefilter
 * ahead of the Common: it introduces a second tolerance story, and a false
 * negative there silently skips a cut -- the exact user-visible failure L5 is
 * fixing. It belongs in its own change with its own real-OCC tolerance fixtures.
 */
export function shapesIntersect(oc: OccModule, target: OccShape, tool: OccShape): boolean {
  const s = new DisposeScope()
  try {
    const algo = s.track(new oc.BRepAlgoAPI_Common_1())
    const args = s.track(new oc.TopTools_ListOfShape_1())
    args.Append_1(target)
    const tools = s.track(new oc.TopTools_ListOfShape_1())
    tools.Append_1(tool)
    algo.SetArguments(args)
    algo.SetTools(tools)
    algo.SetToFillHistory(false)
    algo.Build(noProgress(oc))
    // A failed build leaves no Common shape to read; not evidence of
    // disjointness, so report intersect and let the real cut decide.
    if (!algo.IsDone()) return true
    const inter = s.track(algo.Shape())
    // A solid count, not a volume. An intersection whose shell is not closed
    // integrates to zero mass under volumeOf's OnlyClosed=true and would read as
    // disjoint while being a plain overlap (L5). This also drops the
    // unit-dependent absolute 1e-10 threshold from the decision.
    if (countSolids(oc, s, inter) > 0) return true
    // Face fallback ONLY when neither operand is a solid at all -- a shell-only
    // imported body, whose Common can never produce a solid. Two solids that
    // merely touch face-to-face produce a face-only Common today and are
    // correctly SKIPPED; widening the fallback to them would start running
    // degenerate cuts and move fixtures for a case L5 is not about.
    if (countSolids(oc, s, target) === 0 && countSolids(oc, s, tool) === 0) {
      return countSubShapes(oc, s, inter, oc.TopAbs_ShapeEnum.TopAbs_FACE) > 0
    }
    return false
  } catch (e) {
    swallowUnlessTrap(e)
    // A failed probe is not evidence of disjointness: report intersect so the
    // caller runs the real cut and its own failure surfaces instead.
    return true
  } finally {
    s.dispose()
  }
}

/**
 * Do these two shapes touch, a shared face counting as a touch?
 *
 * This is the companion probe to `shapesIntersect`, not a replacement. It reads
 * the minimum distance between the two boundaries: two solids that share a face
 * answer 0, which the Common cannot see (a face-only Common has no solid). In
 * this build DistShapeShape also answers 0 for a body fully inside the other
 * (`InnerSolution`), so the distance probe happens to cover the Common's
 * overlap and containment answers too; the caller still reads both, because
 * the Common is the authoritative overlap answer and the distance probe falls
 * back to it when it cannot run.
 *
 * A probe that cannot run falls back to `shapesIntersect`, the same rule the
 * Common follows: a failed probe is not evidence of disjointness, and the
 * distance builder reporting `IsDone() == false` is a failure, not a gap.
 * Its own DisposeScope is disposed in a finally, so no probe proxy reaches the
 * caller's build scope.
 */
export function shapesTouch(oc: OccModule, target: OccShape, tool: OccShape): boolean {
  const s = new DisposeScope()
  try {
    // The deflection form: OCC_CONFUSION is the deflection this probe has
    // always run with, MIN asks for the minimum distance rather than the
    // farthest pair, and Grad and the null progress are OCCT's defaults.
    const probe = s.track(new oc.BRepExtrema_DistShapeShape_3(
      target,
      tool,
      OCC_CONFUSION,
      oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
      oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
      noProgress(oc),
    ))
    if (!probe.IsDone()) return shapesIntersect(oc, target, tool)
    return probe.Value() <= OCC_CONFUSION
  } catch (e) {
    swallowUnlessTrap(e)
    return shapesIntersect(oc, target, tool)
  } finally {
    s.dispose()
  }
}

function makeBooleanOp(oc: OccModule, op: BooleanOp) {
  switch (op) {
    case 'cut':
      return new oc.BRepAlgoAPI_Cut_1()
    case 'fuse':
      return new oc.BRepAlgoAPI_Fuse_1()
    case 'common':
      return new oc.BRepAlgoAPI_Common_1()
  }
}

/**
 * Run a BRepAlgoAPI_* boolean and classify the output (mirrors
 * `ocp_boolean_with_history`). Returns the RAW result shape (no clean) and a
 * BrepDiff whose handles reference sub-shapes of the inputs and result.
 */
export function booleanWithHistory(
  oc: OccModule,
  scope: DisposeScope,
  targetShape: OccShape,
  toolShape: OccShape,
  op: BooleanOp,
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  return booleanWithHistoryMany(oc, scope, targetShape, [toolShape], op)
}

/**
 * The multi-operand boolean: every shape in `toolShapes` is a separate tool in
 * the same BRepAlgoAPI call, so one history reports each operand's modified
 * faces separately. A pattern or array batches its copies here instead of
 * growing the target once per copy.
 */
export function booleanWithHistoryMany(
  oc: OccModule,
  scope: DisposeScope,
  targetShape: OccShape,
  toolShapes: readonly OccShape[],
  op: BooleanOp,
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  const E = oc.TopAbs_ShapeEnum
  const algo = scope.track(makeBooleanOp(oc, op))

  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(targetShape)
  const tools = scope.track(new oc.TopTools_ListOfShape_1())
  for (const toolShape of toolShapes) tools.Append_1(toolShape)
  algo.SetArguments(args)
  algo.SetTools(tools)
  algo.SetToFillHistory(true)
  algo.Build(noProgress(oc))
  if (!algo.IsDone()) throw new Error(`boolean ${op} did not complete`)

  // Track the result until it is handed to the caller: on any throw during
  // classification the scope deletes it, and on success the detach below leaves
  // ownership with the caller exactly as before.
  const result = scope.track(algo.Shape())
  const diff = emptyBrepDiff()
  if (!algo.HasHistory()) {
    scope.detach(result)
    return { shape: result, diff, faceOrigin: [] }
  }
  const history = scope.track(algo.History()).get()

  // Six walks, one per (shape, kind), instead of ten: today the target/tool
  // faces are walked twice each (classify/record + collectPairs) and the
  // result's faces three times (walkOutputs + collectPairs' unchanged branch +
  // the origin loop) (M19). All six pools are shared by the closures below.
  const targetFaces = explore(oc, scope, targetShape, E.TopAbs_FACE)
  const targetEdges = explore(oc, scope, targetShape, E.TopAbs_EDGE)
  const toolFaces: OccSubShape[] = []
  const toolEdges: OccSubShape[] = []
  for (const toolShape of toolShapes) {
    toolFaces.push(...explore(oc, scope, toolShape, E.TopAbs_FACE))
    toolEdges.push(...explore(oc, scope, toolShape, E.TopAbs_EDGE))
  }
  const resultFaces = explore(oc, scope, result, E.TopAbs_FACE)
  const resultEdges = explore(oc, scope, result, E.TopAbs_EDGE)

  // Classify target sub-shapes: build the pool of output preimages reachable
  // from surviving target inputs (these inherit the target body's lineage).
  const classifyTarget = (
    subShapes: OccSubShape[],
  ): { modified: OccSubShape[]; deleted: OccSubShape[]; preimages: OccSubShape[] } => {
    const modified: OccSubShape[] = []
    const deleted: OccSubShape[] = []
    const preimages: OccSubShape[] = []
    for (const s of subShapes) {
      if (history.IsRemoved(s)) {
        deleted.push(s)
      } else {
        const mods = drainList(scope, history.Modified(s)) as OccSubShape[]
        if (mods.length > 0) {
          modified.push(s)
          preimages.push(...mods)
        } else {
          preimages.push(s)
        }
      }
    }
    return { modified, deleted, preimages }
  }

  // Tool tracking is informational: just record modified/deleted tool inputs.
  const recordTool = (subShapes: OccSubShape[]): { modified: OccSubShape[]; deleted: OccSubShape[] } => {
    const modified: OccSubShape[] = []
    const deleted: OccSubShape[] = []
    for (const s of subShapes) {
      if (history.IsRemoved(s)) {
        deleted.push(s)
      } else if (scope.track(history.Modified(s)).Size() > 0) {
        modified.push(s)
      }
    }
    return { modified, deleted }
  }

  // Walk the output: IsSame against the inherited pool -> inherited, else new.
  // The pool is pre-seeded into a SubShapeDedup read as a membership set via
  // `has` (NOT `add`: add would register each query and reclassify the second
  // explorer occurrence of a shared new edge as inherited).
  const walkOutputs = (
    subShapes: OccSubShape[],
    inheritedPool: OccSubShape[],
  ): { newList: OccSubShape[]; inheritedList: OccSubShape[] } => {
    const newList: OccSubShape[] = []
    const inheritedList: OccSubShape[] = []
    const pool = new SubShapeDedup()
    for (const p of inheritedPool) pool.add(p)
    for (const s of subShapes) {
      if (pool.has(s)) inheritedList.push(s)
      else newList.push(s)
    }
    return { newList, inheritedList }
  }

  const tF = classifyTarget(targetFaces)
  const tE = classifyTarget(targetEdges)
  const uF = recordTool(toolFaces)
  const uE = recordTool(toolEdges)

  diff.modified_input_faces = [...tF.modified, ...uF.modified]
  diff.deleted_input_faces = [...tF.deleted, ...uF.deleted]
  diff.modified_input_edges = [...tE.modified, ...uE.modified]
  diff.deleted_input_edges = [...tE.deleted, ...uE.deleted]

  const oF = walkOutputs(resultFaces, tF.preimages)
  const oE = walkOutputs(resultEdges, tE.preimages)
  diff.new_faces = oF.newList
  diff.inherited_faces = oF.inheritedList
  diff.new_edges = oE.newList
  diff.inherited_edges = oE.inheritedList

  // Per-output-face origin: which input face (target or tool) each output face
  // derived from, by Modified()/IsSame subshape identity. A source that maps to
  // several images is a genuine split; the name transfer orders those children.
  const facePairs: FaceOrigin[] = []
  // Both key spaces are result-face identities matched with IsSame, so the
  // per-input find and the per-result filter collapse to hash lookups instead
  // of O(n^2) boundary crossings (M19).
  const resultFaceIdx = new SubShapeIndexMap()
  resultFaces.forEach((f, i) => resultFaceIdx.set(f, i))
  const pairsByOutput = new SubShapeMultiIndex<FaceOrigin>()
  const collectPairs = (subShapes: OccSubShape[], fromTool: boolean): void => {
    for (const s of subShapes) {
      if (history.IsRemoved(s)) continue
      const mods = drainList(scope, history.Modified(s)) as OccSubShape[]
      if (mods.length > 0) {
        for (const m of mods) {
          const p: FaceOrigin = { output: m, source: s, fromTool }
          facePairs.push(p)
          pairsByOutput.add(m, p)
        }
        continue
      }
      // Unchanged face: the input handle does NOT live in the result, so find
      // the result face that is IsSame to it. Without this, faces untouched by
      // the boolean get no origin entry and lose their construction UUID.
      const at = resultFaceIdx.get(s)
      if (at >= 0) {
        const p: FaceOrigin = { output: resultFaces[at], source: s, fromTool }
        facePairs.push(p)
        pairsByOutput.add(resultFaces[at], p)
      }
    }
  }
  collectPairs(targetFaces, false)
  collectPairs(toolFaces, true)
  const faceOrigin: FaceOrigin[] = []
  for (const of of resultFaces) {
    // SubShapeMultiIndex.get is insertion-ordered and collectPairs runs the
    // target first, so target-before-tool survives the index and the
    // find(!fromTool) ?? matches[0] tie-break picks the source the filter did.
    const matches = pairsByOutput.get(of)
    const chosen = matches.find((p) => !p.fromTool) ?? matches[0]
    if (chosen) faceOrigin.push({ output: of, source: chosen.source, fromTool: chosen.fromTool })
  }

  scope.detach(result)
  return { shape: result, diff, faceOrigin }
}

/**
 * Split `targetShape` by face or solid tools (BRepAlgoAPI_Splitter) and carry
 * the target's face lineage across the split. A splitter has no boolean
 * classification: every output face either `Modified` from one target face or
 * is that face unchanged, so the origin table is one pass over the target's
 * faces. Tool-face lineage is deliberately not collected: an up-to trim keeps
 * the target's names and names the new cut boundary off its neighbours.
 *
 * The result is UNTRACKED (the caller owns it), exactly like booleanWithHistory;
 * the origin handles are tracked in `scope`.
 */
export function splitWithHistory(
  oc: OccModule,
  scope: DisposeScope,
  targetShape: OccShape,
  toolShapes: readonly OccShape[],
): { shape: OccShape; faceOrigin: FaceOrigin[] } {
  const E = oc.TopAbs_ShapeEnum
  const splitter = scope.track(new oc.BRepAlgoAPI_Splitter_1())
  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(targetShape)
  const tools = scope.track(new oc.TopTools_ListOfShape_1())
  for (const toolShape of toolShapes) tools.Append_1(toolShape)
  splitter.SetArguments(args)
  splitter.SetTools(tools)
  splitter.SetToFillHistory(true)
  splitter.Build(noProgress(oc))
  if (!splitter.IsDone()) throw new Error('split did not complete')
  const result = scope.track(splitter.Shape())
  if (!splitter.HasHistory()) {
    scope.detach(result)
    return { shape: result, faceOrigin: [] }
  }
  const history = scope.track(splitter.History()).get()
  const targetFaces = explore(oc, scope, targetShape, E.TopAbs_FACE)
  const resultFaces = explore(oc, scope, result, E.TopAbs_FACE)
  const pairsByOutput = new SubShapeMultiIndex<FaceOrigin>()
  for (const source of targetFaces) {
    const mods = history.IsRemoved(source) ? [] : (drainList(scope, history.Modified(source)) as OccSubShape[])
    if (mods.length > 0) {
      for (const output of mods) pairsByOutput.add(output, { output, source, fromTool: false })
      continue
    }
    // An untouched face keeps its identity, but the input handle is not a
    // sub-shape of the result; find the result face that is IsSame to it.
    const output = resultFaces.find((f) => f.IsSame(source))
    if (output !== undefined) pairsByOutput.add(output, { output, source, fromTool: false })
  }
  const faceOrigin: FaceOrigin[] = []
  for (const output of resultFaces) {
    const origin = pairsByOutput.get(output)[0]
    if (origin !== undefined) faceOrigin.push(origin)
  }
  scope.detach(result)
  return { shape: result, faceOrigin }
}

/** One boolean pipeline's options, shared by the single-tool and multi-tool
 *  forms. */
export interface BooleanOptions {
  // The face merge's gate (see `booleanWithDiffMany`).
  unifyFaces?: boolean
  // The inherited precision of the operands. The clean widens by it up to the
  // merge ceiling; a body carries what its producing sketches reported
  // (kernel/precision.ts). Absent reads as the contract.
  precision?: KernelPrecision | null
}

/** The raw boolean + cylinder canonicalization, shared by the adopt and fallback paths. */
function rawBooleanWithDiff(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tools: readonly OccShape[],
  op: BooleanOp,
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  const { shape: raw, diff: rawDiff, faceOrigin: rawOrigin } = booleanWithHistoryMany(oc, scope, target, tools, op)
  scope.track(raw)
  const canonical = canonicalizeCylinderFaces(oc, scope, raw)
  const preClean = canonical.shape
  if (canonical.changed) scope.track(preClean)
  const preDiff = canonical.changed ? mapDiffThroughRebase(rawDiff, canonical.rebase) : rawDiff
  const preOrigin = canonical.changed ? mapOriginThroughRebase(rawOrigin, canonical.rebase) : rawOrigin
  return { shape: preClean, diff: preDiff, faceOrigin: preOrigin }
}

/**
 * One full boolean pipeline's result. `validated` is the handle a passing
 * whole-shape BRepCheck named, or null when no check ran on this shape (a
 * rejected or throwing clean falls back to the raw rebuild, and a cavity fold
 * replaces the checked shape, both of which leave nothing to skip).
 */
interface BooleanAttempt {
  shape: OccShape
  diff: BrepDiff
  faceOrigin: FaceOrigin[]
  validated: OccShape | null
}

/** A boolean the kernel completed with a result that cannot be shipped. */
export class BooleanSoundnessError extends Error {}

/**
 * The refusal's advice when the failed tool's material covered part of a target
 * seam: the kernel rebuilt a face across the seam and lost it, so later
 * booleans over that body fail. Nudging radii or planes, the tangency advice,
 * does not help this family.
 */
export const BOOLEAN_SEAM_HINT =
  'The tool covers part of a periodic seam edge, and the kernel could not rebuild the face ' +
  'across it. Move the seam off the tool (rotate the body about its own axis) or cut the tool ' +
  'back from the seam, then rebuild.'

/** The refusal's advice for the exact-tangency family (no covered seam). */
export const BOOLEAN_TANGENCY_HINT =
  'The two shapes probably touch in an exact tangency the kernel cannot resolve; ' +
  'nudge one of them off the coincident radius or plane and rebuild.'

/**
 * Which advice a refusal carries. The seam hint is only right when the failed
 * tool actually covered part of a seam, not merely because the shapes carry one:
 * every cylinder, cone, revolve and torus has a seam, so "a seam exists" would
 * make the tangency advice unreachable in the very family it was written for (a
 * cylinder tangent to a face plane). `toolCoversSeam` is the measured answer.
 */
export function booleanRefusalHint(coveredSeam: boolean): string {
  return coveredSeam ? BOOLEAN_SEAM_HINT : BOOLEAN_TANGENCY_HINT
}

/**
 * Every distinct seam edge of `shape`.
 *
 * `BRep_Tool.IsClosed_2(edge, face)` is the same predicate move-face uses to
 * skip a curved face's own seam. A degenerated edge (a sphere pole, a cone
 * apex) is a point, not a boundary, so it is not a seam.
 */
function seamEdgesOf(oc: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccSubShape[] = []
  const dedup = new SubShapeDedup()
  const faces = explore(oc, scope, shape, E.TopAbs_FACE)
  for (const rawFace of faces) {
    const face = scope.track(oc.TopoDS.Face_1(rawFace))
    for (const rawEdge of explore(oc, scope, face, E.TopAbs_EDGE)) {
      const edge = scope.track(oc.TopoDS.Edge_1(rawEdge)) as OccSubShape
      if (oc.BRep_Tool.Degenerated?.(edge)) continue
      if (!oc.BRep_Tool.IsClosed_2(edge, face)) continue
      if (dedup.add(edge)) out.push(edge)
    }
  }
  return out
}

/** A bare Common, the probe shape: the pieces of the 1D seam `segment` that lie
 *  inside `tool`'s material. Only pieces with length count; a seam the tool
 *  merely grazes returns vertices. */
function seamPartsInsideTool(
  oc: OccModule,
  scope: DisposeScope,
  segment: OccShape,
  tool: OccShape,
): OccShape[] {
  const algo = scope.track(new oc.BRepAlgoAPI_Common_1())
  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(segment)
  const tools = scope.track(new oc.TopTools_ListOfShape_1())
  tools.Append_1(tool)
  algo.SetArguments(args)
  algo.SetTools(tools)
  algo.SetToFillHistory(false)
  algo.Build(noProgress(oc))
  if (!algo.IsDone()) return []
  const common = scope.track(algo.Shape())
  return explore(oc, scope, common, oc.TopAbs_ShapeEnum.TopAbs_EDGE)
    .map((edge) => scope.track(oc.TopoDS.Edge_1(edge)))
}

/**
 * Whether a fuse tool's material covers part of a target seam edge.
 *
 * A tool that swallows part of a seam makes the boolean rebuild the whole
 * periodic face. On this kernel (OCCT 8.0.1, `frontend/occ.pin.json`) that
 * rebuild can drop the covered seam from the face's boundary; the result
 * validates and its volume is exact, but every later boolean over that body
 * returns a BRepCheck-invalid freeform face (reproducer: a funnel revolved from
 * a fit spline with a rib centred on its seam; see
 * `bugreports/20261115_2016_boolean_fail.md`). The probe names that family in a
 * refusal and is read only after a boolean has already failed, so an ordinary
 * fuse pays nothing for it.
 *
 * The bounding-box test in front of the Common keeps a body with many seams (a
 * drilled plate carries one per hole) cheap: a seam whose box misses the tool
 * cannot be covered.
 */
function toolCoversSeam(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tool: OccShape,
): boolean {
  try {
    const seams = seamEdgesOf(oc, scope, target)
    if (seams.length === 0) return false
    const toolBox = shapeBndBox(oc, scope, tool)
    const slack = OCC_CONFUSION
    for (const seam of seams) {
      const box = shapeBndBox(oc, scope, seam)
      const apart =
        box.min[0] > toolBox.max[0] + slack || box.max[0] < toolBox.min[0] - slack ||
        box.min[1] > toolBox.max[1] + slack || box.max[1] < toolBox.min[1] - slack ||
        box.min[2] > toolBox.max[2] + slack || box.max[2] < toolBox.min[2] - slack
      if (apart) continue
      if (seamPartsInsideTool(oc, scope, seam, tool).length > 0) return true
    }
    return false
  } catch (e) {
    swallowUnlessTrap(e)
    return false
  }
}

/**
 * The last line of defence against a corrupt boolean: OCCT can report IsDone
 * with a shape that validates yet is geometrically impossible (seen on the 7.4
 * kernel; the guard stays for any kernel). The
 * robustness fuzz found two such families on exact surface tangencies. When a
 * cylinder's lateral surface touches a face plane exactly, the fuse comes back
 * as the target MINUS the tool (right magnitude, wrong sign: V=-768.25 where
 * 1750 was the floor), and when a sphere's centre lies exactly on a cylinder's
 * lateral surface while the bodies overlap (the cylinder axis tangent to the
 * sphere), the first boolean over the pair drops one operand and returns
 * it twice with one shell inverted (net volume 2.3e-13). Both ship as an ok
 * feature today, so the result has to be bounded before adoption: absolute
 * volumes, so an inverted solid is judged by its material rather than its
 * orientation, and the op's own material law (a union cannot be smaller than
 * either operand, a cut cannot grow, an intersection cannot exceed the smaller
 * one). Returns the problem description, or null when the result is sound.
 *
 * `alreadyValid` says the caller's adoption guard already ran the same analyzer
 * on this very handle, so the validity check is skipped. The volume bounds still
 * run every time: they are cheap next to BRepCheck and they are the guard the
 * fuzz found last.
 */
function booleanResultProblem(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tools: readonly OccShape[],
  op: BooleanOp,
  result: OccShape,
  alreadyValid = false,
): string | null {
  try {
    // Read the default rule first and pay the adaptive re-read only when the
    // verdict is borderline. The array-cut corpus (count 3) takes minutes
    // inside GK's first read on a shape whose volume is nowhere near a bound,
    // so an unconditional adaptive read is not affordable here. Ten times the
    // budget is the borderline band: outside it the default rule's read error
    // (about 2e-6 of the body on a BSPLINE-trimmed face, up to 2.8e-5 on a
    // BSPLINE surface) cannot change the verdict, and inside it the adaptive
    // read decides.
    const measureWith = (read: typeof volumeOfDefault) => {
      let vsum = 0
      let vmax = 0
      const vr = Math.abs(read(oc, scope, result))
      const vt = Math.abs(read(oc, scope, target))
      for (const tool of tools) {
        const v = Math.abs(read(oc, scope, tool))
        vsum += v
        vmax = Math.max(vmax, v)
      }
      return { vr, vt, vsum, vmax }
    }
    // A non-finite read would make every bound below NaN, i.e. every
    // comparison false: the guard must not adopt a result it cannot judge.
    // Run on both reads, because the adaptive re-read can be the non-finite one.
    const finiteProblem = (r: number, t: number, s: number): string | null => {
      if (!Number.isFinite(r)) return `the result volume is not finite (${r})`
      if (!Number.isFinite(t) || !Number.isFinite(s)) {
        return `an operand volume is not finite (target ${t}, tool ${s})`
      }
      return null
    }
    let { vr, vt, vsum, vmax } = measureWith(volumeOfDefault)
    const firstProblem = finiteProblem(vr, vt, vsum)
    if (firstProblem !== null) return firstProblem
    const tolFor = (targetVolume: number, toolSum: number) =>
      1e-6 * Math.max(targetVolume, toolSum, 1)
    const boundFor = (targetVolume: number, toolMax: number, toolSum: number) =>
      op === 'fuse' ? Math.max(targetVolume, toolMax) : op === 'common' ? Math.min(targetVolume, toolSum) : targetVolume
    const tol = tolFor(vt, vsum)
    const bound = boundFor(vt, vmax, vsum)
    const margin = op === 'fuse'
      ? Math.min(Math.abs(vr - bound), Math.abs(vr - (vt + vsum)))
      : Math.abs(vr - bound)
    if (margin <= 10 * tol) {
      ({ vr, vt, vsum, vmax } = measureWith(volumeOf))
      const retryProblem = finiteProblem(vr, vt, vsum)
      if (retryProblem !== null) return retryProblem
    }
    // As in cleanShapeIsSound: a closed target's result has to validate, an
    // open-shell target (L5) has no closedness contract to enforce.
    if (isClosedByVolume(vt) && !alreadyValid && !shapeIsValid(oc, scope, result)) {
      return 'the result is not a valid solid (BRepCheck_Analyzer)'
    }
    const tolFinal = tolFor(vt, vsum)
    // A fuse cannot be smaller than its target or than any single tool. The
    // tools' SUM is not a lower bound: batched copies may overlap each other,
    // so the union is regularly smaller than the operand sum. The sum is only
    // the upper bound (nothing can exceed the total material put in).
    const boundFinal = boundFor(vt, vmax, vsum)
    const relation = op === 'fuse' ? 'below' : 'above'
    if (op === 'fuse' ? vr < boundFinal - tolFinal : vr > boundFinal + tolFinal) {
      return `volume ${vr} is ${relation} the ${op} bound ${boundFinal}`
    }
    if (op === 'fuse' && vr > vt + vsum + tolFinal) {
      return `volume ${vr} exceeds the operand sum ${vt + vsum}`
    }
    return null
  } catch (e) {
    swallowUnlessTrap(e)
    // The same rule as cleanShapeIsSound: a guard that cannot run must not let
    // the shape it cannot check through.
    return `the soundness check could not run: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** `attempt` with any void OCC returned as a separate inside-out solid folded
 *  back into its enclosing solid (cavities.ts); the replaced shape joins the
 *  scope, since nobody else owns it. The fold rebuilds the solid, so whatever
 *  the adoption guard validated no longer describes this shape. */
function withFoldedCavities(
  oc: OccModule,
  scope: DisposeScope,
  attempt: BooleanAttempt,
): BooleanAttempt {
  const folded = foldCavitySolids(oc, scope, attempt.shape)
  if (folded === attempt.shape) return attempt
  if (!scope.isTracked(attempt.shape)) scope.track(attempt.shape)
  return { ...attempt, shape: folded, validated: null }
}

/**
 * One full boolean pipeline: raw boolean, then the BOOLEAN cleanup plan
 * (cylinder canonicalization, the merge).
 *
 * A rejected or throwing pass keeps the pre-clean result, but that handle may
 * have been mutated in place by the merge, so the fallback rebuilds it from the
 * untouched operands exactly as the old pipeline did. The rebuild is also the
 * only reuse of `rawBooleanWithDiff`; the adopt path lets the layer run the
 * cylinder pass.
 */
function composeBooleanAttempt(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tools: readonly OccShape[],
  op: BooleanOp,
  unifyFaces: boolean,
  tolerance: MergeTolerance,
): BooleanAttempt {
  const raw = booleanWithHistoryMany(oc, scope, target, tools, op)
  scope.track(raw.shape)
  // The raw boolean is the longest kernel call of the pipeline; a heartbeat
  // before the plan keeps its duration out of the next gap the host's stall
  // budget measures, and the layer marks between passes.
  markFeatureProgress()
  const cleaned = runCleanup(
    oc,
    scope,
    { shape: raw.shape, diff: raw.diff, faceOrigin: raw.faceOrigin },
    booleanPlan({ unifyFaces, tolerance: { linearTol: tolerance.linearTol, angularTol: tolerance.angularTol } }),
  )
  markFeatureProgress()
  if (cleaned.passes.some((p) => p.status === 'rejected')) {
    // The fallback cannot reuse the pre-clean shape: the merge works in place,
    // so a rejected or half-applied clean may have left it -- and the pre-clean
    // result is only safely readable from the untouched operands. Rebuild it.
    return { ...rawBooleanWithDiff(oc, scope, target, tools, op), validated: null }
  }
  // ShapeUpgrade_UnifySameDomain (the coplanar-face merge) can throw on a valid
  // boolean result whose coincident faces it cannot fold. The reproducer is an
  // extrude of a body face that has a hole, added back onto that same body: the
  // shared coincident face plus the hole's inner wall defeat the merge. The
  // layer reports that as a rejected pass, so the rebuild above covers it.
  if (cleaned.diff === undefined || cleaned.faceOrigin === undefined) {
    return { ...rawBooleanWithDiff(oc, scope, target, tools, op), validated: null }
  }
  return {
    shape: cleaned.shape,
    diff: cleaned.diff,
    faceOrigin: [...cleaned.faceOrigin],
    validated: cleaned.validated,
  }
}

/**
 * Which of `tools` contributed at least one output face, as indexes into
 * `tools`, read from the boolean's own face history.
 *
 * A cut tool that removes nothing contributes no face of its own to the result:
 * every output face at a position it would have cut comes from the target or
 * from another tool. That is the same question the per-copy Common probe
 * answers ("does this copy hit any material?"), without a boolean per copy. A
 * tool that only touches a target face without removing material also answers
 * false here, and so does the probe (shapesIntersect's docblock): touching is
 * not a hit.
 *
 * One case the probe and this classification can disagree on: a cut whose new
 * surface is entirely absorbed by an existing coplanar or coaxial face keeps
 * that face's TARGET name (`composeOriginThroughClean` prefers the target
 * source), so no tool face is reported. Such a copy still removed material and
 * would be named a miss here; the probe reported a hit. It needs a cut that
 * removes material without leaving a surface of its own.
 */
export function toolsThatShaped(
  oc: OccModule,
  scope: DisposeScope,
  tools: readonly OccShape[],
  faceOrigin: readonly FaceOrigin[],
): Set<number> {
  const E = oc.TopAbs_ShapeEnum
  const toolOfFace = new SubShapeIndexMap()
  tools.forEach((tool, index) => {
    for (const face of explore(oc, scope, tool, E.TopAbs_FACE)) toolOfFace.set(face, index)
  })
  const shaped = new Set<number>()
  for (const origin of faceOrigin) {
    if (!origin.fromTool) continue
    const index = toolOfFace.get(origin.source)
    if (index >= 0) shaped.add(index)
  }
  return shaped
}

/**
 * Boolean (cut|fuse|common) then clean, composing history through the clean step
 * (mirrors cadquery_ops `_boolean_with_diff`). Returns (cleaned shape, BrepDiff
 * in cleaned-shape handle space). The cleaned shape is NOT tracked; the diff's
 * cleaned sub-shape handles are tracked in `scope`.
 *
 * Between the boolean and the clean, non-analytic faces that lie on a true
 * cylinder (fillet strips, prisms of BSpline arcs) are rebuilt on shared
 * analytic cylinders so UnifySameDomain can fold coincident wall halves --
 * without this an add-extrude onto a filleted wall keeps a seam at the weld.
 */
export function booleanWithDiff(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tool: OccShape,
  op: BooleanOp,
  opts: BooleanOptions = {},
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  return booleanWithDiffMany(oc, scope, target, [tool], op, opts)
}

/**
 * The multi-tool form of `booleanWithDiff`: one boolean, one clean, one history
 * over the whole tool set. A pattern or array passes every copy here so the
 * target is not regrown and re-named once per copy.
 */
export function booleanWithDiffMany(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tools: readonly OccShape[],
  op: BooleanOp,
  opts: BooleanOptions = {},
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  // The face merge (UnifySameDomain's face fold) can spin forever, not throw, on
  // imported-STEP topology (the reproducer: extruding a holed face of an
  // imported body back onto itself, double_with_hole.step). The two cases are
  // geometrically indistinguishable from natively modelled ones, so the caller
  // decides by provenance and passes `unifyFaces: false` for imported targets;
  // the edge merge (always safe) still runs, at the cost of an extra seam face.
  const unifyFaces = opts.unifyFaces ?? true
  // One tolerance for the whole pipeline. The caller passes what the operands'
  // sketches reported; this clean widens by that much, never past the ceiling
  // (kernel/precision.ts). The retry reads the same pair: it is the same
  // geometry.
  const tolerance = mergeTolerance(opts.precision)
  const attempt = withFoldedCavities(
    oc, scope, composeBooleanAttempt(oc, scope, target, tools, op, unifyFaces, tolerance),
  )
  markFeatureProgress()
  // The adoption guard ran the analyzer on this exact handle, so the soundness
  // check must not run it a second time. A folded, rejected or raw-fallback
  // attempt carries no validated handle and pays the check itself.
  const problem = booleanResultProblem(
    oc, scope, target, tools, op, attempt.shape, attempt.validated === attempt.shape,
  )
  markFeatureProgress()
  if (problem === null) return { shape: attempt.shape, diff: attempt.diff, faceOrigin: attempt.faceOrigin }
  // A replaced attempt has no owner, so it joins the scope: the fallback result
  // composeBooleanAttempt returns may already be tracked, hence the check.
  if (!scope.isTracked(attempt.shape)) scope.track(attempt.shape)
  // The first boolean over a pair whose surfaces touch in an exact tangency can
  // take an OCCT branch (found on the 7.4 kernel) that drops or inverts an operand. A bare Common
  // over the same operands makes the kernel settle the shared geometry, and the
  // rerun of the pipeline then comes out sound (the identity fuzz pins the
  // sphere-touching-a-wall case this recovers). The probe is the same call the
  // cut path already runs through shapesIntersect (M18), and it is only paid
  // here, after a result already failed the check.
  for (const tool of tools) shapesIntersect(oc, target, tool)
  const retry = withFoldedCavities(
    oc, scope, composeBooleanAttempt(oc, scope, target, tools, op, unifyFaces, tolerance),
  )
  markFeatureProgress()
  const retryProblem = booleanResultProblem(
    oc, scope, target, tools, op, retry.shape, retry.validated === retry.shape,
  )
  markFeatureProgress()
  if (retryProblem === null) return { shape: retry.shape, diff: retry.diff, faceOrigin: retry.faceOrigin }
  if (!scope.isTracked(retry.shape)) scope.track(retry.shape)
  // Name the family from the failed operands, not from "a seam exists": every
  // cylinder, cone, revolve and torus carries one, so the seam advice would
  // swallow the tangency advice it must stand beside. Only paid on a refusal.
  const coveredSeam = tools.some((tool) => toolCoversSeam(oc, scope, target, tool))
  throw new BooleanSoundnessError(
    `boolean ${op}: the kernel returned an unsound result (${retryProblem}). ` +
    booleanRefusalHint(coveredSeam),
  )
}
