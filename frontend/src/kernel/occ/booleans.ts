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
import { volumeOf } from './volume'
import { foldCavitySolids } from './cavities'
import { emptyBrepDiff, type BrepDiff } from '../types3d'

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
  } catch {
    // A failed probe is not evidence of disjointness: report intersect so the
    // caller runs the real cut and its own failure surfaces instead.
    return true
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
  const E = oc.TopAbs_ShapeEnum
  const algo = scope.track(makeBooleanOp(oc, op))

  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(targetShape)
  const tools = scope.track(new oc.TopTools_ListOfShape_1())
  tools.Append_1(toolShape)
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
  const toolFaces = explore(oc, scope, toolShape, E.TopAbs_FACE)
  const toolEdges = explore(oc, scope, toolShape, E.TopAbs_EDGE)
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
 * ShapeUpgrade_UnifySameDomain (cadquery Shape.clean) with exposed history
 * (mirrors `ocp_clean_with_history`). `unifyFaces` gates the face merge; pass
 * false to keep only the edge merge when the face merge is unsafe (imported STEP
 * geometry, see `booleanWithDiff`).
 */
export function cleanWithHistory(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  unifyFaces = true,
): { shape: OccShape; history: OccHistory } {
  const up = scope.track(new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, unifyFaces, unifyFaces))
  up.AllowInternalEdges(false)
  up.Build()
  return { shape: up.Shape(), history: scope.track(up.History_1()).get() }
}

/**
 * Map a BrepDiff's sub-shape lists from the raw boolean result onto the cleaned
 * shape (mirrors `ocp_compose_diff_through_clean`). Faces/edges removed by the
 * unify step drop out; pass-through shapes are matched by IsSame against the
 * cleaned pool. The `*_input_*` lists are carried as-is (they reference inputs,
 * untouched by clean). Dedupes by IsSame.
 */
function composeDiffThroughClean(
  oc: OccModule,
  scope: DisposeScope,
  diff: BrepDiff,
  cleanHistory: OccHistory,
  cleanedShape: OccShape,
): BrepDiff {
  const E = oc.TopAbs_ShapeEnum
  const cleanedFaces = explore(oc, scope, cleanedShape, E.TopAbs_FACE)
  const cleanedEdges = explore(oc, scope, cleanedShape, E.TopAbs_EDGE)

  const mapOne = (s: OccSubShape, pool: OccSubShape[]): OccSubShape[] => {
    if (cleanHistory.IsRemoved(s)) return []
    const mods = drainList(scope, cleanHistory.Modified(s)) as OccSubShape[]
    if (mods.length === 0) {
      const passthrough = pool.filter((p) => p.IsSame(s))
      return passthrough.length ? passthrough : [s]
    }
    const out: OccSubShape[] = []
    for (const m of mods) {
      const matched = pool.filter((p) => p.IsSame(m))
      out.push(...(matched.length ? matched : [m]))
    }
    return out
  }

  // Dedup by wrapper reference identity, mirroring Python's `id(m)` set (NOT by
  // IsSame): each TopExp occurrence is a distinct handle, so a box edge present
  // twice in the cleaned pool counts twice -- the same way the Python pipeline
  // counts it. Collapsing by IsSame here would halve every edge count.
  const mapList = (items: unknown[], pool: OccSubShape[]): OccSubShape[] => {
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
    new_faces: mapList(diff.new_faces, cleanedFaces),
    inherited_faces: mapList(diff.inherited_faces, cleanedFaces),
    new_edges: mapList(diff.new_edges, cleanedEdges),
    inherited_edges: mapList(diff.inherited_edges, cleanedEdges),
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
  const push = (output: OccSubShape, o: FaceOrigin): void => {
    const seen = candidates.get(output)
    if (seen === undefined) candidates.set(output, [o])
    else seen.push(o)
  }
  for (const o of origin) {
    if (cleanHistory.IsRemoved(o.output)) continue
    const mods = drainList(scope, cleanHistory.Modified(o.output)) as OccSubShape[]
    if (mods.length === 0) {
      const passthrough = cleanedFaces.filter((p) => p.IsSame(o.output))
      for (const p of passthrough.length ? passthrough : [o.output]) push(p, o)
    } else {
      for (const m of mods) {
        const matched = cleanedFaces.filter((p) => p.IsSame(m))
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
  tool: OccShape,
  op: BooleanOp,
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  const { shape: raw, diff: rawDiff, faceOrigin: rawOrigin } = booleanWithHistory(oc, scope, target, tool, op)
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
 * Adopt a UnifySameDomain result only when it validates and preserved the
 * volume, the same guard canonicalSurfaces.ts runs before adopting its heal.
 * The robustness fuzz found a fuse whose tool cap welded into a coincident
 * target face where the clean pass silently returned a self-intersecting solid
 * whose volume GREW (the fuse of a box body with a cylinder cap coplanar to
 * its top face, after a cut and a blind hole); adopting it shipped a
 * BRepCheck-invalid body under an ok status. The pre-clean result is a sound
 * solid, so a rejected clean falls back exactly like a throwing one.
 */
function cleanShapeIsSound(oc: OccModule, scope: DisposeScope, before: OccShape, after: OccShape): boolean {
  try {
    const v0 = volumeOf(oc, scope, before)
    const v1 = volumeOf(oc, scope, after)
    // BRepCheck flags an open shell invalid for its very openness, and an open
    // shell is a supported body (L5), so only a closed input's result has to
    // validate; a shell is judged by the preserved volume alone.
    if (isClosedByVolume(v0) && !shapeIsValid(oc, scope, after)) return false
    return Math.abs(v1 - v0) <= Math.max(1e-9, 1e-6 * Math.abs(v0))
  } catch {
    // A guard that cannot run must not adopt the shape it cannot check.
    return false
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
 */
function booleanResultProblem(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tool: OccShape,
  op: BooleanOp,
  result: OccShape,
): string | null {
  try {
    const vr = Math.abs(volumeOf(oc, scope, result))
    const vt = Math.abs(volumeOf(oc, scope, target))
    const vu = Math.abs(volumeOf(oc, scope, tool))
    if (!Number.isFinite(vr)) return `the result volume is not finite (${vr})`
    // A non-finite operand would make every bound below NaN, i.e. every
    // comparison false: the guard must not adopt a result it cannot judge.
    if (!Number.isFinite(vt) || !Number.isFinite(vu)) {
      return `an operand volume is not finite (target ${vt}, tool ${vu})`
    }
    // As in cleanShapeIsSound: a closed target's result has to validate, an
    // open-shell target (L5) has no closedness contract to enforce.
    if (isClosedByVolume(vt) && !shapeIsValid(oc, scope, result)) {
      return 'the result is not a valid solid (BRepCheck_Analyzer)'
    }
    const tol = 1e-6 * Math.max(vt, vu, 1)
    const bound = op === 'fuse' ? Math.max(vt, vu) : op === 'common' ? Math.min(vt, vu) : vt
    const relation = op === 'fuse' ? 'below' : 'above'
    if (op === 'fuse' ? vr < bound - tol : vr > bound + tol) {
      return `volume ${vr} is ${relation} the ${op} bound ${bound}`
    }
    if (op === 'fuse' && vr > vt + vu + tol) {
      return `volume ${vr} exceeds the operand sum ${vt + vu}`
    }
    return null
  } catch (e) {
    // The same rule as cleanShapeIsSound: a guard that cannot run must not let
    // the shape it cannot check through.
    return `the soundness check could not run: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** `attempt` with any void OCC returned as a separate inside-out solid folded
 *  back into its enclosing solid (cavities.ts); the replaced shape joins the
 *  scope, since nobody else owns it. */
function withFoldedCavities(
  oc: OccModule,
  scope: DisposeScope,
  attempt: { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] },
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  const folded = foldCavitySolids(oc, scope, attempt.shape)
  if (folded === attempt.shape) return attempt
  if (!scope.isTracked(attempt.shape)) scope.track(attempt.shape)
  return { ...attempt, shape: folded }
}

/** One full boolean pipeline: raw boolean, cylinder canonicalization, clean. */
function composeBooleanAttempt(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tool: OccShape,
  op: BooleanOp,
  unifyFaces: boolean,
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  const pre = rawBooleanWithDiff(oc, scope, target, tool, op)
  let rejected: OccShape | null = null
  try {
    const r = cleanWithHistory(oc, scope, pre.shape, unifyFaces)
    if (cleanShapeIsSound(oc, scope, pre.shape, r.shape)) {
      return {
        shape: r.shape,
        diff: composeDiffThroughClean(oc, scope, pre.diff, r.history, r.shape),
        faceOrigin: composeOriginThroughClean(oc, scope, pre.faceOrigin, r.history, r.shape),
      }
    }
    rejected = r.shape
  } catch {
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
  return rawBooleanWithDiff(oc, scope, target, tool, op)
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
  opts: { unifyFaces?: boolean } = {},
): { shape: OccShape; diff: BrepDiff; faceOrigin: FaceOrigin[] } {
  // The face merge (UnifySameDomain's face fold) can spin forever, not throw, on
  // imported-STEP topology (the reproducer: extruding a holed face of an
  // imported body back onto itself, double_with_hole.step). The two cases are
  // geometrically indistinguishable from natively modelled ones, so the caller
  // decides by provenance and passes `unifyFaces: false` for imported targets;
  // the edge merge (always safe) still runs, at the cost of an extra seam face.
  const unifyFaces = opts.unifyFaces ?? true
  const attempt = withFoldedCavities(oc, scope, composeBooleanAttempt(oc, scope, target, tool, op, unifyFaces))
  const problem = booleanResultProblem(oc, scope, target, tool, op, attempt.shape)
  if (problem === null) return attempt
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
  shapesIntersect(oc, target, tool)
  const retry = withFoldedCavities(oc, scope, composeBooleanAttempt(oc, scope, target, tool, op, unifyFaces))
  const retryProblem = booleanResultProblem(oc, scope, target, tool, op, retry.shape)
  if (retryProblem === null) return retry
  if (!scope.isTracked(retry.shape)) scope.track(retry.shape)
  throw new BooleanSoundnessError(
    `boolean ${op}: the kernel returned an unsound result (${retryProblem}). ` +
    'The two shapes probably touch in an exact tangency the kernel cannot resolve; ' +
    'nudge one of them off the coincident radius or plane and rebuild.',
  )
}
