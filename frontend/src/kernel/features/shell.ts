// The shell leaf: hollow a solid to a wall thickness, with zero or more picked
// faces left open. Face resolution is construction-based (never geometry), the
// same tier as fillet/chamfer's edge resolution: resolveFacesByQuery (shared)
// handles the UUID and stable-ancestry tiers. One body per feature; faces that
// name several bodies is an error, like the fillet `source_body` ambiguity.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { resolveBody } from './shared/bodyResolution'
import { resplitBody } from './bodySplit'
import { readBodyNames, type UuidArray } from '../occ/bodyNames'
import { SubShapeDedup } from '../occ/primitives'
import { applyShellWithLineage, type ShellDirection } from '../occ/thickSolid'
import { bodyOfQuery, makeFaceIndexCache, resolveFacesByQuery } from './shared/faceResolution'

type Dict = Record<string, unknown>

interface ShellResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  // Query strings that matched no current face (a stale or deleted pick), so the
  // UI can strike them through: re-picking is the fix. Only on a partial result.
  unresolved_faces?: string[]
  // Query strings whose face resolved but the shell refused them. The shell is a
  // single whole-body operation, so a refusal is a loud exception rather than a
  // per-face failure; the field stays for the shared pick-chip contract.
  failed_faces?: string[]
  exception?: string
}

function named(uuids: UuidArray | undefined): boolean {
  return uuids?.some((u) => u !== null) ?? false
}

/**
 * Solve a shell feature (the generator `KIND_SOLVER.shell` dispatches to). It
 * resolves the target body and its picked faces, applies the shell, resplits
 * the result and pushes `modified_by`. Throws for the errors the builder turns
 * into an `exception` status: no faces and no source_body, faces naming several
 * bodies, a missing body, or a kernel refusal (a thickness past the local
 * radius), which leaves the body unchanged.
 */
export function solveShell(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
): ShellResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.shell as Dict) ?? {}
  const thicknessRaw = sub.thickness
  const thickness = Number(thicknessRaw !== undefined && thicknessRaw !== null ? thicknessRaw : 1)
  if (!Number.isFinite(thickness) || thickness <= 0) throw new Error('shell: thickness must be positive')
  const direction: ShellDirection = sub.direction === 'outward' ? 'outward' : 'inward'
  const faces = (sub.faces as string[]) ?? []
  const sourceBody = (sub.source_body as string) ?? ''
  if (Object.keys(bodyStore).length === 0) throw new Error('shell: no bodies in body_store')
  if (faces.length === 0 && !sourceBody) throw new Error('shell: no faces and no source_body; a closed hollow needs a body')

  const indexFor = makeFaceIndexCache(oc, scope, table)

  // The one body this feature acts on.
  let targetId: string | null = null
  if (sourceBody) {
    targetId = resolveBody(sourceBody, bodyStore).id
  } else {
    const ids = new Set<string>()
    for (const q of faces) {
      const bid = bodyOfQuery(oc, scope, table, bodyStore, indexFor, q)
      if (bid !== null) ids.add(bid)
    }
    if (ids.size > 1) {
      throw new Error(`shell: faces name ${ids.size} bodies (${[...ids].join(', ')}); pick faces on one body`)
    }
    targetId = ids.size === 1 ? [...ids][0] : null
  }
  if (targetId === null) throw new Error('shell: no body resolved from the picked faces')

  const body = resolveBody(targetId, bodyStore)
  if (body.shape === null) throw new Error(`shell: body '${targetId}' has no shape`)
  const oldShape = table.get<OccShape>(body.shape)

  // Resolve the picked faces against this one body; a query that matches nothing
  // is unresolved (struck through), not a solve failure.
  const unresolved: string[] = []
  const topoFaces: OccShape[] = []
  const dedup = new SubShapeDedup()
  const byQuery = resolveFacesByQuery(oc, scope, table, body, indexFor(body), faces, bodyStore)
  for (const q of faces) {
    const face = byQuery.get(q) ?? null
    if (face === null) {
      unresolved.push(q)
      continue
    }
    if (dedup.add(face as OccSubShape)) topoFaces.push(face)
  }
  if (faces.length > 0 && topoFaces.length === 0) {
    throw new Error(`shell: none of the ${faces.length} picked face(s) resolved`)
  }

  const oldNames = named(body.face_uuids) || named(body.edge_uuids)
    ? { createdBy: featureId, ...readBodyNames(oc, scope, oldShape, body) }
    : null

  const res = applyShellWithLineage(oc, scope, oldShape, topoFaces, thickness, direction, oldNames)
  if (!res.success) {
    // The kernel refused: report the reason and leave the body alone. res.shape
    // is the UNCHANGED input, so resplitting it would re-register the same
    // geometry as a fresh handle and report success for a no-op.
    throw new Error(`shell: ${res.reason ?? 'unknown failure'}`)
  }

  const ids = resplitBody(oc, scope, table, bodyStore, body, scope.track(res.shape), featureId, res.names ?? {})
  if (ids.length === 0) throw new Error('shell: the operation removed the whole body')
  body.brep_diff = res.diff
  body.modified_by.push(featureId)

  if (unresolved.length > 0) {
    return {
      status: 'partial',
      body_id: ids[0],
      body_ids: ids,
      unresolved_faces: [...new Set(unresolved)],
      failed_faces: [],
      exception: `shell: ${unresolved.length} face(s) could not be resolved`,
    }
  }
  return { status: 'ok', body_id: ids[0], body_ids: ids }
}
