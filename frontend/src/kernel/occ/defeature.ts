// `applyDeleteFacesWithLineage`: the OCC adapter the delete-face leaf
// (features/deleteFace.ts) calls to remove picked faces and heal the gap by
// extending the neighbours' surfaces (OCCT `BRepAlgoAPI_Defeaturing`).
//
// Call shape and history are pinned by defeatureReal.test.ts against the real
// OCCT 7.4.0p1 build:
//   - `SetShape` + `AddFaceToRemove` per face + `SetToFillHistory(true)` +
//     `Build` is the working call; every requested face reports `IsDeleted`,
//     every neighbour reports one `Modified` image (or survives by IsSame), and
//     no face is `Generated` (nothing new is invented).
//   - The BOPAlgo warning surface is unbound, so an impossible removal is a
//     SILENT NO-OP: `IsDone` is true and the shape is unchanged. The only
//     reliable failure signal is `IsDeleted(face) == false` for a requested
//     face, which every guard below hangs on.
//   - A connected set of faces (sharing an edge) is removed or refused as a
//     unit, so the connected group is the unit of success and failure.
//   - A non-analytic neighbour (a B-spline loft side) can hang for over a
//     minute, so the neighbour surface type is checked BEFORE the OCC call.
//
// Names and diff come from the shared fillet/chamfer machinery
// (edgeModifier.ts), typed on the minimal history interface: the removed faces
// die, the extended neighbours carry their UUID across the one Modified image,
// and the healed edges regain their pre-modifier UUID through the face-pair rule
// (deriveEdgeUuid). No face is fresh, so the far-edge rule keeps every unmatched
// edge inherited -- the healed edge stays attributed to the body's creator.

import { drainList, type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccModifierHistory } from './occTypes'
import {
  exploreEdges,
  exploreFaces,
  extractNames,
  edgeModifierDiff,
  isValidShape,
  healShape,
  rebaseNames,
  rebaseDiff,
  type OldNames,
  type NewNames,
} from './edgeModifier'
import { SubShapeDedup, SubShapeMultiIndex, SubShapeIndexMap } from './subshapeIdentity'
import { faceSurfaceType } from './primitives'
import { exploreSolids } from './booleans'
import { emptyBrepDiff, type BrepDiff } from '../types3d'

/** One connected group of picked faces that the operator refused, with its reason. */
export interface FailedDefeatureGroup {
  // Indices into the `faces` argument, ascending; the group's faces.
  faceIndices: number[]
  reason: string
}

export interface DefeatureResult {
  shape: OccShape
  names: NewNames | null
  diff: BrepDiff
  failedGroups: FailedDefeatureGroup[]
  // True when at least one group's faces were actually removed. When false,
  // `shape` is the UNCHANGED input (the caller must not re-register it).
  applied: boolean
}

// The surface types whose underlying surface can be extended to close a gap.
// Anything else (a B-spline, Bezier, offset or extrusion surface) is refused
// before OCC is called: extending it is either impossible or hangs.
const ANALYTIC_SURFACE_TYPES: ReadonlySet<string> = new Set([
  'flatface', 'cylinderface', 'coneface', 'sphereface', 'torusface',
])

// The two user-facing refusals. Kept as phrases (the leaf prefixes
// `delete_face:`) so the same text reaches a red chip's tooltip.
const REASON_NEIGHBOUR = 'a neighbour face is a non-analytic surface and cannot be extended (v1)'
const REASON_GAP = 'the surrounding faces cannot close the gap; pick the whole feature (a blind hole needs its walls and its floor)'
const REASON_BUILD = 'the operation could not be completed'
const REASON_INVALID = 'the operation produced invalid geometry'
const REASON_SPLIT = 'the operation would have changed the number of solids'

/**
 * Group picks into connected sets by shared edge: two picked faces are in one
 * group when they touch (sharing an edge). OCC removes or refuses a connected
 * set as a unit, so the group is also the unit of success and failure.
 *
 * `pairs` is the adjacency (i, j) of two picked-face indices that share an
 * edge. Groups are returned as ascending index lists, ordered by their lowest
 * index, so a refusal always reports the same faces in the same order.
 */
export function unionFaceGroups(n: number, pairs: readonly (readonly [number, number])[]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]
    // Path compression: keeps a long chain from making the next find O(n).
    for (let y = x; parent[y] !== root; ) {
      const next = parent[y]
      parent[y] = root
      y = next
    }
    return root
  }
  for (const [a, b] of pairs) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const list = groups.get(root)
    if (list === undefined) groups.set(root, [i])
    else list.push(i)
  }
  return [...groups.values()]
}

/** The (i, j) pairs of picked faces that share an edge, deduped by identity. */
function adjacencyPairs(oc: OccModule, scope: DisposeScope, faces: OccShape[]): [number, number][] {
  const edges: OccSubShape[] = []
  const seenEdge = new SubShapeDedup()
  const owners = new SubShapeMultiIndex<number>()
  faces.forEach((f, i) => {
    for (const e of exploreEdges(oc, scope, f)) {
      if (seenEdge.add(e as OccSubShape)) edges.push(e as OccSubShape)
      owners.add(e as OccSubShape, i)
    }
  })
  const pairs: [number, number][] = []
  for (const e of edges) {
    const list = owners.get(e)
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (list[a] !== list[b]) pairs.push([list[a], list[b]])
      }
    }
  }
  return pairs
}

/** The picked faces of `shape` grouped into connected sets (indices into `faces`). */
export function faceGroups(oc: OccModule, scope: DisposeScope, faces: OccShape[]): number[][] {
  if (faces.length === 0) return []
  return unionFaceGroups(faces.length, adjacencyPairs(oc, scope, faces))
}

/**
 * The faces of `shape` adjacent to `groupFaces` (sharing an edge) but not in the
 * group: the ring whose surfaces must extend to close the gap. Deduped by
 * identity; order is face-explorer order, which only the type CHECK reads.
 */
export function neighbourRing(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  groupFaces: readonly OccShape[],
): OccShape[] {
  const group = new SubShapeDedup()
  for (const f of groupFaces) group.add(f as OccSubShape)
  const byEdge = new SubShapeMultiIndex<OccShape>()
  for (const f of exploreFaces(oc, scope, shape)) {
    for (const e of exploreEdges(oc, scope, f)) byEdge.add(e as OccSubShape, f)
  }
  const seen = new SubShapeDedup()
  const out: OccShape[] = []
  for (const gf of groupFaces) {
    for (const e of exploreEdges(oc, scope, gf)) {
      for (const nf of byEdge.get(e as OccSubShape)) {
        if (group.has(nf as OccSubShape)) continue
        if (seen.add(nf as OccSubShape)) out.push(nf)
      }
    }
  }
  return out
}

/** The non-analytic surface type in the group's ring, or null when every
 *  neighbour can be extended. */
function blockedNeighbourType(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  groupFaces: readonly OccShape[],
): string | null {
  for (const nf of neighbourRing(oc, scope, shape, groupFaces)) {
    const type = faceSurfaceType(oc, scope, nf)
    if (!ANALYTIC_SURFACE_TYPES.has(type)) return type
  }
  return null
}

/** `maker.IsDeleted(face)`, read as false when the history call throws (a face
 *  the maker cannot narrate is not one it removed). */
function isDeleted(maker: OccModifierHistory, face: OccShape): boolean {
  try {
    return maker.IsDeleted(face)
  } catch {
    return false
  }
}

/**
 * Remove `faces` from `shape` and heal the gap, one OCC call per body. Returns
 * the healed shape (DETACHED on success, so the caller owns it), the rebuilt
 * names, the BrepDiff, the refused groups, and whether anything was applied.
 *
 * Failure returns the UNCHANGED input shape with `applied: false`; the caller
 * must not release it (it is still scope-owned). Lineage is tracked only when
 * `old` is non-null (the caller passes it when the body carries names).
 */
export function applyDeleteFacesWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faces: OccShape[],
  old: OldNames | null = null,
): DefeatureResult {
  const refuseAll = (reason: string): DefeatureResult => ({
    shape,
    names: null,
    diff: emptyBrepDiff(),
    failedGroups: faces.length > 0 ? [{ faceIndices: faces.map((_, i) => i), reason }] : [],
    applied: false,
  })

  if ((shape as unknown as { IsNull(): boolean }).IsNull()) return refuseAll(REASON_BUILD)
  if (faces.length === 0) {
    return { shape, names: null, diff: emptyBrepDiff(), failedGroups: [], applied: false }
  }

  const groups = faceGroups(oc, scope, faces)
  const failedGroups: FailedDefeatureGroup[] = []

  // Guard 2: refuse a group whose neighbour ring holds a non-extendable surface
  // BEFORE calling OCC (a B-spline neighbour can hang for a minute).
  const viable: number[][] = []
  for (const g of groups) {
    const type = blockedNeighbourType(oc, scope, shape, g.map((i) => faces[i]))
    if (type !== null) failedGroups.push({ faceIndices: g, reason: REASON_NEIGHBOUR })
    else viable.push(g)
  }
  if (viable.length === 0) {
    return { shape, names: null, diff: emptyBrepDiff(), failedGroups, applied: false }
  }

  // One call with every viable group's faces. Returns null on IsDone false or a
  // thrown wasm exception (guard 4).
  const build = (gs: readonly number[][]): { maker: OccModifierHistory; built: OccShape } | null => {
    try {
      const maker = scope.track(new oc.BRepAlgoAPI_Defeaturing())
      maker.SetShape(shape)
      for (const g of gs) for (const i of g) maker.AddFaceToRemove(faces[i])
      maker.SetToFillHistory(true)
      maker.Build()
      if (!maker.IsDone()) return null
      return { maker, built: scope.track(maker.Shape()) }
    } catch {
      return null
    }
  }

  const first = build(viable)
  if (first === null) {
    for (const g of viable) failedGroups.push({ faceIndices: g, reason: REASON_BUILD })
    return { shape, names: null, diff: emptyBrepDiff(), failedGroups, applied: false }
  }

  // Guard 3: a group succeeds only when every requested face reports IsDeleted.
  const succeeded: number[][] = []
  for (const g of viable) {
    if (g.every((i) => isDeleted(first.maker, faces[i]))) succeeded.push(g)
    else failedGroups.push({ faceIndices: g, reason: REASON_GAP })
  }
  if (succeeded.length === 0) {
    scope.release(first.built)
    return { shape, names: null, diff: emptyBrepDiff(), failedGroups, applied: false }
  }

  // Insurance: redo the call with only the groups that succeeded, so a failed
  // group can never leave a half-healed state behind, whatever the single call's
  // internal isolation does. Cheap, and the result no longer depends on unbound
  // OCC internals.
  let maker = first.maker
  let built = first.built
  if (succeeded.length < viable.length) {
    scope.release(built)
    const redone = build(succeeded)
    if (redone === null) {
      for (const g of succeeded) failedGroups.push({ faceIndices: g, reason: REASON_BUILD })
      return { shape, names: null, diff: emptyBrepDiff(), failedGroups, applied: false }
    }
    maker = redone.maker
    built = redone.built
  }

  // Guard 6: defeaturing only fills, so a solid-count change is a refusal, not a
  // surprising resplit of something else.
  const beforeSolids = exploreSolids(oc, scope, shape).length
  const afterSolids = exploreSolids(oc, scope, built).length
  if (beforeSolids === 1 && afterSolids !== 1) {
    scope.release(built)
    for (const g of succeeded) failedGroups.push({ faceIndices: g, reason: REASON_SPLIT })
    return { shape, names: null, diff: emptyBrepDiff(), failedGroups, applied: false }
  }

  // Guard 5: heal once if invalid; still invalid -> refuse the whole call.
  let heal: ReturnType<typeof healShape> = null
  if (!isValidShape(oc, scope, built)) {
    heal = healShape(oc, scope, built)
    if (heal === null) {
      scope.release(built)
      for (const g of succeeded) failedGroups.push({ faceIndices: g, reason: REASON_INVALID })
      return { shape, names: null, diff: emptyBrepDiff(), failedGroups, applied: false }
    }
  }

  let names: NewNames | null = null
  let diff: BrepDiff
  try {
    const oldFaces = exploreFaces(oc, scope, shape)
    const oldEdges = exploreEdges(oc, scope, shape)
    const oldFaceIdx = new SubShapeIndexMap()
    oldFaces.forEach((f, i) => oldFaceIdx.set(f as OccSubShape, i))
    const oldFaceModified = new Map<number, OccShape[]>()
    for (const f of oldFaces) {
      oldFaceModified.set(oldFaceIdx.get(f as OccSubShape), drainList(scope, maker.Modified(f)))
    }
    const newFaces = exploreFaces(oc, scope, built)
    const newEdges = exploreEdges(oc, scope, built)
    // No modified edges: defeaturing generates no fillet faces, so the fillet
    // minting step finds nothing (the neighbour pass names any leftover face).
    if (old !== null) {
      names = extractNames(oc, scope, maker, built, [], old, oldFaces, newFaces, oldFaceIdx, oldFaceModified)
    }
    try {
      diff = edgeModifierDiff(oc, scope, maker, oldFaces, oldEdges, newFaces, newEdges, oldFaceIdx, oldFaceModified)
    } catch {
      diff = emptyBrepDiff()
    }
  } catch (e) {
    scope.release(built)
    if (heal !== null) scope.release(heal.shape)
    throw e
  }

  if (heal !== null) {
    const rebased = names === null ? null : rebaseNames(names, heal.rebase)
    const healedDiff = rebaseDiff(diff, heal.rebase)
    scope.release(built)
    return { shape: heal.shape, names: rebased, diff: healedDiff, failedGroups, applied: true }
  }
  return { shape: scope.detach(built), names, diff, failedGroups, applied: true }
}
