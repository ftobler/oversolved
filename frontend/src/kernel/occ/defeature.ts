// `applyDeleteFacesWithLineage`: the OCC adapter the delete-face leaf
// (features/deleteFace.ts) calls to remove picked faces and heal the gap.
//
// The healing is a ladder. Rung 1 is OCCT `BRepAlgoAPI_Defeaturing` (the shipped
// route); rung 1b is the plan's pre-conditioned retry, which Step 0 found
// nothing to convert for; rung 2 (defeatureWedge.ts) rebuilds the material an
// edge modifier removed or added and fuses/cuts it back. A group falls through
// the rungs in order and the final refusal names every rung and its reason.
//
// Call shape and history are pinned by defeatureReal.test.ts against the real
// OCC build:
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
//   - A modifier band is cross-checked against rung 2's wedge: OCCT can return
//     a VALID but wrong shape (the minimal plane-sphere case swallowed the flat
//     cap), and the volume is the only signal that catches it.
//
// Rung 1's names and diff come from the shared fillet/chamfer machinery
// (edgeModifier.ts), typed on the minimal history interface: the removed faces
// die, the extended neighbours carry their UUID across the one Modified image,
// and the healed edges regain their pre-modifier UUID through the face-pair rule
// (deriveEdgeUuid). No face is fresh, so the far-edge rule keeps every unmatched
// edge inherited -- the healed edge stays attributed to the body's creator.
// Rung 2 names through `transferBooleanNames`, carries untouched edges across
// the boolean by their face surfaces, and names the restored sharp edge from
// the support pair.

import { drainList, type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccModifierHistory } from './occTypes'
import { noProgress } from './defaultArgs'
import {
  exploreEdges,
  exploreFaces,
  extractNames,
  edgeModifierDiff,
  type OldNames,
  type NewNames,
} from './edgeModifier'
import { passRejected, runCleanup } from './cleanup/pipeline'
import { healOnlyPlan } from './cleanup/presets'
import { SubShapeDedup, SubShapeMultiIndex, SubShapeIndexMap } from './subshapeIdentity'
import { faceSurfaceType, FACE_RESTRICTION_TYPES, shapeBndBox } from './primitives'
import { canonicalEdges } from './partNames'
import { sameAnalyticSurface } from './moveFaceSurfaces'
import { booleanWithDiff, exploreSolids } from './booleans'
import { volumeOf } from './volume'
import { shapeIsValid } from './booleans'
import { modifierWedge, RUNG_WEDGE } from './defeatureWedge'
import { transferBooleanNames } from '../features/booleanLineage'
import { deriveEdgeUuid } from '../constructionName'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import { isHeapCorruptionTrap, swallowUnlessTrap } from '../errors'

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

// The surface types whose underlying surface can be extended to close a gap:
// every face kind but the freeform catch-all. Anything else (a B-spline,
// Bezier, offset or extrusion surface) is refused before OCC is called:
// extending it is either impossible or hangs. The kinds come from the shared
// vocabulary in primitives.ts, not a second hand list.
const ANALYTIC_SURFACE_TYPES: ReadonlySet<string> = new Set(
  FACE_RESTRICTION_TYPES.filter((t) => t !== 'face'),
)

// The two user-facing refusals. Kept as phrases (the leaf prefixes
// `delete_face:`) so the same text reaches a red chip's tooltip.
const REASON_NEIGHBOUR = 'a neighbour face is a non-analytic surface and cannot be extended (v1)'
const REASON_GAP = 'the surrounding faces cannot close the gap; pick the whole feature (a blind hole needs its walls and its floor)'
const REASON_BUILD = 'the operation could not be completed'
const REASON_INVALID = 'the operation produced invalid geometry'
const REASON_SPLIT = 'the operation would have changed the number of solids'

// The delete-face ladder. Rung 1 is the shipped OCCT defeaturing call; rung 1b
// is the plan's pre-conditioned retry, which Step 0 found no use for (the
// fixture's ring is already Sphere/Plane/Plane and the modifier faces are the
// only B-splines, so a unified copy has nothing to convert); rung 2 is our own
// splitter wedge (defeatureWedge.ts). Every final refusal names all three and
// why each did not carry the group.
const RUNG_OCCT = 'rung 1 (OCCT defeaturing)'
const RUNG_PRECONDITION = 'rung 1b (pre-conditioned OCCT defeaturing)'
const PRECONDITION_WHY =
  'not attempted: Step 0 measured the picked faces as the only B-spline surfaces and the ring already analytic (sphere/plane/plane), so unifying a copy has nothing to convert'
const RUNG2_SKIPPED =
  'rung 2 was not attempted because another group in the same call was already applied (the body had changed)'

/** The ladder text a failed group's reason carries, so a red chip says which
 *  rung could have healed it and why it did not. */
function ladderText(rung1: string, rung2: string): string {
  return `${rung1} [rungs: ${RUNG_OCCT} did not carry it; ${RUNG_PRECONDITION}: ${PRECONDITION_WHY}; ${rung2}]`
}

/** A compound of the wedge cells, the one tool shape the boolean takes. */
function compoundOf(oc: OccModule, scope: DisposeScope, cells: readonly OccShape[]): OccShape {
  const compound = scope.track(new oc.TopoDS_Compound())
  const builder = scope.track(new oc.BRep_Builder())
  builder.MakeCompound(compound)
  for (const cell of cells) builder.Add(compound, cell)
  return compound
}

/**
 * Carry the input shape's edge UUIDs across the boolean by their face SURFACES.
 * `transferBooleanNames` rebuilds edge names from face adjacency, which is the
 * right rule for a new edge but loses an untouched edge when one of its faces
 * was split by the boolean (two modifier deletions in sequence split the shared
 * sphere, and the first deletion's restored sharp edge was re-derived from a
 * sibling face). An input edge whose two faces still have an image on the same
 * surfaces, with exactly one output edge between them, keeps its UUID. Edges
 * that involve a picked modifier face find no image and die with it.
 */
function carryEdgeNames(
  oc: OccModule,
  scope: DisposeScope,
  inputShape: OccShape,
  outputShape: OccShape,
  names: NewNames,
  old: OldNames,
): void {
  const inputFaces = exploreFaces(oc, scope, inputShape)
  const inputAdj = new SubShapeMultiIndex<OccShape>()
  for (const face of inputFaces) {
    for (const edge of exploreEdges(oc, scope, face)) inputAdj.add(edge as OccSubShape, face)
  }
  const outputFaces = exploreFaces(oc, scope, outputShape)
  const outputAdj = new SubShapeMultiIndex<OccShape>()
  for (const face of outputFaces) {
    for (const edge of exploreEdges(oc, scope, face)) outputAdj.add(edge as OccSubShape, face)
  }
  const outputEdges = canonicalEdges(oc, scope, outputShape) as OccShape[]
  for (const inputEdge of canonicalEdges(oc, scope, inputShape) as OccShape[]) {
    const uuid = old.edgeNames.get(inputEdge as OccSubShape)
    if (uuid === undefined) continue
    const pair = inputAdj.get(inputEdge as OccSubShape)
    if (pair.length !== 2) continue
    const [fa, fb] = pair
    const candidates = outputEdges.filter((edge) => {
      const adj = outputAdj.get(edge as OccSubShape)
      if (adj.length < 2) return false
      return adj.some((f) => sameAnalyticSurface(oc, scope, f, fa)) &&
        adj.some((f) => sameAnalyticSurface(oc, scope, f, fb))
    })
    if (candidates.length !== 1) continue
    names.edgeNames.set(candidates[0] as OccSubShape, uuid)
    names.edgeAncestry[uuid] = [...(old.edgeAncestry[uuid] ?? [])]
    const owner = old.edgeOwner?.[uuid]
    if (owner !== undefined) {
      names.edgeOwner ??= {}
      names.edgeOwner[uuid] = owner
    }
  }
}

/**
 * Give the restored sharp edge the UUID the pre-modifier naming gave it: the
 * face-pair rule over the two supports (`deriveEdgeUuid`). The fuse can leave
 * the support on one side split (the wedge's tangent sliver does not always
 * fold), so the output edge may border a sibling piece instead of the support
 * face that kept its UUID. The supports' SURFACES (not the faces) identify the
 * edge, which is the same promise the OCCT route makes: the sharp edge the
 * modifier consumed is now the edge where the two supports meet again.
 */
function nameRestoredEdges(
  oc: OccModule,
  scope: DisposeScope,
  partShape: OccShape,
  names: NewNames,
  old: OldNames,
  pairs: readonly (readonly [OccShape, OccShape])[],
): void {
  if (pairs.length === 0) return
  const faces = exploreFaces(oc, scope, partShape)
  const adjacency = new SubShapeMultiIndex<OccShape>()
  for (const face of faces) {
    for (const edge of exploreEdges(oc, scope, face)) adjacency.add(edge as OccSubShape, face)
  }
  const edgeKeys = new Map<OccSubShape, [number, number, number]>()
  for (const [a, b] of pairs) {
    const ua = old.faceNames.get(a as OccSubShape)
    const ub = old.faceNames.get(b as OccSubShape)
    if (ua === undefined || ub === undefined) continue
    const found: OccSubShape[] = []
    for (const edge of canonicalEdges(oc, scope, partShape) as OccShape[]) {
      const key = edge as OccSubShape
      if (edgeKeys.has(key)) continue
      const adj = adjacency.get(key)
      if (adj.length < 2) continue
      if (!adj.some((f) => sameAnalyticSurface(oc, scope, f, a))) continue
      if (!adj.some((f) => sameAnalyticSurface(oc, scope, f, b))) continue
      edgeKeys.set(key, shapeBndBox(oc, scope, edge).min)
      found.push(key)
    }
    if (found.length === 0) continue
    found.sort((x, y) => {
      const kx = edgeKeys.get(x) as [number, number, number]
      const ky = edgeKeys.get(y) as [number, number, number]
      return kx[0] - ky[0] || kx[1] - ky[1] || kx[2] - ky[2]
    })
    found.forEach((edge, index) => {
      const uuid = deriveEdgeUuid(ua, ub, index)
      names.edgeNames.set(edge, uuid)
      names.edgeAncestry[uuid] = [
        ...new Set([...(old.faceAncestry[ua] ?? []), ...(old.faceAncestry[ub] ?? [])]),
      ]
      const owner = old.edgeOwner?.[uuid] ?? old.faceOwner?.[ua] ?? old.faceOwner?.[ub]
      if (owner !== undefined) {
        names.edgeOwner ??= {}
        names.edgeOwner[uuid] = owner
      }
    })
  }
}

/**
 * Rung 2 for every group rung 1 did not remove: build one wedge per group, then
 * one boolean (all groups must agree on fuse or cut). The validation gate is
 * the plan's: no picked face survives, BRepCheck passes, the solid count is
 * unchanged, and the volume moves by the selected wedge (fuse grows, cut
 * shrinks) within 5% of the wedge volume, which a wrong side or a whole-box
 * prism cannot satisfy. Names transfer through `transferBooleanNames`, keyed on
 * the supports the wedge pieces lie on, and the restored sharp edge is named
 * from the support pair.
 */
function applyWedgeFallback(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  groups: readonly number[][],
  faces: readonly OccShape[],
  rung1Reason: ReadonlyMap<number, string>,
  old: OldNames | null,
): DefeatureResult {
  const fail = (rung2Of: ReadonlyMap<number, string>): DefeatureResult => ({
    shape,
    names: null,
    diff: emptyBrepDiff(),
    failedGroups: groups
      .filter((g) => rung1Reason.has(g[0]))
      .map((g) => ({
        faceIndices: g,
        reason: ladderText(rung1Reason.get(g[0]) ?? REASON_BUILD, rung2Of.get(g[0]) ?? RUNG2_SKIPPED),
      })),
    applied: false,
  })

  const rung2 = new Map<number, string>()
  const plans: { group: number[]; plan: ReturnType<typeof modifierWedge> }[] = []
  for (const g of groups) {
    if (!rung1Reason.has(g[0])) continue
    try {
      plans.push({
        group: g,
        plan: modifierWedge({
          oc,
          scope,
          part: shape,
          groupFaces: g.map((i) => faces[i]),
          ring: neighbourRing(oc, scope, shape, g.map((i) => faces[i])),
        }),
      })
    } catch (e) {
      if (isHeapCorruptionTrap(e)) throw e
      rung2.set(g[0], e instanceof Error ? e.message : String(e))
    }
  }
  if (plans.length === 0) return fail(rung2)

  const actions = new Set(plans.map((p) => p.plan.action))
  if (actions.size > 1) {
    for (const p of plans) rung2.set(p.group[0], `${RUNG_WEDGE}: the call needs both a fuse and a cut; apply the groups as separate features`)
    return fail(rung2)
  }
  if (plans.length < [...rung1Reason.keys()].length) {
    for (const p of plans) {
      rung2.set(p.group[0], `${RUNG_WEDGE}: the wedge was built but not applied because another group in the same call could not be`)
    }
    return fail(rung2)
  }

  const action = [...actions][0]
  const picked = groups.flatMap((g) => g.map((i) => faces[i]))
  const toolVolume = plans.reduce((sum, p) => sum + p.plan.volume, 0)
  const before = volumeOf(oc, scope, shape)
  const tool = compoundOf(oc, scope, plans.map((p) => p.plan.shape))
  const res = booleanWithDiff(oc, scope, shape, tool, action)
  const problems: string[] = []
  // Every picked face must have died in the boolean (a wedge that misses the
  // band leaves the face it was meant to replace).
  if (res.faceOrigin.some((origin) =>
    !origin.fromTool && picked.some((face) => (face as OccSubShape).IsSame(origin.source)))) {
    problems.push('a picked modifier face survived the boolean')
  }
  if (!shapeIsValid(oc, scope, res.shape)) problems.push(REASON_INVALID)
  const beforeSolids = exploreSolids(oc, scope, shape).length
  const afterSolids = exploreSolids(oc, scope, res.shape).length
  if (beforeSolids === 1 && afterSolids !== 1) problems.push(REASON_SPLIT)
  const delta = volumeOf(oc, scope, res.shape) - before
  const signOk = action === 'fuse' ? delta > 0 : delta < 0
  const magnitudeOk = Math.abs(Math.abs(delta) - toolVolume) <= Math.max(0.05 * toolVolume, 1e-6 * Math.abs(before))
  if (!signOk || !magnitudeOk) {
    problems.push(
      `the ${action} changed the volume by ${delta.toFixed(3)} mm3, not ${action === 'fuse' ? 'a growth' : 'a shrink'} ` +
      `of the ${toolVolume.toFixed(3)} mm3 wedge`,
    )
  }
  if (problems.length > 0) {
    scope.track(res.shape)
    const reason = `${RUNG_WEDGE}: ${problems.join('; ')}`
    for (const p of plans) rung2.set(p.group[0], reason)
    return fail(rung2)
  }

  let names: NewNames | null = null
  if (old !== null) {
    const transferred = transferBooleanNames(oc, scope, {
      partShape: res.shape,
      faceOrigin: res.faceOrigin,
      targetFaceNames: old.faceNames,
      targetFaceAncestry: old.faceAncestry,
      targetCapAncestry: old.capAncestry,
      targetFaceOwner: old.faceOwner,
      targetEdgeOwner: old.edgeOwner,
      // The tool's support pieces stay unnamed: giving one the support's UUID
      // would make the surviving support face and the fused strip two children
      // of one UUID, which the transfer treats as a split and re-mints. The
      // fuse's own clean merges the strip into the support, so the support
      // keeps its UUID and the restored sharp edge derives from the pair.
      toolFaceNames: null,
      toolFaceAncestry: null,
      toolCapAncestry: null,
      toolCreatedBy: old.createdBy,
      toolUuidScope: null,
    })
    for (const face of picked) {
      const uuid = old.faceNames.get(face as OccSubShape)
      if (uuid === undefined) continue
      if ([...transferred.faceNames.entries()].some(([, name]) => name === uuid)) {
        for (const p of plans) rung2.set(p.group[0], `${RUNG_WEDGE}: the naming transfer kept a picked modifier face's UUID`)
        return fail(rung2)
      }
    }
    carryEdgeNames(oc, scope, shape, res.shape, transferred, old)
    nameRestoredEdges(
      oc,
      scope,
      res.shape,
      transferred,
      old,
      plans.flatMap((p) => p.plan.restoredPairs),
    )
    names = transferred
  }
  return { shape: res.shape, names, diff: res.diff, failedGroups: [], applied: true }
}

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
  } catch (e) {
    swallowUnlessTrap(e)
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
  // Why each group failed rung 1, keyed by the group's first face index (unique
  // per group); the final reason names the whole ladder from it.
  const rung1Reason = new Map<number, string>()
  const refuse = (): DefeatureResult => ({
    shape,
    names: null,
    diff: emptyBrepDiff(),
    failedGroups: groups
      .filter((g) => rung1Reason.has(g[0]))
      .map((g) => ({
        faceIndices: g,
        reason: ladderText(rung1Reason.get(g[0]) as string, RUNG2_SKIPPED),
      })),
    applied: false,
  })

  // Guard 2: refuse a group whose neighbour ring holds a non-extendable surface
  // BEFORE calling OCC (a B-spline neighbour can hang for a minute). Rung 2 is
  // still offered: the splitter route has no known hang, and it is the answer
  // for a freeform neighbour the extension ladder can continue.
  const viable: number[][] = []
  for (const g of groups) {
    const type = blockedNeighbourType(oc, scope, shape, g.map((i) => faces[i]))
    if (type !== null) {
      rung1Reason.set(
        g[0],
        `${REASON_NEIGHBOUR} (${RUNG_OCCT}: not attempted, the neighbour guard pre-refused the group before OCCT could hang)`,
      )
    } else {
      viable.push(g)
    }
  }
  if (viable.length === 0) {
    return applyWedgeFallback(oc, scope, shape, groups, faces, rung1Reason, old)
  }

  // One call with every viable group's faces. Returns null on IsDone false or a
  // thrown wasm exception (guard 4).
  const build = (gs: readonly number[][]): { maker: OccModifierHistory; built: OccShape } | null => {
    try {
      const maker = scope.track(new oc.BRepAlgoAPI_Defeaturing())
      maker.SetShape(shape)
      for (const g of gs) for (const i of g) maker.AddFaceToRemove(faces[i])
      maker.SetToFillHistory(true)
      maker.Build(noProgress(oc))
      if (!maker.IsDone()) return null
      return { maker, built: scope.track(maker.Shape()) }
    } catch (e) {
      swallowUnlessTrap(e)
      return null
    }
  }

  const first = build(viable)
  if (first === null) {
    for (const g of viable) rung1Reason.set(g[0], REASON_BUILD)
    return applyWedgeFallback(oc, scope, shape, groups, faces, rung1Reason, old)
  }

  // Guard 3: a group succeeds only when every requested face reports IsDeleted.
  const succeeded: number[][] = []
  for (const g of viable) {
    if (g.every((i) => isDeleted(first.maker, faces[i]))) succeeded.push(g)
    else rung1Reason.set(g[0], REASON_GAP)
  }
  if (succeeded.length === 0) {
    scope.release(first.built)
    return applyWedgeFallback(oc, scope, shape, groups, faces, rung1Reason, old)
  }

  // Cross-check a modifier band against the wedge before trusting OCCT: the
  // fixture's smallest plane-sphere case showed defeaturing returning a VALID
  // shape that swallowed the flat cap (volume +654 mm3 where the fillet ring
  // was 8), which no IsDeleted/validity/solid-count guard catches. The wedge is
  // the geometric truth, so rung 1 must move the same volume with the same
  // sign. Only a group whose picks are all non-analytic (a modifier band's
  // B-spline strip; an ordinary hole/pocket pick is not) is cross-checked. A
  // group the wedge cannot build keeps rung 1's own gate.
  const bandPicks = succeeded.length === 1 && succeeded[0].every((i) =>
    !ANALYTIC_SURFACE_TYPES.has(faceSurfaceType(oc, scope, faces[i])))
  if (bandPicks) {
    const only = succeeded[0]
    try {
      const plan = modifierWedge({
        oc,
        scope,
        part: shape,
        groupFaces: only.map((i) => faces[i]),
        ring: neighbourRing(oc, scope, shape, only.map((i) => faces[i])),
      })
      const beforeVolume = volumeOf(oc, scope, shape)
      const delta = volumeOf(oc, scope, first.built) - beforeVolume
      const signOk = plan.action === 'fuse' ? delta > 0 : delta < 0
      const magnitudeOk =
        Math.abs(Math.abs(delta) - plan.volume) <= Math.max(0.05 * plan.volume, 1e-6 * Math.abs(beforeVolume))
      if (!signOk || !magnitudeOk) {
        rung1Reason.set(
          only[0],
          `${REASON_GAP} (${RUNG_OCCT}: returned a valid shape but moved the volume by ${delta.toFixed(3)} mm3, ` +
          `not the ${plan.volume.toFixed(3)} mm3 wedge)`,
        )
        scope.release(first.built)
        return applyWedgeFallback(oc, scope, shape, groups, faces, rung1Reason, old)
      }
    } catch (e) {
      if (isHeapCorruptionTrap(e)) throw e
      // No wedge estimate for this group: the shipped rung-1 gate stands.
    }
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
      for (const g of succeeded) rung1Reason.set(g[0], REASON_BUILD)
      return refuse()
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
    for (const g of succeeded) rung1Reason.set(g[0], REASON_SPLIT)
    return refuse()
  }

  // Guard 5 (heal once if invalid; still invalid -> refuse) moved below the
  // name and diff extraction: the cleanup layer's heal pass carries them onto
  // the healed shape through the fixer's history, so it has to run after they
  // exist.

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
    } catch (e) {
      swallowUnlessTrap(e)
      diff = emptyBrepDiff()
    }
  } catch (e) {
    scope.release(built)
    throw e
  }

  // Groups that rung 1 did not remove report the whole ladder (rung 2 was not
  // attempted: the body had already changed, so the wedge would have to be
  // built and named on the intermediate shape).
  const failedGroups: FailedDefeatureGroup[] = groups
    .filter((g) => rung1Reason.has(g[0]))
    .map((g) => ({
      faceIndices: g,
      reason: ladderText(rung1Reason.get(g[0]) as string, RUNG2_SKIPPED),
    }))

  const cleaned = runCleanup(oc, scope, { shape: built, names, diff }, healOnlyPlan())
  if (passRejected(cleaned, 'heal')) {
    scope.release(built)
    for (const g of succeeded) rung1Reason.set(g[0], REASON_INVALID)
    return refuse()
  }
  if (cleaned.changed) {
    scope.release(built)
    return {
      shape: cleaned.shape,
      names: cleaned.names ?? names,
      diff: cleaned.diff ?? diff,
      failedGroups,
      applied: true,
    }
  }
  return { shape: scope.detach(built), names, diff, failedGroups, applied: true }
}
