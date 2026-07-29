// Removes one or more bodies from the store. A `?...` query resolves to a body
// (or a dict carrying body_id); otherwise the ref resolves directly. The TS port
// also releases each body's HandleTable handle (Python relies on GC).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { resolveBodyRefList } from './shared'

type Dict = Record<string, unknown>

interface DeleteBodyResult {
  status: string
  deleted_body_ids: string[]
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
    delete bodyStore[bodyKey]
  }
  return { status: 'ok', deleted_body_ids: keys }
}
