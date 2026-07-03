/**
 * This is the BrepDiff producer the 2e lineage transfer consumes: it classifies each output
 * sub-shape as inherited (target lineage survives) or new (introduced by the tool), so ancestry
 * registration tags new faces with the cutting feature rather than the body's creator.
 *
 * opencascade.js@1.1.1 quirks pinned here (probed against the real build): - history.Modified()
 * returns a TopTools_ListOfShape with no iterator binding; drain via
 * Size()/First_1()/RemoveFirst() (the same sharp edge as the spike). -
 * TopTools_IndexedDataMapOfShapeListOfShape / TopExp.MapShapesAndAncestors's map type are
 * absent, so edge->face adjacency (the edge_lineage rebuild) is built face-by-face in the
 * lineage shard, not via the indexed map.
 *
 * Like primitives.ts, every function takes a DisposeScope and tracks its transients there. The
 * returned result shape is NOT tracked (the caller owns its lifetime); the BrepDiff's sub-shape
 * handles are tracked in the passed scope and are valid only while that scope is alive -- the
 * builder keeps the scope open across the lineage transfer that reads them.
 */

import { drainList, type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccHistory } from './occTypes'
import { emptyBrepDiff, type BrepDiff } from '../types3d'

export type BooleanOp = 'cut' | 'fuse' | 'common'

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
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Solid_1(exp.Current())))
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
): { shape: OccShape; diff: BrepDiff } {
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
  if (!algo.HasHistory()) return { shape: result, diff }
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
      } else if (history.Modified(s).Size() > 0) {
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

  return { shape: result, diff }
}

/**
 * ShapeUpgrade_UnifySameDomain (cadquery Shape.clean) with exposed history
 * (mirrors `ocp_clean_with_history`).
 */
export function cleanWithHistory(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): { shape: OccShape; history: OccHistory } {
  const up = scope.track(new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, true, true))
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
 * Boolean (cut|fuse|common) then clean, composing history through the clean step
 * (mirrors cadquery_ops `_boolean_with_diff`). Returns (cleaned shape, BrepDiff
 * in cleaned-shape handle space). The cleaned shape is NOT tracked; the diff's
 * cleaned sub-shape handles are tracked in `scope`.
 */
export function booleanWithDiff(
  oc: OccModule,
  scope: DisposeScope,
  target: OccShape,
  tool: OccShape,
  op: BooleanOp,
): { shape: OccShape; diff: BrepDiff } {
  const { shape: raw, diff: rawDiff } = booleanWithHistory(oc, scope, target, tool, op)
  let cleaned: OccShape
  let history: OccHistory
  try {
    const r = cleanWithHistory(oc, scope, raw)
    cleaned = r.shape
    history = r.history
  } catch {
    // ShapeUpgrade_UnifySameDomain (the coplanar-face merge) can throw on a valid
    // boolean result whose coincident faces it cannot fold. The reproducer is an
    // extrude of a body face that has a hole, added back onto that same body: the
    // shared coincident face plus the hole's inner wall defeat the merge. The raw
    // fuse output is a sound solid, so fall back to it un-merged (an extra seam
    // edge where the parts meet) rather than failing the whole feature.
    return { shape: raw, diff: rawDiff }
  }
  const diff = composeDiffThroughClean(oc, scope, rawDiff, history, cleaned)
  return { shape: cleaned, diff }
}
