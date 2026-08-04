// Removes one or more bodies from the store. A `?...` query resolves to a body
// (or a dict carrying body_id); otherwise the ref resolves directly. The TS port
// also releases each body's HandleTable handle (Python relies on GC).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { clearBodyAncestry, canonical, ref } from '../query'
import { resolveBodyRefList } from './shared'

type Dict = Record<string, unknown>

interface DeleteBodyResult {
  status: string
  deleted_body_ids: string[]
}

/**
 * Drop every repo entry the deleted body owns. The face/edge/vertex index range
 * dies with the body via `clearBodyAncestry`; the solid is registered under the
 * creating feature's bare tag (builder.ts), never the body tag, so its element
 * sits in the feature's bucket alongside siblings and is removed by body_id.
 */
function clearDeletedBodyAncestry(repo: Repository, body: Body): void {
  clearBodyAncestry(repo, body.id)
  if (!body.created_by) return
  const key = canonical([ref(body.created_by)])
  const entry = repo.ancestral.get(key)
  if (entry === undefined) return
  const doomed = entry.eids.filter((eid) => {
    const el = repo.elements.get(eid)
    return el !== null && typeof el === 'object' && (el as Dict)['body_id'] === body.id
  })
  for (const eid of doomed) repo.deleteElement(eid)
  if (doomed.length) {
    entry.eids = entry.eids.filter((eid) => !doomed.includes(eid))
    if (entry.eids.length === 0) repo.deleteAncestral(key)
  }
}

/** Solve a delete_body feature (mirrors `_solve_delete_body`). */
export function solveDeleteBody(
  _oc: OccModule,
  _scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): DeleteBodyResult {
  const sub = (feature.delete_body as Dict) ?? {}
  const bodyQueries = (sub.bodies as string[]) ?? []

  // Resolves against the intact store before anything is removed, so two picks
  // landing on the same body (different faces) collapse into one deletion
  // instead of letting the second ref fail against an emptied slot.
  const keys = resolveBodyRefList(bodyQueries, globalRepo, bodyStore, 'delete_body')

  for (const bodyKey of keys) {
    const body = bodyStore[bodyKey]
    if (body !== undefined && body.shape !== null) table.release(body.shape)
    if (body !== undefined) clearDeletedBodyAncestry(globalRepo, body)
    delete bodyStore[bodyKey]
  }
  return { status: 'ok', deleted_body_ids: keys }
}
