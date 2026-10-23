// The move-face leaf: move one or more faces of a solid along their own outward
// normals by a signed distance, extending (or trimming) the faces that bound
// them. A face may sit on a plane, cylinder, cone, sphere or torus (the
// analytic kinds); a freeform face is refused by name. The OCC construction
// lives in occ/moveFace.ts (with the per-surface descriptors in
// occ/moveFaceSurfaces.ts); this leaf resolves the picks by construction UUID,
// threads the names through each move, resplits the body and attaches the
// editing handle.
//
// Several faces are applied one after another in list order, each re-found on
// the intermediate shape by its construction UUID (never by index). An earlier
// move that consumes a later face reports that face as failed, not a guess.
// A group the intermediate shape refuses (a neighbour surface an earlier move
// left unable to cross the next slab), or one with a pick whose UUID is not
// live (a pre-split document), is applied with every slab selected on the
// original body in one boolean, which depends on the picked set rather than the
// list order.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import { emptyBrepDiff, type Body } from '../types3d'
import type { Repository } from '../query'
import { resolveBody } from './shared/bodyResolution'
import { resplitBody } from './bodySplit'
import { readBodyNames, type ShapeNames } from '../occ/bodyNames'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { bodyOfQuery, makeFaceIndexCache, queryFaceUuid, resolveFacesByQuery } from './shared/faceResolution'
import {
  applyMoveFace,
  combineMoveFaceCells,
  faceNormalAndCentroid,
  moveFaceCells,
  MoveFaceRefusal,
  type MoveFaceCells,
} from '../occ/moveFace'
import { BooleanSoundnessError, type FaceOrigin } from '../occ/booleans'
import { transferBooleanNames } from './booleanLineage'
import { mintFaceUuid, moveFaceExtendPath, moveFaceSetExtendPath } from '../constructionName'
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
  // Query strings whose face resolved but a guard refused it (an unsupported
  // surface, a tangent neighbour, an unbounded face, body consumed): the
  // geometry is the fix, re-picking will not help.
  failed_faces?: string[]
  exception?: string
  handle?: FeatureHandle
}

/** A resolved pick with its cells selected on the original body shape. */
interface AppliedPick {
  uuid: string | null
  face: OccShape
  cells: MoveFaceCells
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
 * to). Faces are grouped by owning body and applied in list order, with the
 * one-boolean set path described above; a distance of 0 is the identity (no
 * `modified_by`, no resplit). Throws for the errors the builder turns into an
 * `exception` status.
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
    const baseNames: ShapeNames = readBodyNames(oc, scope, oldShape, body)
    const baseMap = uuidMap(baseNames.faceNames)
    // A pick that names no live UUID (a document stored before split prism side
    // faces got their own UUIDs) cannot be re-found on the intermediate shape.
    // Apply the group as a set on the original body, where the resolver's
    // stable-ancestry migration separates the dead picks by their classifiers.
    const needsSet = qlist.some((q) => {
      const uuid = queryFaceUuid(q)
      return uuid === null || !baseMap.has(uuid)
    })
    let currentShape = oldShape
    let currentNames = baseNames
    let currentMap = baseMap
    let diff = emptyBrepDiff()
    let bodyApplied = 0
    // A refusal on the intermediate shape is retried once with every pick
    // selected against the original body and applied in one boolean. Sequential
    // moves can leave a neighbour surface that no longer crosses the next slab
    // (moving one of two adjacent curved faces first), while the set operation
    // depends only on the picked faces.
    let refusedHere = false
    const groupFailed: string[] = []
    const groupRefusals: string[] = []

    if (!needsSet) {
      for (const q of qlist) {
        const uuid = queryFaceUuid(q)
        let face: OccShape | null = uuid !== null ? (currentMap.get(uuid) ?? null) : null
        // First pick (or one whose UUID the intermediate shape dropped): the
        // full resolver on the ORIGINAL body can recover a face whose UUID
        // died. Later picks must be found on the CURRENT shape, never a stale
        // original one.
        if (face === null && bodyApplied === 0) {
          face = resolveFacesByQuery(oc, scope, table, body, indexFor(body), [q], bodyStore).get(q) ?? null
        }
        if (face === null) {
          // A later pick the intermediate shape no longer carries: when it
          // still resolves on the ORIGINAL body, an earlier move consumed it
          // (the geometry is the fix, not the pick); otherwise it is stale.
          const existedBefore = bodyApplied > 0 &&
            (resolveFacesByQuery(oc, scope, table, body, indexFor(body), [q], bodyStore).get(q) ?? null) !== null
          if (existedBefore) groupFailed.push(q)
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
          const movedUuid = currentNames.faceNames.get(face as OccSubShape) ?? uuid
          currentNames = nameMovedFaces(oc, scope, featureId, currentNames, res, [{ uuid: movedUuid, cells: res.cells }])
          currentShape = res.shape
          currentMap = uuidMap(currentNames.faceNames)
          diff = res.diff
          bodyApplied++
        } catch (e) {
          // An unsound boolean on the intermediate shape is the same signal as
          // a refusal: the sequential order cannot be trusted, so retry the
          // group as one set on the original body.
          if (e instanceof MoveFaceRefusal || e instanceof BooleanSoundnessError) {
            refusedHere = true
            groupFailed.push(q)
            groupRefusals.push(e.message)
            continue
          }
          throw e
        }
      }
    }

    if (needsSet && distance === 0) {
      // The identity still reports stale picks, but the dead UUID is only
      // resolved (never applied), so the ancestry migration runs here.
      for (const q of qlist) {
        const face = resolveFacesByQuery(oc, scope, table, body, indexFor(body), [q], bodyStore).get(q) ?? null
        if (face === null) unresolved.push(q)
        else bodyApplied++
      }
    }

    let committed = false
    if ((refusedHere || needsSet) && distance !== 0) {
      const setPicks: AppliedPick[] = []
      const setFailed: string[] = []
      const setRefusals: string[] = []
      for (const q of qlist) {
        const face = resolveFacesByQuery(oc, scope, table, body, indexFor(body), [q], bodyStore).get(q) ?? null
        if (face === null) {
          unresolved.push(q)
          continue
        }
        const uuid = baseNames.faceNames.get(face as OccSubShape) ?? queryFaceUuid(q)
        try {
          setPicks.push({ uuid, face, cells: moveFaceCells(oc, scope, oldShape, face, distance) })
        } catch (e) {
          if (e instanceof MoveFaceRefusal) {
            setFailed.push(q)
            setRefusals.push(e.message)
            continue
          }
          throw e
        }
      }
      if (setPicks.length > 0) {
        const set = combineMoveFaceCells(oc, scope, oldShape, setPicks, distance)
        scope.track(set.shape)
        if (handle === null) {
          const { normal, centroid } = faceNormalAndCentroid(oc, scope, setPicks[0].face)
          const anchor: [number, number, number] = [
            centroid[0] + normal[0] * distance,
            centroid[1] + normal[1] * distance,
            centroid[2] + normal[2] * distance,
          ]
          handle = linearHandle('distance', anchor, normal, distance, 1, MOVE_FACE_HANDLE_MIN)
        }
        const names = nameMovedFaces(oc, scope, featureId, baseNames, set, setPicks)
        const ids = resplitBody(oc, scope, table, bodyStore, body, set.shape, featureId, names)
        if (ids.length === 0) throw new Error('move_face: the move removes the whole body')
        body.brep_diff = set.diff
        body.modified_by.push(featureId)
        applied.push(...ids)
        groupFailed.length = 0
        groupRefusals.length = 0
        groupFailed.push(...setFailed)
        groupRefusals.push(...setRefusals)
        committed = true
      }
    }

    if (!committed) {
      if (bodyApplied === 0) {
        failed.push(...groupFailed)
        refusals.push(...groupRefusals)
        continue
      }
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
    failed.push(...groupFailed)
    refusals.push(...groupRefusals)
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
 * Rebuild the body's construction names after the move: a cap face on a
 * moved-to surface inherits that pick's UUID (a moved face is always deleted by
 * the boolean, so exactly one live face claims it, or none when the face
 * vanished); a lateral cell face mints `<featureId>|extend|<neighbourUuid>`,
 * with a per-pick suffix when one boolean carries several picks.
 * `transferBooleanNames` orders a split cap and derives the edge names.
 */
function nameMovedFaces(
  oc: OccModule,
  scope: DisposeScope,
  featureId: string,
  old: ShapeNames,
  res: { shape: OccShape; faceOrigin: FaceOrigin[] },
  picks: Pick<AppliedPick, 'uuid' | 'cells'>[],
): ShapeNames {
  const toolFaceNames = new SubShapeMap<string>()
  const toolFaceAncestry: Record<string, string[]> = {}
  for (const [pickIndex, pick] of picks.entries()) {
    if (pick.uuid !== null) {
      for (const cap of pick.cells.capFaces) {
        toolFaceNames.set(cap as OccSubShape, pick.uuid)
        toolFaceAncestry[pick.uuid] = [...(old.faceAncestry[pick.uuid] ?? [])]
      }
    }
    for (const [lateral, neighbour] of pick.cells.extensionOf.entries()) {
      const neighbourUuid = old.faceNames.get(neighbour as OccSubShape)
      if (neighbourUuid === undefined) continue
      // Several picks in one boolean can extend the SAME neighbour. A per-pick
      // suffix keeps each moved face's extend name its own; a single-pick move
      // keeps the shipped name byte-identical.
      const path = picks.length > 1
        ? moveFaceSetExtendPath(featureId, neighbourUuid, pickIndex)
        : moveFaceExtendPath(featureId, neighbourUuid)
      const name = mintFaceUuid(path)
      toolFaceNames.set(lateral, name)
      toolFaceAncestry[name] = [...(old.faceAncestry[neighbourUuid] ?? [])]
    }
  }
  return transferBooleanNames(oc, scope, {
    bodyShape: res.shape,
    faceOrigin: res.faceOrigin,
    targetFaceNames: old.faceNames,
    targetFaceAncestry: old.faceAncestry,
    targetCapAncestry: old.capAncestry,
    toolFaceNames,
    toolFaceAncestry,
    toolCapAncestry: null,
    toolUuidScope: null,
  })
}
