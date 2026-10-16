// The draft leaf: tilt picked faces of one body about their intersection with a
// neutral plane (OCCT BRepOffsetAPI_DraftAngle), so the part can be pulled from
// a mold. Face resolution is construction-based, through the shared
// resolveFacesByQuery; the neutral plane and the pull direction are resolved
// from picks (a datum plane or planar face for the neutral, an edge/face axis or
// the neutral's own normal for the pull).
//
// The pull direction is oriented FROM the neutral plane INTO the body whatever
// way the pick points, so the sign of `angle` means one thing always: positive
// recedes along the pull direction away from the neutral plane (material comes
// off), negative grows the part. A face the kernel refuses (Add throws, e.g. its
// neutral intersection is ill-defined) is reported in failed_faces and the other
// picks still build; a pick that resolves to no current face is unresolved_faces.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import type { DraftFeature } from '@/types/cad'
import { resolveBody } from './shared/bodyResolution'
import { resplitBody } from './bodySplit'
import { readBodyNames, type UuidArray } from '../occ/bodyNames'
import { SubShapeDedup, type Vec3 } from '../occ/primitives'
import { bodyFrame } from '../occ/tessellation'
import { applyDraftWithLineage, type DraftNeutralPlane } from '../occ/draftAngle'
import { bodyOfQuery, makeFaceIndexCache, resolveFacesByQuery } from './shared/faceResolution'
import { resolveUpToPlane } from './upTo'
import { resolveDirectionQueryStrict } from './shared/directionQuery'

interface DraftResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  // Query strings that matched no current face (a stale pick): re-picking is the
  // fix. Only on a partial result.
  unresolved_faces?: string[]
  // Query strings whose face resolved but the kernel refused to draft: the pick
  // itself is the problem. Only on a partial result.
  failed_faces?: string[]
  exception?: string
}

function named(uuids: UuidArray | undefined): boolean {
  return uuids?.some((u) => u !== null) ?? false
}

/**
 * Solve a draft feature (the generator `KIND_SOLVER.draft` dispatches to). It
 * resolves the target body, its picked faces, the neutral plane and the pull
 * direction, applies the draft, resplits the result and pushes `modified_by`.
 * Throws for the errors the builder turns into an `exception` status: no faces,
 * no neutral plane, a missing body, faces naming several bodies, no face
 * accepted, or a kernel refusal, which leaves the body unchanged.
 */
export function solveDraft(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: DraftFeature,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): DraftResult {
  const featureId = feature.id ?? ''
  const sub = feature.draft ?? {}
  const faces = sub.faces ?? []
  const angle = Number(sub.angle ?? 0)
  const neutralRef = sub.neutral ?? ''
  if (faces.length === 0) throw new Error('draft: at least one face is required')
  if (!Number.isFinite(angle) || angle === 0) throw new Error('draft: angle must be non-zero')
  if (!neutralRef) throw new Error('draft: a neutral plane is required')
  if (Object.keys(bodyStore).length === 0) throw new Error('draft: no bodies in body_store')

  const indexFor = makeFaceIndexCache(oc, scope, table)

  // The one body this feature acts on, from the picks' body tokens or by
  // resolving a face (the same rule the shell uses).
  const ids = new Set<string>()
  for (const q of faces) {
    const bid = bodyOfQuery(oc, scope, table, bodyStore, indexFor, q)
    if (bid !== null) ids.add(bid)
  }
  if (ids.size > 1) {
    throw new Error(`draft: faces name ${ids.size} bodies (${[...ids].join(', ')}); pick faces on one body`)
  }
  if (ids.size === 0) throw new Error('draft: no body resolved from the picked faces')
  const body = resolveBody([...ids][0], bodyStore)
  if (body.shape === null) throw new Error(`draft: body '${body.id}' has no shape`)
  const oldShape = table.get<OccShape>(body.shape)

  // Resolve the neutral plane first: its normal is the pull direction when no
  // axis is picked, and the pull must point from the neutral plane into the
  // body for the angle's sign to mean one thing.
  let neutral: DraftNeutralPlane | null
  try {
    neutral = resolveUpToPlane(oc, scope, table, neutralRef, [0, 0, 1], globalRepo, bodyStore)
  } catch (e) {
    throw new Error(`draft: neutral plane '${neutralRef}': ${e instanceof Error ? e.message : String(e)}`)
  }
  if (neutral === null) throw new Error(`draft: neutral plane '${neutralRef}' did not resolve`)

  const picked = sub.direction ? resolveDirectionQueryStrict(sub.direction, globalRepo, bodyStore) : null
  const candidate: Vec3 = (picked ?? neutral.normal) as Vec3
  const { center } = bodyFrame(oc, scope, oldShape)
  const toBody: Vec3 = [
    center[0] - neutral.origin[0],
    center[1] - neutral.origin[1],
    center[2] - neutral.origin[2],
  ]
  const dot = candidate[0] * toBody[0] + candidate[1] * toBody[1] + candidate[2] * toBody[2]
  const pull: Vec3 = dot >= 0
    ? candidate
    : [-candidate[0], -candidate[1], -candidate[2]]

  const unresolved: string[] = []
  const topoFaces: OccShape[] = []
  const queriesOfFace = new Map<OccShape, string[]>()
  const dedup = new SubShapeDedup()
  const byQuery = resolveFacesByQuery(oc, scope, table, body, indexFor(body), faces, bodyStore)
  for (const q of faces) {
    const face = byQuery.get(q) ?? null
    if (face === null) {
      unresolved.push(q)
      continue
    }
    const list = queriesOfFace.get(face)
    if (list === undefined) queriesOfFace.set(face, [q])
    else list.push(q)
    if (dedup.add(face as OccSubShape)) topoFaces.push(face)
  }
  if (topoFaces.length === 0 && unresolved.length === faces.length) {
    throw new Error(`draft: none of the ${faces.length} picked face(s) resolved`)
  }

  const oldNames = named(body.face_uuids) || named(body.edge_uuids)
    ? { createdBy: featureId, ...readBodyNames(oc, scope, oldShape, body) }
    : null

  const res = applyDraftWithLineage(
    oc, scope, oldShape, topoFaces, angle, pull, neutral, featureId, oldNames,
  )

  // Map the refused faces back to every query that named them; a query already
  // reported unresolved must not be flagged twice.
  const failed: string[] = []
  const resolvedQueries = new Set([...byQuery].filter(([, f]) => f !== null).map(([q]) => q))
  for (const f of res.refused) {
    for (const q of queriesOfFace.get(f) ?? []) {
      if (resolvedQueries.has(q)) failed.push(q)
    }
  }

  if (!res.success) {
    throw new Error(`draft: ${res.reason ?? 'unknown failure'}`)
  }

  const bodyIds = resplitBody(oc, scope, table, bodyStore, body, scope.track(res.shape), featureId, res.names ?? {})
  if (bodyIds.length === 0) throw new Error('draft: the operation removed the whole body')
  body.brep_diff = res.diff
  body.modified_by.push(featureId)

  if (unresolved.length > 0 || failed.length > 0) {
    const parts: string[] = []
    if (unresolved.length > 0) parts.push(`${unresolved.length} face(s) could not be resolved`)
    if (failed.length > 0) parts.push(`${failed.length} face(s) could not be drafted`)
    return {
      status: 'partial',
      body_id: bodyIds[0],
      body_ids: bodyIds,
      unresolved_faces: [...new Set(unresolved)],
      failed_faces: [...new Set(failed)],
      exception: `draft: ${parts.join('; ')}`,
    }
  }
  return { status: 'ok', body_id: bodyIds[0], body_ids: bodyIds }
}
