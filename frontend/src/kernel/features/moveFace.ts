// The move-face leaf: move one or more planar faces of a solid along their own
// outward normals by a signed distance, extending (or trimming) the faces that
// bound them. The OCC construction lives in occ/moveFace.ts; this leaf resolves
// the picks by construction UUID, threads the names through each move, resplits
// the body and attaches the editing handle.
//
// Several faces are applied one after another in list order, each re-found on
// the intermediate shape by its construction UUID (never by index). An earlier
// move that consumes a later face reports that face as failed, not a guess.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { resolveBody } from './shared/bodyResolution'
import { resplitBody } from './bodySplit'
import { readBodyNames, type ShapeNames } from '../occ/bodyNames'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { bodyOfQuery, makeFaceIndexCache, queryFaceUuid, resolveFacesByQuery } from './shared/faceResolution'
import { applyMoveFace, faceNormalAndCentroid, MoveFaceRefusal } from '../occ/moveFace'
import { transferBooleanNames } from './booleanLineage'
import { mintFaceUuid, moveFaceExtendPath } from '../constructionName'
import { linearHandle, type FeatureHandle } from './featureHandles'

type Dict = Record<string, unknown>

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
  // Query strings whose face resolved but a guard refused it (non-planar, a
  // tangent neighbour, an unsupported neighbour, body consumed): the geometry
  // is the fix, re-picking will not help.
  failed_faces?: string[]
  exception?: string
  handle?: FeatureHandle
}

/** UUID -> face for a shape's face names (the mapping `resolveFacesByQuery`
 *  builds on a stored Body, rebuilt here on an intermediate move shape). */
function uuidMap(names: SubShapeMap<string>): Map<string, OccShape> {
  const out = new Map<string, OccShape>()
  for (const [face, uuid] of names.entries()) out.set(uuid, face as OccShape)
  return out
}

/**
 * Solve a move-face feature (the generator `KIND_SOLVER.move_face` dispatches
 * to). Faces are grouped by owning body and applied in list order; a distance
 * of 0 is the identity (no `modified_by`, no resplit). Throws for the errors the
 * builder turns into an `exception` status.
 */
export function solveMoveFace(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
): MoveFaceResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.move_face as Dict) ?? {}
  const distanceRaw = sub.distance
  const distance = Number(distanceRaw !== undefined && distanceRaw !== null ? distanceRaw : 0)
  if (!Number.isFinite(distance)) throw new Error('move_face: distance must be a finite number')
  const faces = (sub.faces as string[]) ?? []
  if (faces.length === 0) throw new Error('move_face: requires at least one face')
  if (Object.keys(bodyStore).length === 0) throw new Error('move_face: no bodies in body_store')

  const indexFor = makeFaceIndexCache(oc, scope, table)

  // Group picks by owning body, preserving list order within a body.
  const groups = new Map<string, string[]>()
  const unresolved: string[] = []
  for (const q of faces) {
    const bid = bodyOfQuery(oc, scope, table, bodyStore, indexFor, q)
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

  for (const [bid, qlist] of groups) {
    let body: Body
    try {
      body = resolveBody(bid, bodyStore)
    } catch {
      unresolved.push(...qlist)
      continue
    }
    if (body.shape === null) {
      unresolved.push(...qlist)
      continue
    }
    const oldShape = table.get<OccShape>(body.shape)
    let currentShape = oldShape
    let currentNames: ShapeNames = readBodyNames(oc, scope, oldShape, body)
    let currentMap = uuidMap(currentNames.faceNames)
    let diff: BrepDiff = emptyBrepDiff()
    let bodyApplied = 0

    for (let i = 0; i < qlist.length; i++) {
      const q = qlist[i]
      const uuid = queryFaceUuid(q)
      let face: OccShape | null = uuid !== null ? (currentMap.get(uuid) ?? null) : null
      // First pick on the body (or one whose UUID the intermediate shape
      // dropped): fall back to the full resolver on the ORIGINAL body, whose
      // stable-ancestry tier can recover a face whose UUID died. Later picks
      // must be found on the CURRENT shape, never a stale original one.
      if (face === null && bodyApplied === 0) {
        face = resolveFacesByQuery(oc, scope, table, body, indexFor(body), [q], bodyStore).get(q) ?? null
      }
      if (face === null) {
        // A later pick the intermediate shape no longer carries: when it still
        // resolves on the ORIGINAL body, an earlier move consumed it (the
        // geometry is the fix, not the pick); otherwise it is a stale pick.
        const existedBefore = bodyApplied > 0 &&
          (resolveFacesByQuery(oc, scope, table, body, indexFor(body), [q], bodyStore).get(q) ?? null) !== null
        if (existedBefore) failed.push(q)
        else unresolved.push(q)
        continue
      }
      if (distance === 0) {
        // The identity: report the pick as satisfied, change nothing.
        bodyApplied++
        continue
      }
      try {
        const res = applyMoveFace(oc, scope, currentShape, face, distance)
        scope.track(res.shape)
        if (handle === null) {
          const { normal, centroid } = faceNormalAndCentroid(oc, scope, face)
          const anchor: [number, number, number] = [
            centroid[0] + normal[0] * distance,
            centroid[1] + normal[1] * distance,
            centroid[2] + normal[2] * distance,
          ]
          handle = linearHandle('distance', anchor, normal, distance, 1, MOVE_FACE_HANDLE_MIN)
        }
        const names = nameMovedFaces(oc, scope, featureId, currentNames, res, uuid)
        currentShape = res.shape
        currentNames = names
        currentMap = uuidMap(names.faceNames)
        diff = res.diff
        bodyApplied++
      } catch (e) {
        if (e instanceof MoveFaceRefusal) {
          failed.push(q)
          refusals.push(e.message)
          continue
        }
        throw e
      }
    }

    if (bodyApplied === 0) continue
    if (distance !== 0) {
      const ids = resplitBody(oc, scope, table, bodyStore, body, currentShape, featureId, currentNames)
      if (ids.length === 0) throw new Error('move_face: the move removes the whole body')
      body.brep_diff = diff
      body.modified_by.push(featureId)
      applied.push(...ids)
    } else {
      applied.push(body.id)
    }
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

/**
 * Rebuild the body's construction names after one move: a cap face on the
 * moved-to plane inherits the moved face's UUID (the moved face is always
 * deleted by the boolean, so exactly one live face claims it, or none when the
 * face vanished); a lateral cell face mints `<featureId>|extend|<neighbourUuid>`.
 * `transferBooleanNames` orders a split cap and derives the edge names.
 */
function nameMovedFaces(
  oc: OccModule,
  scope: DisposeScope,
  featureId: string,
  old: ShapeNames,
  res: ReturnType<typeof applyMoveFace>,
  movedUuid: string | null,
): ShapeNames {
  const toolFaceNames = new SubShapeMap<string>()
  const toolFaceAncestry: Record<string, string[]> = {}
  if (movedUuid !== null) {
    for (const cap of res.cells.capFaces) {
      toolFaceNames.set(cap as OccSubShape, movedUuid)
      toolFaceAncestry[movedUuid] = [...(old.faceAncestry[movedUuid] ?? [])]
    }
  }
  for (const [lateral, neighbour] of res.cells.extensionOf.entries()) {
    const neighbourUuid = old.faceNames.get(neighbour as OccSubShape)
    if (neighbourUuid === undefined) continue
    const name = mintFaceUuid(moveFaceExtendPath(featureId, neighbourUuid))
    toolFaceNames.set(lateral, name)
    toolFaceAncestry[name] = [...(old.faceAncestry[neighbourUuid] ?? [])]
  }
  return transferBooleanNames(oc, scope, {
    bodyShape: res.shape,
    faceOrigin: res.faceOrigin,
    targetFaceNames: old.faceNames,
    targetFaceAncestry: old.faceAncestry,
    toolFaceNames,
    toolFaceAncestry,
    toolUuidScope: null,
  })
}
