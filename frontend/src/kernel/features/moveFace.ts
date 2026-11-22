// The move-face leaf: move one or more faces of a solid along their own outward
// normals by a signed distance. The picked faces are a SET, not a sequence: the
// OCC construction (occ/moveFaceTweak.ts) moves every picked surface at once,
// re-intersects the touched edges and vertices, and hands the result to the
// cleanup layer. There is no order sort, no per-pick boolean and no set
// fallback, so the result is a function of the picked set by construction.
//
// A positive distance grows the body (the tweak); a negative one is the
// boundaryless cutter the user asked for: the body is intersected with the
// material half-space of the moved surface, so features away from the pick are
// cut too and a far enough move swallows them.
//
// This leaf resolves the picks by construction UUID, threads the names through
// one face-origin hand-off, resplits the body and attaches the editing handle.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import { type PartSolid } from '../types3d'
import type { Repository } from '../query'
import { resolvePart } from './shared/partResolution'
import { resplitPart } from './partSplit'
import { readPartNames, type ShapeNames } from '../occ/partNames'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { partOfQuery, makeFaceIndexCache, queryFaceUuid, resolveFacesByQuery } from './shared/faceResolution'
import {
  applyMoveFaces,
  faceNormalAndCentroid,
  MoveFaceRefusal,
} from '../occ/moveFaceTweak'
import { transferBooleanNames } from './booleanLineage'
import { linearHandle, type FeatureHandle } from './featureHandles'
import { solveMoveFaceSequential } from './moveFaceSequential'

type Dict = { [key: string]: unknown }

/** The handle's lower clamp: move-face is signed, so the drag must pass through
 *  0 and into the negative without the fillet handle's positive floor. A finite
 *  large negative (never -Infinity, which serialises to null on the wire). */
const MOVE_FACE_HANDLE_MIN = -1e6

interface MoveFaceResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  // Query strings that matched no current face (a stale or consumed pick): the
  // chip strikes them through, re-picking is the fix.
  unresolved_faces?: string[]
  // Query strings whose face resolved but a guard refused it (e.g. no
  // intersection branch near an edge): the geometry is the fix.
  failed_faces?: string[]
  exception?: string
  handle?: FeatureHandle
}

/** A resolved pick, with the query and the live UUID read off the original
 *  body. The UUID is the naming source; a pick that lost its name still moves
 *  (the direct route needs no re-find on an intermediate shape). */
interface ResolvedPick {
  q: string
  face: OccShape
  liveUuid: string | null
}

/**
 * Solve a move-face feature: try the direct tweak first, and fall back to the
 * shipped slab route when the tweak refuses (a same-surface step needs a face
 * the direct route does not mint, or a multi-arc shell it cannot yet rebuild).
 * The direct attempt runs on a scratch copy of the part store, so a refusal
 * never leaves a half-applied body behind.
 */
export function solveMoveFace(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
): MoveFaceResult {
  try {
    return solveMoveFaceDirect(oc, scope, table, feature, globalRepo, partStore)
  } catch (e) {
    // A named move_face failure is the direct route refusing; the class check
    // can fail across a bundler's duplicate module copy, so the message prefix
    // is the reliable signal. "Removes the whole part" is a real outcome, not a
    // refusal to retry: the cut already removed the body.
    const named = (e instanceof Error && e.message.startsWith('move_face:')) || e instanceof MoveFaceRefusal
    if (named && !(e instanceof Error && e.message.includes('removes the whole part'))) {
      return solveMoveFaceSequential(oc, scope, table, feature, globalRepo, partStore)
    }
    throw e
  }
}

/**
 * The direct route: one simultaneous tweak per body. Faces are grouped by
 * owning body and applied once per body with every pick; a distance of 0 is the
 * identity (no `modified_by`, no resplit). Throws for the errors the builder
 * turns into an `exception` status.
 */
function solveMoveFaceDirect(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  partStore: Record<string, PartSolid>,
): MoveFaceResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.move_face as Dict) ?? {}
  const distanceRaw = sub.distance
  const distance = Number(distanceRaw !== undefined && distanceRaw !== null ? distanceRaw : 0)
  if (!Number.isFinite(distance)) throw new Error('move_face: distance must be a finite number')
  const faces = (sub.faces as string[]) ?? []
  if (faces.length === 0) throw new Error('move_face: requires at least one face')
  if (Object.keys(partStore).length === 0) throw new Error('move_face: no parts in body_store')

  const indexFor = makeFaceIndexCache(oc, scope, table)

  // Group picks by owning body, preserving list order within a body.
  const groups = new Map<string, string[]>()
  const unresolved: string[] = []
  for (const q of faces) {
    const bid = partOfQuery(oc, scope, table, partStore, indexFor, q)
    if (bid === null) {
      unresolved.push(q)
      continue
    }
    groups.set(bid, [...(groups.get(bid) ?? []), q])
  }
  if (groups.size === 0) {
    throw new Error(`move_face: none of the ${faces.length} picked face(s) resolved`)
  }

  const failed: string[] = []
  const refusals: string[] = []
  const applied: string[] = []
  let handle: FeatureHandle | null = null
  // The direct construction is pure: nothing is committed until every body's
  // result is built, so a refusal anywhere leaves the store untouched and the
  // compatibility route starts from the original shapes.
  const commits: { part: PartSolid; shape: OccShape; names: ShapeNames; diff: ReturnType<typeof applyMoveFaces>['diff'] }[] = []

  for (const [bid, qlist] of groups) {
    let part: PartSolid
    try {
      part = resolvePart(bid, partStore)
    } catch {
      unresolved.push(...qlist)
      continue
    }
    if (part.shape === null) {
      unresolved.push(...qlist)
      continue
    }
    const oldShape = table.get<OccShape>(part.shape)
    const baseNames: ShapeNames = readPartNames(oc, scope, oldShape, part)
    const picks: ResolvedPick[] = []
    const unresolvedHere: string[] = []
    for (const q of qlist) {
      const face = resolveFacesByQuery(oc, scope, table, part, indexFor(part), [q], partStore).get(q) ?? null
      if (face === null) {
        unresolvedHere.push(q)
        continue
      }
      picks.push({ q, face, liveUuid: baseNames.faceNames.get(face as OccSubShape) ?? null })
    }

    if (distance === 0) {
      unresolved.push(...unresolvedHere)
      if (picks.length > 0) applied.push(part.id)
      continue
    }
    if (picks.length === 0) {
      unresolved.push(...unresolvedHere)
      continue
    }

    // The direct route is the planar face's default. A curved pick still takes
    // the compatibility route: its moved face is proven in isolation (the occ
    // tests), but a downstream fillet on the rebuilt curved wall rejects the
    // face's pcurves, and the shipped slab route keeps the corpus green until
    // that is closed (backlog: direct curved faces, downstream fillet).
    const curved = picks.some((pick) => {
      const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(pick.face, true))
      return adaptor.GetType().value !== oc.GeomAbs_SurfaceType.GeomAbs_Plane.value
    })
    if (curved) {
      throw new MoveFaceRefusal('move_face: a curved pick still takes the compatibility route')
    }

    try {
      const res = applyMoveFaces(
        oc,
        scope,
        oldShape,
        picks.map((pick) => ({ face: pick.face, distance })),
      )
      scope.track(res.shape)
      if (handle === null) {
        const { normal, centroid } = faceNormalAndCentroid(oc, scope, picks[0].face)
        const anchor: [number, number, number] = [
          centroid[0] + normal[0] * distance,
          centroid[1] + normal[1] * distance,
          centroid[2] + normal[2] * distance,
        ]
        handle = linearHandle('distance', anchor, normal, distance, 1, MOVE_FACE_HANDLE_MIN)
      }
      // Inward cutter caps have no original face; the tool face the cut
      // generated carries the pick's UUID.
      const toolFaceNames = new SubShapeMap<string>()
      const toolFaceAncestry: Record<string, string[]> = {}
      for (const [toolFace, pick] of res.toolFacePick.entries()) {
        const owner = picks.find((p) => (p.face as OccSubShape).IsSame(pick.face as OccSubShape))
        const uuid = owner?.liveUuid ?? (owner ? queryFaceUuid(owner.q) : null)
        if (uuid === null) continue
        toolFaceNames.set(toolFace, uuid)
        toolFaceAncestry[uuid] = [...(baseNames.faceAncestry[uuid] ?? [])]
      }
      const names = transferBooleanNames(oc, scope, {
        partShape: res.shape,
        faceOrigin: res.faceOrigin,
        targetFaceNames: baseNames.faceNames,
        targetFaceAncestry: baseNames.faceAncestry,
        targetCapAncestry: baseNames.capAncestry,
        targetFaceOwner: baseNames.faceOwner,
        targetEdgeOwner: baseNames.edgeOwner,
        toolFaceNames: toolFaceNames.size > 0 ? toolFaceNames : null,
        toolFaceAncestry: toolFaceNames.size > 0 ? toolFaceAncestry : null,
        toolCapAncestry: null,
        toolCreatedBy: featureId,
        toolUuidScope: null,
      })
      commits.push({ part, shape: res.shape, names, diff: res.diff })
      unresolved.push(...unresolvedHere)
    } catch (e) {
      if (e instanceof MoveFaceRefusal) {
        failed.push(...picks.map((pick) => pick.q))
        refusals.push(e.message)
        unresolved.push(...unresolvedHere)
        continue
      }
      throw e
    }
  }

  for (const commit of commits) {
    const ids = resplitPart(oc, scope, table, partStore, commit.part, commit.shape, featureId, commit.names)
    if (ids.length === 0) throw new Error('move_face: the move removes the whole part')
    commit.part.brep_diff = commit.diff
    commit.part.modified_by.push(featureId)
    applied.push(...ids)
  }

  if (applied.length === 0) {
    if (refusals.length > 0) throw new Error(refusals.join('; '))
    throw new Error('move_face: no picked face could be applied')
  }

  if (unresolved.length > 0 || failed.length > 0) {
    const parts: string[] = []
    const notApplied = [...new Set([...unresolved, ...failed])]
    if (notApplied.length > 0) parts.push(`${notApplied.length} face(s) could not be applied`)
    parts.push(...refusals)
    return {
      status: 'partial',
      body_id: applied[0],
      body_ids: applied,
      unresolved_faces: [...new Set(unresolved)],
      failed_faces: [...new Set(failed)],
      exception: `move_face: ${parts.join('; ')}`,
      ...(handle !== null && { handle }),
    }
  }
  return { status: 'ok', body_id: applied[0], body_ids: applied, ...(handle !== null && { handle }) }
}
