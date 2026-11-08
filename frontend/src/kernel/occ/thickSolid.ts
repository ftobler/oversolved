// `applyShellWithLineage`: the OCC adapter the shell leaf (features/shell.ts)
// calls to hollow a solid to a wall thickness with zero or more removed faces.
//
// Call shape and history are pinned by thickSolidProbeReal.test.ts against the
// real OCCT 7.4.0p1 build:
//   - `BRepOffsetAPI_MakeThickSolid.MakeThickSolidByJoin(shape, closingFaces,
//     offset, tol, mode, intersection, selfInter, join, removeIntEdges)` is the
//     9-arg form; OCC offsets along the outward normal, so inward is `-t`.
//   - A KEPT face `Generated()` exactly one face (its offset wall) and survives
//     itself by IsSame; a REMOVED (closing) face `Modified()` into one face (its
//     rim). The naming roles follow from that.
//   - An EMPTY closing list does NOT hollow: MakeThickSolid returns the offset
//     solid. The closed hollow with an internal void is built as
//     `MakeOffsetShape` + a boolean cut, and named through the cut's face
//     origin plus the offset maker's own history.
//
// Names are construction-based, never geometric: a kept face carries its old
// UUID, an offset wall mints `<createdBy>|shell|offset|<sourceFaceUuid>`, a rim
// mints `<createdBy>|shell|rim|<removedFaceUuid>`, and an arc join adds
// `<createdBy>|shell|blend|<sourceEdgeUuid>` and
// `<createdBy>|shell|corner|<incidentEdgeUuids>` for the rounded corner faces.
// Geometry enters only the split ordering when one source yields several images.

import { drainList, type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccModifierHistory } from './occTypes'
import { canonicalFaces, canonicalEdges, canonicalVertices, carryFaceNames } from './bodyNames'
import { SubShapeDedup, SubShapeMap } from './subshapeIdentity'
import { SubShapeIndexMap, faceCentroid } from './primitives'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import { booleanWithDiff } from './booleans'
import { mintFaceUuid, shellFacePath, splitFacePath, orderSplitChildren, type SplitChild, type ShellFaceRole } from '../constructionName'
import {
  builtFaceOf,
  inheritOldFaceNames,
  isValidShape,
  healShape,
  rebaseNames,
  rebaseDiff,
  type OldNames,
  type NewNames,
} from './edgeModifier'
import { nameNeighboursAndDeriveEdges, shapeNormalFrame, normalizedWorldKey, type NormalFrame } from './constructionLineage'
import { swallowUnlessTrap } from '../errors'

type Lineage = Record<string, string[]>

/** The shell direction: inward keeps the outer skin, outward grows the part. */
export type ShellDirection = 'inward' | 'outward'

/** The shell corner treatment: sharp (intersection) or arc (rounded). */
export type ShellJoin = 'sharp' | 'arc'

export interface ShellResult {
  shape: OccShape
  success: boolean
  reason: string | null
  names: NewNames | null
  diff: BrepDiff
  usedJoin?: ShellJoin
}

function fail(shape: OccShape, reason: string): ShellResult {
  return { shape, success: false, reason, names: null, diff: emptyBrepDiff() }
}

/** Every face of a shape the maker returned (a generated shape may be a wire or
 *  a compound, not necessarily the face itself). */
function facesOf(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return canonicalFaces(oc, scope, shape) as OccShape[]
}

/**
 * Mint `<createdBy>|shell|<role>|<sourceKey>` for every image the maker narrates
 * for `sourceItems`. A source may be a face (offset/rim), an edge (blend) or a
 * vertex (corner), so both the key and its ancestry come from `uuidOf` and
 * `ancestryOf`. One image -> the base path; several -> ordered split children.
 * Existing names are never overwritten, so the kept faces inherited first win.
 * `which` selects the history call: a kept face's wall is `Generated`, a
 * removed face's rim is `Modified`.
 */
function mintRoleFaces(
  oc: OccModule,
  scope: DisposeScope,
  maker: OccModifierHistory,
  sourceItems: OccShape[],
  uuidOf: (f: OccShape) => string | undefined,
  which: 'Generated' | 'Modified',
  role: ShellFaceRole,
  createdBy: string,
  builtFace: (f: OccShape) => OccSubShape,
  faceNames: SubShapeMap<string>,
  faceAncestry: Lineage,
  newShape: OccShape,
  ancestryOf: (srcUuid: string) => string[] = () => [],
): void {
  let frame: NormalFrame | null = null
  for (const src of sourceItems) {
    const srcUuid = uuidOf(src)
    if (!srcUuid) continue
    let images: OccShape[]
    try {
      images = drainList(scope, maker[which](src)).flatMap((g) => facesOf(oc, scope, g))
    } catch (e) {
      swallowUnlessTrap(e)
      continue
    }
    if (images.length === 0) continue
    const ancestry = ancestryOf(srcUuid)
    const base = mintFaceUuid(shellFacePath(createdBy, role, srcUuid))
    const assign = (face: OccShape, uuid: string): void => {
      const key = builtFace(face)
      if (faceNames.has(key)) return
      faceNames.set(key, uuid)
      faceAncestry[uuid] = [...ancestry]
    }
    if (images.length === 1) {
      assign(images[0], base)
    } else {
      frame ??= shapeNormalFrame(oc, scope, newShape)
      const f0 = frame
      const ordered = orderSplitChildren(
        images.map<SplitChild<OccShape>>((f) => ({
          item: f,
          key: normalizedWorldKey(f0, faceCentroid(oc, scope, f)),
        })),
      )
      if (ordered !== null) ordered.forEach((f, i) => assign(f, mintFaceUuid(splitFacePath(base, i))))
    }
  }
}

/**
 * A vertex has no UUID, so a corner face minted from one is keyed by the sorted
 * UUIDs of the named edges meeting there: construction-based and stable across
 * rebuilds, with no geometry. Two vertices that would share a key get a
 * deterministic `|m<n>` suffix in canonical vertex order, since one UUID must
 * never name two faces. The corner inherits the union of its edges' ancestry.
 * A vertex with no named adjacent edge stays unnamed and falls to the neighbour
 * pass.
 */
function cornerNames(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
  edgeNames: SubShapeMap<string>,
  edgeAncestry: Lineage,
): { keyOf: (vertex: OccShape) => string | undefined; ancestryOf: (key: string) => string[] } {
  const incident = edges.map((e) => ({
    uuid: edgeNames.get(e as OccSubShape),
    ancestry: edgeAncestry[edgeNames.get(e as OccSubShape) ?? ''] ?? [],
    vertices: canonicalVertices(oc, scope, e) as OccSubShape[],
  }))
  const keys = new SubShapeMap<string>()
  const ancestryOfKey = new Map<string, string[]>()
  const seen = new Map<string, number>()
  for (const vertex of canonicalVertices(oc, scope, shape)) {
    const hits = incident.filter((i) =>
      i.uuid !== undefined && i.vertices.some((v) => v.IsSame(vertex as OccSubShape)))
    if (hits.length === 0) continue
    const base = hits.map((i) => i.uuid as string).sort().join('|')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const key = n === 0 ? base : `${base}|m${n}`
    keys.set(vertex as OccSubShape, key)
    const tokens: string[] = []
    for (const hit of hits) {
      for (const token of hit.ancestry) if (!tokens.includes(token)) tokens.push(token)
    }
    ancestryOfKey.set(key, tokens)
  }
  return {
    keyOf: (vertex) => keys.get(vertex as OccSubShape),
    ancestryOf: (key) => ancestryOfKey.get(key) ?? [],
  }
}

/** Classify the modifier output into a BrepDiff (mirrors `edgeModifierDiff`):
 *  output faces In the preimage pool are inherited, the rest are new. */
function shellDiff(
  oldFaces: OccShape[],
  oldEdges: OccShape[],
  newFaces: OccShape[],
  newEdges: OccShape[],
  removedFaces: OccShape[],
): BrepDiff {
  const diff = emptyBrepDiff()
  const facePool = new SubShapeDedup()
  for (const f of oldFaces) facePool.add(f as OccSubShape)
  for (const f of newFaces) (facePool.has(f as OccSubShape) ? diff.inherited_faces : diff.new_faces).push(f)

  const edgePool = new SubShapeDedup()
  for (const e of oldEdges) edgePool.add(e as OccSubShape)
  for (const e of newEdges) (edgePool.has(e as OccSubShape) ? diff.inherited_edges : diff.new_edges).push(e)

  const removed = new SubShapeDedup()
  for (const f of removedFaces) removed.add(f as OccSubShape)
  for (const f of oldFaces) {
    if (removed.has(f as OccSubShape)) diff.deleted_input_faces.push(f)
    else if (!facePool.has(f as OccSubShape)) diff.modified_input_faces.push(f)
  }
  diff.deleted_input_edges = oldEdges.filter((e) => !edgePool.has(e as OccSubShape))
  return diff
}

/** Names + diff for the closed-hollow fallback: offset maker then boolean cut.
 *
 *  The cut's face origin carries each output face back to its target or tool
 *  input; `carryFaceNames` turns that into UUID identity, with the offset
 *  images' names coming from the offset maker's own history. Leftovers (none on
 *  the analytic cases, but a curved face can split) go to the neighbour pass. */
function applySealedShell(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  thickness: number,
  direction: ShellDirection,
  join: ShellJoin,
  old: OldNames,
  oldFaces: OccShape[],
): ShellResult {
  const sign = direction === 'inward' ? -thickness : thickness
  let off: OccShape | null = null
  let offMaker: OccModifierHistory | null = null
  let lastReason = 'build_not_done'
  const joins = join === 'arc'
    ? [oc.GeomAbs_JoinType.GeomAbs_Arc]
    : [oc.GeomAbs_JoinType.GeomAbs_Intersection, oc.GeomAbs_JoinType.GeomAbs_Arc]
  let usedJoin: ShellJoin = join === 'arc' ? 'arc' : 'sharp'
  for (const j of joins) {
    try {
      const maker = scope.track(new oc.BRepOffsetAPI_MakeOffsetShape_1())
      maker.PerformByJoin(
        shape, sign, 1e-3,
        oc.BRepOffset_Mode.BRepOffset_Skin, false, false, j, false,
      )
      maker.Build()
      if (!maker.IsDone()) {
        lastReason = 'build_not_done'
        continue
      }
      off = scope.track(maker.Shape())
      offMaker = maker
      usedJoin = j === oc.GeomAbs_JoinType.GeomAbs_Arc ? 'arc' : 'sharp'
      break
    } catch (e) {
      swallowUnlessTrap(e)
      lastReason = 'build_failed'
    }
  }
  if (off === null || offMaker === null) return fail(shape, lastReason)

  // Offset images keyed by source face UUID, so the cut origin can name them.
  const offsetUuid: SubShapeMap<string> = new SubShapeMap()
  for (const src of oldFaces) {
    const srcUuid = old.faceNames.get(src as OccSubShape)
    if (!srcUuid) continue
    // The offset maker's history is not guaranteed to narrate every face (see
    // mintRoleFaces): a throw here must leave the face to neighbour naming
    // rather than escaping as a generic kernel exception.
    let images: OccShape[]
    try {
      images = drainList(scope, offMaker.Generated(src)).flatMap((g) => facesOf(oc, scope, g))
    } catch (e) {
      swallowUnlessTrap(e)
      continue
    }
    for (const img of images) offsetUuid.set(img as OccSubShape, srcUuid)
  }
  const offsetNames: SubShapeMap<string> = new SubShapeMap()
  for (const [face, srcUuid] of offsetUuid.entries()) {
    offsetNames.set(face, mintFaceUuid(shellFacePath(old.createdBy, 'offset', srcUuid)))
  }

  // Arc join rounds the offset at the input's edges and vertices, so the maker
  // narrates blend faces from EDGES and corner faces from VERTICES. A sharp
  // build has neither, and probing every sub-shape there would only cost time.
  const offsetFaceAncestry: Lineage = {}
  if (usedJoin === 'arc') {
    const offBuiltFace = builtFaceOf(canonicalFaces(oc, scope, off) as OccShape[])
    const oldEdgesSealed = canonicalEdges(oc, scope, shape) as OccShape[]
    const edgeUuidOfSealed = (e: OccShape): string | undefined => old.edgeNames.get(e as OccSubShape)
    mintRoleFaces(oc, scope, offMaker, oldEdgesSealed, edgeUuidOfSealed, 'Generated', 'blend', old.createdBy, offBuiltFace, offsetNames, offsetFaceAncestry, off, (srcUuid) => old.edgeAncestry[srcUuid] ?? [])

    const oldVerticesSealed = canonicalVertices(oc, scope, shape) as OccShape[]
    const corners = cornerNames(oc, scope, shape, oldEdgesSealed, old.edgeNames, old.edgeAncestry)
    mintRoleFaces(oc, scope, offMaker, oldVerticesSealed, corners.keyOf, 'Generated', 'corner', old.createdBy, offBuiltFace, offsetNames, offsetFaceAncestry, off, corners.ancestryOf)
  }

  // Inward: material between the original skin (target) and the inner void
  // (tool). Outward: between the outer offset (target) and the original skin
  // (tool). Either way the original faces keep their UUIDs.
  const target = direction === 'inward' ? shape : off
  const tool = direction === 'inward' ? off : shape
  let built: OccShape
  let diff: BrepDiff
  let origin: ReturnType<typeof booleanWithDiff>['faceOrigin']
  try {
    const res = booleanWithDiff(oc, scope, target, tool, 'cut')
    built = scope.track(res.shape)
    diff = res.diff
    origin = res.faceOrigin
  } catch (e) {
    swallowUnlessTrap(e)
    return fail(shape, 'build_failed')
  }

  const targetNames = new SubShapeMap<string>()
  const toolNames = new SubShapeMap<string>()
  const apply = (into: SubShapeMap<string>, from: SubShapeMap<string>): void => {
    for (const [face, uuid] of from.entries()) into.set(face, uuid)
  }
  if (direction === 'inward') {
    apply(targetNames, old.faceNames)
    apply(toolNames, offsetNames)
  } else {
    apply(targetNames, offsetNames)
    apply(toolNames, old.faceNames)
  }
  const faceNames = carryFaceNames(origin, targetNames, toolNames)
  // Ancestry for inherited/offset names: each name's tokens come from the
  // source face it was minted or carried from.
  const faceAncestry: Lineage = {}
  for (const [face, uuid] of faceNames.entries()) {
    const srcUuid = offsetUuid.get(face)
    if (offsetFaceAncestry[uuid]) faceAncestry[uuid] = [...offsetFaceAncestry[uuid]]
    else faceAncestry[uuid] = [...(old.faceAncestry[srcUuid ?? uuid] ?? [])]
  }
  const { edgeNames, edgeAncestry } = nameNeighboursAndDeriveEdges(oc, scope, built, faceNames, faceAncestry)
  let names: NewNames = {
    faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry: {},
    faceOwner: old.faceOwner, edgeOwner: old.edgeOwner,
  }
  if (!isValidShape(oc, scope, built)) {
    const heal = healShape(oc, scope, built)
    if (heal === null) {
      scope.release(built)
      return fail(shape, 'the operation produced invalid geometry; try a smaller thickness')
    }
    names = rebaseNames(names, heal.rebase)
    diff = rebaseDiff(diff, heal.rebase)
    scope.release(built)
    built = heal.shape
  }
  // The repaired shape is already detached by healShape; the raw build is
  // scope-tracked, so hand it out untracked either way.
  return { shape: scope.isTracked(built) ? scope.detach(built) : built, success: true, reason: null, names, diff, usedJoin }
}

/**
 * Hollow `shape` to `thickness`, removing `closingFaces` (the openings). Lineage
 * is tracked only when `oldNames` is non-null (the caller passes it when the
 * body carries construction names). Failure returns the UNCHANGED input shape
 * with `success: false`; the caller must not release it (it is scope-owned). A
 * successful result's shape is DETACHED (the caller owns it), matching
 * `applyFilletWithLineage`.
 */
export function applyShellWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  closingFaces: OccShape[],
  thickness: number,
  direction: ShellDirection,
  oldNames: OldNames | null = null,
  join: ShellJoin = 'sharp',
): ShellResult {
  if ((shape as unknown as { IsNull(): boolean }).IsNull()) return fail(shape, 'null_shape')

  const oldFaces = canonicalFaces(oc, scope, shape) as OccShape[]
  const oldEdges = canonicalEdges(oc, scope, shape) as OccShape[]
  if (closingFaces.length === 0) {
    if (oldNames === null) return fail(shape, 'no_names')
    return applySealedShell(oc, scope, shape, thickness, direction, join, oldNames, oldFaces)
  }

  const sign = direction === 'inward' ? -thickness : thickness
  let maker: OccModifierHistory | null = null
  let built: OccShape | null = null
  // OCC's sharp-join offset refuses some shapes whose removed face is bounded
  // by fillets (the key_cap repro: a box with its top edges rounded, then the
  // flat top opened). The same shape offsets with arc joins, which round the
  // inner corners instead of extending the faces. Sharp joins stay first so a
  // normal shell keeps its authored corners; the arc attempt is the fallback
  // only when the sharp build genuinely fails.
  let lastReason = 'build_not_done'
  const joinList = join === 'arc'
    ? [oc.GeomAbs_JoinType.GeomAbs_Arc]
    : [oc.GeomAbs_JoinType.GeomAbs_Intersection, oc.GeomAbs_JoinType.GeomAbs_Arc]
  let usedJoin: ShellJoin = join === 'arc' ? 'arc' : 'sharp'
  for (const j of joinList) {
    try {
      const mk = scope.track(new oc.BRepOffsetAPI_MakeThickSolid_1())
      const list = scope.track(new oc.TopTools_ListOfShape_1())
      for (const f of closingFaces) list.Append_1(f)
      mk.MakeThickSolidByJoin(
        shape, list, sign, 1e-3,
        oc.BRepOffset_Mode.BRepOffset_Skin, false, false, j, false,
      )
      mk.Build()
      if (!mk.IsDone()) {
        lastReason = 'build_not_done'
        continue
      }
      built = scope.track(mk.Shape())
      maker = mk
      usedJoin = j === oc.GeomAbs_JoinType.GeomAbs_Arc ? 'arc' : 'sharp'
      break
    } catch (e) {
      swallowUnlessTrap(e)
      lastReason = 'build_failed'
    }
  }
  if (maker === null || built === null) return fail(shape, lastReason)

  const newFaces = canonicalFaces(oc, scope, built) as OccShape[]
  const newEdges = canonicalEdges(oc, scope, built) as OccShape[]
  let diff = shellDiff(oldFaces, oldEdges, newFaces, newEdges, closingFaces)

  let names: NewNames | null = null
  if (oldNames !== null) {
    const faceNames: SubShapeMap<string> = new SubShapeMap()
    const faceAncestry: Lineage = {}
    const builtFace = builtFaceOf(newFaces)
    const closed = new SubShapeDedup()
    for (const f of closingFaces) closed.add(f as OccSubShape)
    const keptFaces = oldFaces.filter((f) => !closed.has(f as OccSubShape))

    // Kept faces survive by IsSame: their history is empty, so they carry their
    // old UUID verbatim. The removed faces are excluded (their UUID dies with
    // the opening; the rim is a new face named below).
    const keptIdx = new SubShapeIndexMap()
    keptFaces.forEach((f, i) => keptIdx.set(f as OccSubShape, i))
    const keptModified = new Map<number, OccShape[]>()
    for (const f of keptFaces) keptModified.set(keptIdx.get(f as OccSubShape), [])
    inheritOldFaceNames(oc, scope, maker, oldNames, builtFace, faceNames, faceAncestry, keptFaces, keptIdx, keptModified)

    // Offset walls (Generated from a kept face) then rims (Modified from a
    // removed face). The uuidOf map reads the source face's old UUID.
    const uuidOf = (f: OccShape): string | undefined => oldNames.faceNames.get(f as OccSubShape)
    mintRoleFaces(oc, scope, maker, keptFaces, uuidOf, 'Generated', 'offset', oldNames.createdBy, builtFace, faceNames, faceAncestry, built, (srcUuid) => oldNames.faceAncestry[srcUuid] ?? [])
    mintRoleFaces(oc, scope, maker, closingFaces, uuidOf, 'Modified', 'rim', oldNames.createdBy, builtFace, faceNames, faceAncestry, built, (srcUuid) => oldNames.faceAncestry[srcUuid] ?? [])

    // Arc join rounds the offset at the input's edges and vertices, so the maker
    // narrates blend faces from EDGES and corner faces from VERTICES. The
    // offset walls and rims above are the only images a sharp build has.
    if (usedJoin === 'arc') {
      const edgeUuidOf = (e: OccShape): string | undefined => oldNames.edgeNames.get(e as OccSubShape)
      mintRoleFaces(oc, scope, maker, oldEdges, edgeUuidOf, 'Generated', 'blend', oldNames.createdBy, builtFace, faceNames, faceAncestry, built, (srcUuid) => oldNames.edgeAncestry[srcUuid] ?? [])
      const corners = cornerNames(oc, scope, shape, oldEdges, oldNames.edgeNames, oldNames.edgeAncestry)
      mintRoleFaces(oc, scope, maker, canonicalVertices(oc, scope, shape) as OccShape[], corners.keyOf, 'Generated', 'corner', oldNames.createdBy, builtFace, faceNames, faceAncestry, built, corners.ancestryOf)
    }

    const { edgeNames, edgeAncestry } = nameNeighboursAndDeriveEdges(oc, scope, built, faceNames, faceAncestry)
    names = {
      faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry: {},
      faceOwner: oldNames.faceOwner, edgeOwner: oldNames.edgeOwner,
    }
  }

  if (!isValidShape(oc, scope, built)) {
    const heal = healShape(oc, scope, built)
    if (heal === null) {
      scope.release(built)
      return fail(shape, 'the operation produced invalid geometry; try a smaller thickness or fewer removed faces')
    }
    const rebased = names === null ? null : rebaseNames(names, heal.rebase)
    diff = rebaseDiff(diff, heal.rebase)
    scope.release(built)
    return { shape: heal.shape, success: true, reason: null, names: rebased, diff, usedJoin }
  }

  return { shape: scope.detach(built), success: true, reason: null, names, diff, usedJoin }
}
