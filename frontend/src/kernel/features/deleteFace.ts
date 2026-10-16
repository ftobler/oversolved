// The delete-face leaf: remove picked faces from a solid and heal the gap by
// extending the neighbours' surfaces (OCCT BRepAlgoAPI_Defeaturing). Face
// resolution is construction-based (never geometry), through the shared
// resolveFacesByQuery (UUID tier then stable-ancestry tier). Faces are grouped
// by owning body exactly like fillet/chamfer's edge refs, so a feature may heal
// several bodies independently; a pick that resolves on no body is unresolved.
//
// The group (a connected set of picked faces sharing an edge) is the unit of
// success and failure: OCC removes or refuses a set as a whole, so a refused
// group lists every query of its faces in failed_faces while the other groups
// still apply (status partial). Nothing applied anywhere throws, so a refusal
// never pushes modified_by or touches a body.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { bodyIdOf } from '../query'
import { resolveBody } from './shared/bodyResolution'
import { resplitBody } from './bodySplit'
import { readBodyNames, type UuidArray } from '../occ/bodyNames'
import { SubShapeDedup } from '../occ/primitives'
import { applyDeleteFacesWithLineage } from '../occ/defeature'
import { makeFaceIndexCache, resolveFacesByQuery } from './shared/faceResolution'

type Dict = Record<string, unknown>

interface DeleteFaceResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  // Query strings that matched no current face (a stale or deleted pick), so the
  // UI can strike them through: re-picking is the fix. Only on a partial result.
  unresolved_faces?: string[]
  // Query strings whose face DID resolve but the operator refused (the pick does
  // not form a healable set), so the UI can mark them red: re-picking the whole
  // feature is the fix. Only on a partial result.
  failed_faces?: string[]
  exception?: string
}

function named(uuids: UuidArray | undefined): boolean {
  return uuids?.some((u) => u !== null) ?? false
}

/**
 * Solve a delete_face feature (the generator `KIND_SOLVER.delete_face`
 * dispatches to). It resolves the picked faces against the bodies they name,
 * applies the defeature per body, resplits the result and pushes `modified_by`.
 * Throws for the errors the builder turns into an `exception` status: no faces,
 * no bodies, every pick unresolved, or a refusal on every group (which leaves
 * every body untouched).
 */
export function solveDeleteFace(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
): DeleteFaceResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.delete_face as Dict) ?? {}
  const merged: Dict = { ...sub, ...feature }
  const faces = (merged.faces as string[]) ?? []
  if (faces.length === 0) throw new Error('delete_face: requires at least one face')
  if (Object.keys(bodyStore).length === 0) throw new Error('delete_face: no bodies in body_store')

  const indexFor = makeFaceIndexCache(oc, scope, table)
  const contains = (bid: string, q: string): boolean => {
    const body = bodyStore[bid]
    if (body === undefined || body.shape === null) return false
    return resolveFacesByQuery(oc, scope, table, body, indexFor(body), [q], bodyStore).get(q) != null
  }

  // Group the queries by the body each names, exactly like applyEdgeFeature.
  const groups = new Map<string, string[]>()
  const unresolved: string[] = []
  for (const q of faces) {
    let namedBody = bodyIdOf(q, bodyStore)
    const isDefault = namedBody === null && Object.keys(bodyStore).length === 1
    if (isDefault) namedBody = Object.keys(bodyStore)[0]
    let target: string | null = null
    if (namedBody && namedBody in bodyStore && contains(namedBody, q)) {
      target = namedBody
    } else {
      for (const bid of Object.keys(bodyStore)) {
        if (bid !== namedBody && contains(bid, q)) {
          target = bid
          break
        }
      }
    }
    if (target === null && namedBody !== null && namedBody in bodyStore && !isDefault) target = namedBody
    if (target === null) {
      unresolved.push(q)
      continue
    }
    groups.set(target, [...(groups.get(target) ?? []), q])
  }

  const applied: string[] = []
  const failed: string[] = []
  const modifierFailures: string[] = []
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

    const byQuery = resolveFacesByQuery(oc, scope, table, body, indexFor(body), qlist, bodyStore)
    const topoFaces: OccShape[] = []
    const dedup = new SubShapeDedup()
    // face -> EVERY query that named it, so a face named twice (a duplicate pick
    // in different forms) still reports both queries when its group is refused.
    const queriesOfFace = new Map<OccShape, string[]>()
    const resolvedQueries = new Set<string>()
    for (const [q, face] of byQuery) {
      if (face === null) {
        unresolved.push(q)
        continue
      }
      resolvedQueries.add(q)
      const list = queriesOfFace.get(face)
      if (list === undefined) queriesOfFace.set(face, [q])
      else list.push(q)
      if (dedup.add(face as OccSubShape)) topoFaces.push(face)
    }
    if (topoFaces.length === 0) continue

    const oldNames = named(body.face_uuids) || named(body.edge_uuids)
      ? { createdBy: featureId, ...readBodyNames(oc, scope, oldShape, body) }
      : null

    const res = applyDeleteFacesWithLineage(oc, scope, oldShape, topoFaces, oldNames)

    // Map each refused group back to the queries that named its faces; only a
    // query whose face DID resolve counts as failed (an unresolved query is
    // already in `unresolved` and must not be flagged twice). Every naming query
    // is pushed, so a duplicate pick cannot escape failed_faces.
    const markFailed = (): void => {
      for (const g of res.failedGroups) {
        for (const i of g.faceIndices) {
          for (const q of queriesOfFace.get(topoFaces[i]) ?? []) {
            if (resolvedQueries.has(q)) failed.push(q)
          }
        }
      }
    }

    if (!res.applied) {
      markFailed()
      modifierFailures.push(`${bid}: ${res.failedGroups[0]?.reason ?? 'unknown failure'}`)
      continue
    }

    markFailed()
    const ids = resplitBody(oc, scope, table, bodyStore, body, scope.track(res.shape), featureId, res.names ?? {})
    if (ids.length === 0) {
      // Defeaturing cannot consume its whole body, so this is defensive: the
      // resplit deleted the body and the applied count must not grow from a body
      // that no longer exists.
      modifierFailures.push(`${bid}: the operation removed the whole body`)
      continue
    }
    applied.push(...ids)
    body.brep_diff = res.diff
    body.modified_by.push(featureId)
  }

  if (applied.length === 0 && modifierFailures.length > 0) {
    // Nothing was applied because the kernel refused every group: a loud
    // exception (the builder wraps it into status 'exception') beats a green
    // feature that changed nothing.
    throw new Error(`delete_face: ${modifierFailures.join('; ')}`)
  }
  if (applied.length === 0) throw new Error('delete_face: no faces resolved')

  if (unresolved.length > 0 || failed.length > 0 || modifierFailures.length > 0) {
    const parts: string[] = []
    if (unresolved.length > 0) parts.push(`${unresolved.length} face(s) could not be resolved`)
    if (failed.length > 0) parts.push(`${failed.length} face(s) could not be applied`)
    parts.push(...modifierFailures)
    return {
      status: 'partial',
      body_id: applied[0],
      body_ids: applied,
      unresolved_faces: [...new Set(unresolved)],
      failed_faces: [...new Set(failed)],
      exception: `delete_face: ${parts.join('; ')}`,
    }
  }
  return { status: 'ok', body_id: applied[0], body_ids: applied }
}
