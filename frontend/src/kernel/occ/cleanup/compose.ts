/**
 * Carrying identity across a cleanup pass.
 *
 * A pass either maps sub-shapes one-to-one (the cylinder rebuild, the healer,
 * which re-makes faces) or merges/removes them (UnifySameDomain). The boolean
 * pipeline already composed its diff and face origins through the clean this
 * way; the same rules now serve every pass, so the three producers hand names
 * over through one mechanism instead of two.
 */

import type { DisposeScope } from '../disposeScope'
import type { FaceOrigin, SubShapeRebase } from './types'
import type { OccHistory, OccModule, OccShape, OccSubShape } from '../occTypes'
import type { BrepDiff } from '../../types3d'
import type { ShapeNames } from '../partNames'
import { drainList } from '../disposeScope'
import { SubShapeMap, SubShapeMultiIndex } from '../subshapeIdentity'

/** All sub-shapes of `shape` of the given enum kind, as IsSame-comparable handles. */
export function explore(
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
export function indexBySubShapeIdentity(pool: readonly OccSubShape[]): SubShapeMultiIndex<OccSubShape> {
  const index = new SubShapeMultiIndex<OccSubShape>()
  for (const p of pool) index.add(p, p)
  return index
}

/**
 * Map a BrepDiff's sub-shape lists from a pass's input onto its output (mirrors
 * `ocp_compose_diff_through_clean`). Faces/edges removed by a merging pass drop
 * out; pass-through shapes are matched by IsSame against the cleaned pool,
 * which is identity-indexed with every occurrence kept. The `*_input_*` lists
 * are carried as-is (they reference inputs, untouched by the pass). Dedupes by
 * wrapper identity.
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
 * Rewrite a BrepDiff's output lists through a one-to-one rebase (the cylinder
 * rebuild and its heal, the healer's fixer context), so they reference
 * sub-shapes of the rebased shape.
 */
export function mapDiffThroughRebase(diff: BrepDiff, rebase: SubShapeRebase): BrepDiff {
  const mapList = (items: unknown[]): OccSubShape[] => (items as OccSubShape[]).map(rebase)
  return {
    ...diff,
    new_faces: mapList(diff.new_faces),
    inherited_faces: mapList(diff.inherited_faces),
    new_edges: mapList(diff.new_edges),
    inherited_edges: mapList(diff.inherited_edges),
  }
}

/** Rewrite faceOrigin.output through a one-to-one rebase. */
export function mapOriginThroughRebase(
  origin: readonly FaceOrigin[],
  rebase: SubShapeRebase,
): FaceOrigin[] {
  return origin.map((o) => ({ ...o, output: rebase(o.output) }))
}

/**
 * Map faceOrigin.output from a pass's input onto its output through a merging
 * pass's history (mirrors composeDiffThroughClean). A raw output face removed by
 * the pass drops out. A merged face prefers a target source over a tool source,
 * as the raw level does, and otherwise keeps the first source seen: a tool face
 * folded into an existing coplanar or coaxial face (a hole floor on a step's
 * lower level, a bore drilled down an existing bore) must leave the existing
 * face its name, and which raw face the explorer lists first must not decide
 * that. The source handle references an input shape, untouched by the pass, so
 * it is carried as-is.
 */
export function composeOriginThroughClean(
  oc: OccModule,
  scope: DisposeScope,
  origin: readonly FaceOrigin[],
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

/** `names` re-keyed onto another shape's sub-shapes through `rebase`. */
export function rebaseNames(names: ShapeNames, rebase: SubShapeRebase): ShapeNames {
  const move = (from: SubShapeMap<string>): SubShapeMap<string> => {
    const out = new SubShapeMap<string>()
    for (const [s, uuid] of from.entries()) out.set(rebase(s), uuid)
    return out
  }
  return { ...names, faceNames: move(names.faceNames), edgeNames: move(names.edgeNames) }
}

/**
 * `diff` with its output-side lists moved onto the rebased shape through
 * `rebase`, so attribution finds the new faces and edges by identity there.
 * The input-side lists name sub-shapes of the old body and stay as they are.
 */
export function rebaseDiff(diff: BrepDiff, rebase: SubShapeRebase): BrepDiff {
  return mapDiffThroughRebase(diff, rebase)
}

/**
 * `names` composed through a merging pass's history.
 *
 * A removed sub-shape loses its name. A pass-through keeps the handle it had
 * (the same TShape is still inside the result). Where the pass folded several
 * sources into one image the first entry in the input map wins, so map order
 * (never explorer order) decides which UUID survives.
 */
export function composeNamesThroughHistory(
  scope: DisposeScope,
  names: ShapeNames,
  history: OccHistory,
): ShapeNames {
  const move = (from: SubShapeMap<string>): SubShapeMap<string> => {
    const out = new SubShapeMap<string>()
    for (const [source, uuid] of from.entries()) {
      if (history.IsRemoved(source)) continue
      const mods = drainList(scope, history.Modified(source)) as OccSubShape[]
      const images = mods.length ? mods : [source]
      for (const image of images) if (!out.has(image)) out.set(image, uuid)
    }
    return out
  }
  return { ...names, faceNames: move(names.faceNames), edgeNames: move(names.edgeNames) }
}

/**
 * A representative image of `s` through a merging pass's history, for callers
 * that only need a one-to-one answer. Removed shapes fall back to `s`; a merged
 * image keeps the first image the history reports.
 */
export function historyRebase(scope: DisposeScope, history: OccHistory): SubShapeRebase {
  return (s) => {
    if (history.IsRemoved(s)) return s
    const mods = drainList(scope, history.Modified(s)) as OccSubShape[]
    return mods.length ? mods[0] : s
  }
}
