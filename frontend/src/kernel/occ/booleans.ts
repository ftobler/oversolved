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

import { drainList, type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccHistory } from './occTypes'
import { canonicalizeCylinderFaces, type CanonicalFaceSwap } from './canonicalSurfaces'
import { emptyBrepDiff, type BrepDiff } from '../types3d'

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

/** Volume of a (closed) shape (mirrors cadquery Solid.Volume / GProp mass). */
export function volumeOf(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false)
  return props.Mass()
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

  const result = algo.Shape()
  const diff = emptyBrepDiff()
  if (!algo.HasHistory()) return { shape: result, diff, faceOrigin: [] }
  const history = scope.track(algo.History()).get()

  // Classify target sub-shapes: build the pool of output preimages reachable
  // from surviving target inputs (these inherit the target body's lineage).
  const classifyTarget = (
    kind: object,
  ): { modified: OccSubShape[]; deleted: OccSubShape[]; preimages: OccSubShape[] } => {
    const modified: OccSubShape[] = []
    const deleted: OccSubShape[] = []
    const preimages: OccSubShape[] = []
    for (const s of explore(oc, scope, targetShape, kind)) {
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
  const recordTool = (kind: object): { modified: OccSubShape[]; deleted: OccSubShape[] } => {
    const modified: OccSubShape[] = []
    const deleted: OccSubShape[] = []
    for (const s of explore(oc, scope, toolShape, kind)) {
      if (history.IsRemoved(s)) {
        deleted.push(s)
      } else if (scope.track(history.Modified(s)).Size() > 0) {
        modified.push(s)
      }
    }
    return { modified, deleted }
  }

  // Walk the output: IsSame against the inherited pool -> inherited, else new.
  const walkOutputs = (
    kind: object,
    inheritedPool: OccSubShape[],
  ): { newList: OccSubShape[]; inheritedList: OccSubShape[] } => {
    const newList: OccSubShape[] = []
    const inheritedList: OccSubShape[] = []
    for (const s of explore(oc, scope, result, kind)) {
      if (inheritedPool.some((p) => s.IsSame(p))) inheritedList.push(s)
      else newList.push(s)
    }
    return { newList, inheritedList }
  }

  const tF = classifyTarget(E.TopAbs_FACE)
  const tE = classifyTarget(E.TopAbs_EDGE)
  const uF = recordTool(E.TopAbs_FACE)
  const uE = recordTool(E.TopAbs_EDGE)

  diff.modified_input_faces = [...tF.modified, ...uF.modified]
  diff.deleted_input_faces = [...tF.deleted, ...uF.deleted]
  diff.modified_input_edges = [...tE.modified, ...uE.modified]
  diff.deleted_input_edges = [...tE.deleted, ...uE.deleted]

  const oF = walkOutputs(E.TopAbs_FACE, tF.preimages)
  const oE = walkOutputs(E.TopAbs_EDGE, tE.preimages)
  diff.new_faces = oF.newList
  diff.inherited_faces = oF.inheritedList
  diff.new_edges = oE.newList
  diff.inherited_edges = oE.inheritedList

  // Per-output-face origin: which input face (target or tool) each output face
  // derived from, by Modified()/IsSame subshape identity. A source that maps to
  // several images is a genuine split; the name transfer orders those children.
  const facePairs: FaceOrigin[] = []
  // Hoisted once (mirrors walkOutputs): the unchanged-face branch below would
  // otherwise re-explore the result's faces per input face.
  const resultFaces = explore(oc, scope, result, E.TopAbs_FACE)
  const collectPairs = (shape: OccShape, fromTool: boolean): void => {
    for (const s of explore(oc, scope, shape, E.TopAbs_FACE)) {
      if (history.IsRemoved(s)) continue
      const mods = drainList(scope, history.Modified(s)) as OccSubShape[]
      if (mods.length > 0) {
        for (const m of mods) facePairs.push({ output: m, source: s, fromTool })
        continue
      }
      // Unchanged face: the input handle does NOT live in the result, so find
      // the result face that is IsSame to it. Without this, faces untouched by
      // the boolean get no origin entry and lose their construction UUID.
      const outFace = resultFaces.find((f) => f.IsSame(s))
      if (outFace) facePairs.push({ output: outFace, source: s, fromTool })
    }
  }
  collectPairs(targetShape, false)
  collectPairs(toolShape, true)
  const faceOrigin: FaceOrigin[] = []
  for (const of of explore(oc, scope, result, E.TopAbs_FACE)) {
    const matches = facePairs.filter((p) => of.IsSame(p.output))
    const chosen = matches.find((p) => !p.fromTool) ?? matches[0]
    if (chosen) faceOrigin.push({ output: of, source: chosen.source, fromTool: chosen.fromTool })
  }

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
 * Rewrite a BrepDiff's face lists through the canonicalization swaps (raw face
 * -> analytic-cylinder rebuild).  Edges are untouched by the rebuild (the new
 * faces reuse the original wires), so only the face lists need mapping.
 */
function mapDiffThroughCanonical(diff: BrepDiff, swaps: CanonicalFaceSwap[]): BrepDiff {
  const mapOne = (s: OccSubShape): OccSubShape => swaps.find((sw) => sw.from.IsSame(s))?.to ?? s
  const mapList = (items: unknown[]): OccSubShape[] => (items as OccSubShape[]).map(mapOne)
  return {
    ...diff,
    new_faces: mapList(diff.new_faces),
    inherited_faces: mapList(diff.inherited_faces),
  }
}

/** Rewrite faceOrigin.output through the canonical-cylinder rebuild swaps. */
function mapOriginThroughCanonical(origin: FaceOrigin[], swaps: CanonicalFaceSwap[]): FaceOrigin[] {
  return origin.map((o) => ({
    ...o,
    output: swaps.find((sw) => sw.from.IsSame(o.output))?.to ?? o.output,
  }))
}

/**
 * Map faceOrigin.output from raw-boolean space onto the cleaned shape (mirrors
 * composeDiffThroughClean). A raw output face removed by the unify step drops
 * out; a merged face keeps the first source seen. The source handle references
 * an input shape, untouched by clean, so it is carried as-is.
 */
function composeOriginThroughClean(
  oc: OccModule,
  scope: DisposeScope,
  origin: FaceOrigin[],
  cleanHistory: OccHistory,
  cleanedShape: OccShape,
): FaceOrigin[] {
  const E = oc.TopAbs_ShapeEnum
  const cleanedFaces = explore(oc, scope, cleanedShape, E.TopAbs_FACE)
  const out: FaceOrigin[] = []
  const seen = new Set<OccSubShape>()
  const push = (output: OccSubShape, o: FaceOrigin): void => {
    if (seen.has(output)) return
    seen.add(output)
    out.push({ output, source: o.source, fromTool: o.fromTool })
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
  return out
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
  const { shape: raw, diff: rawDiff, faceOrigin: rawOrigin } = booleanWithHistory(oc, scope, target, tool, op)
  scope.track(raw)
  const canonical = canonicalizeCylinderFaces(oc, scope, raw)
  const preClean = canonical.shape
  if (canonical.changed) scope.track(preClean)
  const preDiff = canonical.changed ? mapDiffThroughCanonical(rawDiff, canonical.swaps) : rawDiff
  const preOrigin = canonical.changed ? mapOriginThroughCanonical(rawOrigin, canonical.swaps) : rawOrigin
  let cleaned: OccShape
  let history: OccHistory
  try {
    const r = cleanWithHistory(oc, scope, preClean, unifyFaces)
    cleaned = r.shape
    history = r.history
  } catch {
    // ShapeUpgrade_UnifySameDomain (the coplanar-face merge) can throw on a valid
    // boolean result whose coincident faces it cannot fold. The reproducer is an
    // extrude of a body face that has a hole, added back onto that same body: the
    // shared coincident face plus the hole's inner wall defeat the merge. The raw
    // fuse output is a sound solid, so fall back to it un-merged (an extra seam
    // edge where the parts meet) rather than failing the whole feature.
    return { shape: preClean, diff: preDiff, faceOrigin: preOrigin }
  }
  const diff = composeDiffThroughClean(oc, scope, preDiff, history, cleaned)
  const faceOrigin = composeOriginThroughClean(oc, scope, preOrigin, history, cleaned)
  return { shape: cleaned, diff, faceOrigin }
}
