// The library's custom tile order: one IDB row, not a rank on each workspace.
// Keeping it separate makes a move one write and leaves the meta rows (and their
// updatedAt, which the Date view sorts on) exactly as they were.
//
// The stored list is allowed to be imperfect. A workspace can be created by an
// older build, imported by a path that forgot to append, or purged in another
// tab; readers reconcile against the meta rows every time instead of demanding
// a migration. Writers reconcile too, so a newly created workspace really is
// the last tile even when the record had forgotten older ones.
import {
  STORE_WORKSPACE_META,
  STORE_WORKSPACE_ORDER,
  idbGetFrom,
  idbPutTo,
  idbTransaction,
} from '@/persistence/idb'
import type { WorkspaceMetaRecord } from './idbCarrier'

export const WORKSPACE_ORDER_KEY = 'workspace_order'

export interface WorkspaceOrderRecord {
  key: typeof WORKSPACE_ORDER_KEY
  ids: string[]
}

// Only identity and creation time matter here. `trashedAt` is deliberately not
// consulted: a trashed workspace keeps its slot so a restore puts it back.
export interface OrderedMeta {
  workspace: string
  createdAt: number
  trashedAt?: string
}

export function resolveCustomOrder(
  stored: readonly string[],
  metas: ReadonlyArray<OrderedMeta>,
): string[] {
  const present = new Map(metas.map(meta => [meta.workspace, meta]))
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of stored) {
    if (!present.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  // A missing workspace lands after every known one, oldest first. The id is
  // the tie-break for two metas stamped in the same millisecond, so the result
  // never depends on IndexedDB's read order.
  const missing = metas
    .filter(meta => !seen.has(meta.workspace))
    .sort((a, b) => a.createdAt - b.createdAt || (a.workspace < b.workspace ? -1 : a.workspace > b.workspace ? 1 : 0))
  for (const meta of missing) out.push(meta.workspace)
  return out
}

// The one reorder rule: remove the workspace, then insert it at the target
// slot. `toIndex` is an index into the list with the dragged id removed, which
// is exactly what a tile drop computes.
export function moveInOrder(ids: readonly string[], workspace: string, toIndex: number): string[] {
  const from = ids.indexOf(workspace)
  if (from < 0) return [...ids]
  const rest = ids.filter(id => id !== workspace)
  const at = Math.max(0, Math.min(rest.length, toIndex))
  rest.splice(at, 0, workspace)
  return rest
}

// A hand-edited or half-written record can carry anything under `ids`. It is
// read through the same tolerance as the workspace ids themselves: a malformed
// value is an empty order, not a page that refuses to list its libraries.
function storedIds(record: WorkspaceOrderRecord | undefined): string[] {
  if (!record || !Array.isArray(record.ids)) return []
  return record.ids.filter(id => typeof id === 'string')
}

export async function readWorkspaceOrderIds(): Promise<string[]> {
  const record = await idbGetFrom<WorkspaceOrderRecord>(STORE_WORKSPACE_ORDER, WORKSPACE_ORDER_KEY)
  return storedIds(record)
}

export async function writeWorkspaceOrderIds(ids: string[]): Promise<void> {
  await idbPutTo<WorkspaceOrderRecord>(STORE_WORKSPACE_ORDER, { key: WORKSPACE_ORDER_KEY, ids: [...ids] })
}

// One transaction holds both reads and the write. A meta snapshot taken before
// the transaction could omit a workspace another tab created in between, and
// reconciling against it would drop that id from the order; reading the rows
// inside the same transaction keeps the two answers consistent.
async function editOrder(edit: (ids: string[]) => string[]): Promise<void> {
  await idbTransaction(
    [STORE_WORKSPACE_ORDER, STORE_WORKSPACE_META],
    'readwrite',
    stores => {
      const orderStore = stores[STORE_WORKSPACE_ORDER]
      let record: WorkspaceOrderRecord | undefined
      let metas: WorkspaceMetaRecord[] = []
      let recordReady = false
      let metasReady = false
      const apply = () => {
        if (!recordReady || !metasReady) return
        const raw = storedIds(record)
        const ids = edit(resolveCustomOrder(raw, metas))
        // An import that joins a workspace must not churn the order store when
        // the record already says exactly what the edit produces.
        if (!record || !sameIds(raw, ids)) orderStore.put({ key: WORKSPACE_ORDER_KEY, ids })
      }
      const orderRequest = orderStore.get(WORKSPACE_ORDER_KEY) as IDBRequest<WorkspaceOrderRecord | undefined>
      orderRequest.onsuccess = () => {
        record = orderRequest.result
        recordReady = true
        apply()
      }
      // getAll and get are queued in one transaction; apply() runs from the
      // second success handler, while the transaction is still alive, so its
      // put is part of the same atomic unit.
      const metaRequest = stores[STORE_WORKSPACE_META].getAll() as IDBRequest<WorkspaceMetaRecord[]>
      metaRequest.onsuccess = () => {
        metas = metaRequest.result
        metasReady = true
        apply()
      }
    },
  )
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export async function appendWorkspaceOrder(workspace: string): Promise<void> {
  await editOrder(ids => [...ids.filter(id => id !== workspace), workspace])
}

export async function removeWorkspaceOrder(workspace: string): Promise<void> {
  await editOrder(ids => ids.filter(id => id !== workspace))
}

export async function moveWorkspaceOrder(workspace: string, toIndex: number): Promise<void> {
  await editOrder(ids => moveInOrder(ids, workspace, toIndex))
}
