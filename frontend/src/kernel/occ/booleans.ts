/**
 * This is the BrepDiff producer the boolean name transfer consumes: it classifies each output
 * sub-shape as inherited (target lineage survives) or new (introduced by the tool), so ancestry
 * registration tags new faces with the cutting feature rather than the body's creator.
 *
 * opencascade.js@1.1.1 quirks pinned here (probed against the real build): - history.Modified()
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
import type { OccModule, OccShape, OccSubShape, OccHistory } from './occTypes'
import { canonicalizeCylinderFaces } from './canonicalSurfaces'
import { SubShapeDedup, SubShapeIndexMap, SubShapeMultiIndex } from './primitives'
import { volumeOf, volumeOfDefault } from './volume'
import { foldCavitySolids } from './cavities'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import { swallowUnlessTrap } from '../errors'
import { OCC_ANGULAR, OCC_CONFUSION } from '../solverConstants'
import { mergeTolerance, type KernelPrecision, type MergeTolerance } from '../precision'
import { markFeatureProgress } from '../featureProgress'

// Re-exported for the callers that read a body's volume.
export { volumeOf }

export type BooleanOp = 'cut' | 'fuse' | 'common'

/**
 * An output face paired with the input face it derived from (query-naming-by-
 * construction). This carries construction-UUID identity across a boolean by
 * OCC subshape history (Modified/IsSame), NOT by geometry: the name transfer
 * looks up the source face's UUID and carries it onto the output. A source that
 * maps to >1 output is a genuine split; the transfer orders those children.
 */
export interface FaceOrigin {
  output: OccSubShape
  source: OccSubShape
  fromTool: boolean
}

/** All sub-shapes of `shape` of the given enum kind, as IsSame-comparable handles. */
function explore(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  kind: object,
): OccSubShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, kind, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(exp.Current()) as OccSubShape)
  return out
}

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
    algo.Build()
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
    // The 4-arg ctor: the deflection is mandatory in this build (there is no
    // 2-arg form), and MIN asks for the minimum distance rather than the
    // farthest pair.
    const probe = s.track(new oc.BRepExtrema_DistShapeShape_2(
      target,
      tool,
      OCC_CONFUSION,
      oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
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
  algo.Build()
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
  splitter.Build()
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

/**
 * ShapeUpgrade_UnifySameDomain (cadquery Shape.clean) with exposed history
 * (mirrors `ocp_clean_with_history`). `unifyFaces` gates the face merge; pass
 * false to keep only the edge merge when the face merge is unsafe (imported STEP
 * geometry, see `booleanWithDiff`).
 *
 * The two tolerances are ALWAYS set, even when the caller passes none: the
 * defaults are OCC's compiled-in pair, but reading that pair by name here is
 * what keeps the kernel and the sketch solver on one contract. A caller that
 * knows its geometry is only as precise as a solve reports passes the realised
 * value (already clamped to the ceiling by `mergeTolerance`).
 */
export function cleanWithHistory(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  unifyFaces = true,
  tolerances: CleanTolerances = {},
): { shape: OccShape; history: OccHistory } {
  const up = scope.track(new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, unifyFaces, unifyFaces))
  up.SetLinearTolerance(tolerances.linearTol ?? OCC_CONFUSION)
  up.SetAngularTolerance(tolerances.angularTol ?? OCC_ANGULAR)
  up.AllowInternalEdges(false)
  up.Build()
  return { shape: up.Shape(), history: scope.track(up.History_1()).get() }
}

/** The tolerances one clean reads. Absent values fall back to the contract. */
export interface CleanTolerances {
  linearTol?: number
  angularTol?: number
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

/**
 * Every occurrence in `pool` keyed by its topological identity, in pool order.
 *
 * The mapOne fallbacks below used to answer "which cleaned sub-shapes are IsSame
 * to this query" with `pool.filter(IsSame)`, which is one embind crossing per
 * (query, pool occurrence): at 325 pattern holes the edge pool is about 6000
 * occurrences and the new-edge list about 4000, so a single boolean paid on the
 * order of 10^7 crossings (37.8 s of a 111.9 s solve). The index keeps every
 * occurrence as its own value, so `get` returns exactly what `filter` did,
 * duplicates and order included.
 */
function indexBySubShapeIdentity(pool: readonly OccSubShape[]): SubShapeMultiIndex<OccSubShape> {
  const index = new SubShapeMultiIndex<OccSubShape>()
  for (const p of pool) index.add(p, p)
  return index
}

/**
 * Map a BrepDiff's sub-shape lists from the raw boolean result onto the cleaned
 * shape (mirrors `ocp_compose_diff_through_clean`). Faces/edges removed by the
 * unify step drop out; pass-through shapes are matched by IsSame against the
 * cleaned pool, which is identity-indexed with every occurrence kept. The
 * `*_input_*` lists are carried as-is (they reference inputs, untouched by
 * clean). Dedupes by wrapper identity.
 *
 * Exported for the compose-equivalence test, which holds a copy of the old
 * filter form as its oracle.
 */
export function composeDiffThroughClean(
  oc: OccModule,
  scope: DisposeScope,
  diff: BrepDiff,
  cleanHistory: OccHistory,
  cleanedShape: OccShape,
): BrepDiff {
  const E = oc.TopAbs_ShapeEnum
  const cleanedFaces = explore(oc, scope, cleanedShape, E.TopAbs_FACE)
  const cleanedEdges = explore(oc, scope, cleanedShape, E.TopAbs_EDGE)
  const faceIndex = indexBySubShapeIdentity(cleanedFaces)
  const edgeIndex = indexBySubShapeIdentity(cleanedEdges)

  const mapOne = (s: OccSubShape, pool: SubShapeMultiIndex<OccSubShape>): OccSubShape[] => {
    if (cleanHistory.IsRemoved(s)) return []
    const mods = drainList(scope, cleanHistory.Modified(s)) as OccSubShape[]
    if (mods.length === 0) {
      const passthrough = pool.get(s)
      return passthrough.length ? [...passthrough] : [s]
    }
    const out: OccSubShape[] = []
    for (const m of mods) {
      const matched = pool.get(m)
      out.push(...(matched.length ? matched : [m]))
    }
    return out
  }

  // Dedup by wrapper reference identity, mirroring Python's `id(m)` set (NOT by
  // IsSame): each TopExp occurrence is a distinct handle, so a box edge present
  // twice in the cleaned pool counts twice -- the same way the Python pipeline
  // counts it. Collapsing by IsSame here would halve every edge count.
  const mapList = (items: unknown[], pool: SubShapeMultiIndex<OccSubShape>): OccSubShape[] => {
    const result: OccSubShape[] = []
    const seen = new Set<OccSubShape>()
    for (const s of items as OccSubShape[]) {
      for (const m of mapOne(s, pool)) {
        if (!seen.has(m)) {
          seen.add(m)
          result.push(m)
        }
      }
    }
    return result
  }

  return {
    new_faces: mapList(diff.new_faces, faceIndex),
    inherited_faces: mapList(diff.inherited_faces, faceIndex),
    new_edges: mapList(diff.new_edges, edgeIndex),
    inherited_edges: mapList(diff.inherited_edges, edgeIndex),
    modified_input_faces: [...diff.modified_input_faces],
    deleted_input_faces: [...diff.deleted_input_faces],
    modified_input_edges: [...diff.modified_input_edges],
    deleted_input_edges: [...diff.deleted_input_edges],
  }
}

/**
 * Rewrite a BrepDiff's output lists through the canonicalization (raw face ->
 * analytic-cylinder rebuild, then the heal that re-makes faces and edges it did
 * not swap as well), so they reference sub-shapes of the canonical shape.
 */
function mapDiffThroughCanonical(diff: BrepDiff, rebase: (s: OccSubShape) => OccSubShape): BrepDiff {
  const mapList = (items: unknown[]): OccSubShape[] => (items as OccSubShape[]).map(rebase)
  return {
    ...diff,
    new_faces: mapList(diff.new_faces),
    inherited_faces: mapList(diff.inherited_faces),
    new_edges: mapList(diff.new_edges),
    inherited_edges: mapList(diff.inherited_edges),
  }
}

/** Rewrite faceOrigin.output through the canonicalization, onto the canonical shape's faces. */
function mapOriginThroughCanonical(origin: FaceOrigin[], rebase: (s: OccSubShape) => OccSubShape): FaceOrigin[] {
  return origin.map((o) => ({ ...o, output: rebase(o.output) }))
}

/**
 * Map faceOrigin.output from raw-boolean space onto the cleaned shape (mirrors
 * composeDiffThroughClean). A raw output face removed by the unify step drops
 * out. A merged face prefers a target source over a tool source, as the raw
 * level does, and otherwise keeps the first source seen: a tool face folded into
 * an existing coplanar or coaxial face (a hole floor on a step's lower level, a
 * bore drilled down an existing bore) must leave the existing face its name, and
 * which raw face the explorer lists first must not decide that. The source
 * handle references an input shape, untouched by clean, so it is carried as-is.
 */
export function composeOriginThroughClean(
  oc: OccModule,
  scope: DisposeScope,
  origin: FaceOrigin[],
  cleanHistory: OccHistory,
  cleanedShape: OccShape,
): FaceOrigin[] {
  const E = oc.TopAbs_ShapeEnum
  const cleanedFaces = explore(oc, scope, cleanedShape, E.TopAbs_FACE)
  // Cleaned outputs in first-seen order, each with every source that reached it.
  const candidates = new Map<OccSubShape, FaceOrigin[]>()
  const faceIndex = indexBySubShapeIdentity(cleanedFaces)
  const push = (output: OccSubShape, o: FaceOrigin): void => {
    const seen = candidates.get(output)
    if (seen === undefined) candidates.set(output, [o])
    else seen.push(o)
  }
  for (const o of origin) {
    if (cleanHistory.IsRemoved(o.output)) continue
    const mods = drainList(scope, cleanHistory.Modified(o.output)) as OccSubShape[]
    if (mods.length === 0) {
      const passthrough = faceIndex.get(o.output)
      for (const p of passthrough.length ? passthrough : [o.output]) push(p, o)
    } else {
      for (const m of mods) {
        const matched = faceIndex.get(m)
        for (const p of matched.length ? matched : [m]) push(p, o)
      }
    }
  }
  const out: FaceOrigin[] = []
  for (const [output, sources] of candidates) {
    const chosen = sources.find((s) => !s.fromTool) ?? sources[0]
    out.push({ output, source: chosen.source, fromTool: chosen.fromTool })
  }
  return out
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
  const preDiff = canonical.changed ? mapDiffThroughCanonical(rawDiff, canonical.rebase) : rawDiff
  const preOrigin = canonical.changed ? mapOriginThroughCanonical(rawOrigin, canonical.rebase) : rawOrigin
  return { shape: preClean, diff: preDiff, faceOrigin: preOrigin }
}

/**
 * A closed body has a non-zero volume under volumeOf's OnlyClosed read; an open
 * shell (an imported body, L5) integrates to 0. That read is what decides
 * whether closedness may be demanded of a boolean result, so no extra
 * BRepCheck is paid on the operands.
 */
function isClosedByVolume(volume: number): boolean {
  return Math.abs(volume) > 1e-12
}

/** Whole-shape BRepCheck gate. Exported because offsetShape.ts validates its
 *  normalised offset solid with the same rule the boolean fallbacks use. */
export function shapeIsValid(oc: OccModule, scope: DisposeScope, shape: OccShape): boolean {
  return scope.track(new oc.BRepCheck_Analyzer(shape, true)).IsValid_2()
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

/**
 * Adopt a UnifySameDomain result only when it validates and preserved the
 * volume, the same guard canonicalSurfaces.ts runs before adopting its heal.
 * The robustness fuzz found a fuse whose tool cap welded into a coincident
 * target face where the clean pass silently returned a self-intersecting solid
 * whose volume GREW (the fuse of a box body with a cylinder cap coplanar to
 * its top face, after a cut and a blind hole); adopting it shipped a
 * BRepCheck-invalid body under an ok status. The pre-clean result is a sound
 * solid, so a rejected clean falls back exactly like a throwing one.
 *
 * The verdict carries the handle it validated so `booleanResultProblem` does not
 * pay the same whole-shape BRepCheck again: on a 325-hole plate that analyzer
 * call is the single most expensive phase of the solve (about 21 s).
 */
function cleanShapeIsSound(
  oc: OccModule,
  scope: DisposeScope,
  before: OccShape,
  after: OccShape,
): { sound: boolean; validated: OccShape | null } {
  try {
    // The same solid before and after a topology-only step: the default rule's
    // correlated read error cancels in the difference, and using the adaptive
    // rule here flipped an adoption verdict that rewrote face UUIDs under a
    // perturbed rebuild (fuzz seed 235). See volumeOfDefault.
    const v0 = volumeOfDefault(oc, scope, before)
    const v1 = volumeOfDefault(oc, scope, after)
    const volumeKept = Math.abs(v1 - v0) <= Math.max(1e-9, 1e-6 * Math.abs(v0))
    // BRepCheck flags an open shell invalid for its very openness, and an open
    // shell is a supported body (L5), so only a closed input's result has to
    // validate; a shell is judged by the preserved volume alone.
    if (isClosedByVolume(v0)) {
      if (!shapeIsValid(oc, scope, after)) return { sound: false, validated: null }
      return { sound: volumeKept, validated: volumeKept ? after : null }
    }
    return { sound: volumeKept, validated: null }
  } catch (e) {
    swallowUnlessTrap(e)
    // A guard that cannot run must not adopt the shape it cannot check.
    return { sound: false, validated: null }
  }
}

/** A boolean the kernel completed with a result that cannot be shipped. */
export class BooleanSoundnessError extends Error {}

/**
 * The last line of defence against a corrupt boolean: OCCT 7.4.0p1 can report
 * IsDone with a shape that validates yet is geometrically impossible. The
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

/** One full boolean pipeline: raw boolean, cylinder canonicalization, clean. */
function composeBooleanAttempt(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tools: readonly OccShape[],
  op: BooleanOp,
  unifyFaces: boolean,
  tolerance: MergeTolerance,
): BooleanAttempt {
  const pre = rawBooleanWithDiff(oc, scope, target, tools, op)
  // The raw boolean is the longest kernel call of the pipeline; a heartbeat
  // before the clean and the guard keeps its duration out of the next gap the
  // host's stall budget measures.
  markFeatureProgress()
  let rejected: OccShape | null = null
  try {
    const r = cleanWithHistory(oc, scope, pre.shape, unifyFaces, {
      linearTol: tolerance.linearTol,
      angularTol: tolerance.angularTol,
    })
    markFeatureProgress()
    const verdict = cleanShapeIsSound(oc, scope, pre.shape, r.shape)
    markFeatureProgress()
    if (verdict.sound) {
      const diff = composeDiffThroughClean(oc, scope, pre.diff, r.history, r.shape)
      const faceOrigin = composeOriginThroughClean(oc, scope, pre.faceOrigin, r.history, r.shape)
      markFeatureProgress()
      return { shape: r.shape, diff, faceOrigin, validated: verdict.validated }
    }
    rejected = r.shape
  } catch (e) {
    swallowUnlessTrap(e)
    // ShapeUpgrade_UnifySameDomain (the coplanar-face merge) can throw on a valid
    // boolean result whose coincident faces it cannot fold. The reproducer is an
    // extrude of a body face that has a hole, added back onto that same body: the
    // shared coincident face plus the hole's inner wall defeat the merge. Fall
    // through to the raw rebuild.
  }
  // The rejected clean result has no owner (the caller gets the fallback
  // below), so hand it to the scope or it strands on the WASM heap.
  if (rejected !== null) scope.track(rejected)
  // The fallback cannot reuse `pre.shape`: the merge works in place, so a
  // rejected or half-applied clean may have left it -- and the pre-clean result
  // is only safely readable from the untouched operands. Rebuild it.
  return { ...rawBooleanWithDiff(oc, scope, target, tools, op), validated: null }
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
  // take an OCCT 7.4.0p1 branch that drops or inverts an operand. A bare Common
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
  throw new BooleanSoundnessError(
    `boolean ${op}: the kernel returned an unsound result (${retryProblem}). ` +
    'The two shapes probably touch in an exact tangency the kernel cannot resolve; ' +
    'nudge one of them off the coincident radius or plane and rebuild.',
  )
}
