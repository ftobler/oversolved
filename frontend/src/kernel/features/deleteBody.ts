// Removes a body from the store. A `?...` query resolves to a body (or a dict carrying
// body_id); otherwise the ref resolves directly. The TS port also releases the body's
// HandleTable handle (Python relies on GC).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { resolveBody } from './shared'

type Dict = Record<string, unknown>

interface DeleteBodyResult {
  status: string
  deleted_body_id: string
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
  const bodyQuery = (sub.body as string) ?? ''

  let bodyKey: string
  if (bodyQuery.startsWith('?')) {
    const resolved = globalRepo.query(bodyQuery, null, bodyStore) as Dict | null
    if (resolved === null) throw new Error(`delete_body: body not found: ${JSON.stringify(bodyQuery)}`)
    // A resolved Body carries created_by + id; a geometry dict carries body_id.
    if ('created_by' in resolved && typeof resolved.id === 'string') {
      bodyKey = resolved.id
    } else if (resolved.body_id) {
      bodyKey = String(resolved.body_id)
    } else {
      throw new Error(`delete_body: query did not resolve to a body: ${JSON.stringify(bodyQuery)}`)
    }
  } else {
    bodyKey = resolveBody(bodyQuery, bodyStore).id
  }

  const body = bodyStore[bodyKey]
  if (body !== undefined && body.shape !== null) table.release(body.shape)
  delete bodyStore[bodyKey]
  return { status: 'ok', deleted_body_id: bodyKey }
}
