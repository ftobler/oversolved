import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DB_NAME, STORE_WORKSPACE_META, STORE_WORKSPACE_ORDER } from '@/persistence/idb'
import { IdbWorkspaceStore } from '../store'
import { WORKSPACE_ORDER_KEY, appendWorkspaceOrder, readWorkspaceOrderIds } from '../order'
import { writeWorkspaceMeta } from '../idbCarrier'
import { resetWorkspaceIdb } from './idbHarness'

// Two tabs share one IDB database. An order write must read the workspace rows
// inside the SAME transaction as its read-modify-write of the order record: a
// meta row read beforehand could leave out a workspace another tab just wrote,
// and the next read would "repair" it at the wrong, createdAt-sorted slot.
describe('custom order writes against concurrent library changes', () => {
  beforeEach(resetWorkspaceIdb)

  it('reads the metas inside the order write transaction, not from a stale snapshot', async () => {
    const store = new IdbWorkspaceStore()
    const a = (await store.create('A')).workspace
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    await appendWorkspaceOrder('c')
    // mockRestore clears the call log, so read it before restoring.
    const calls = [...transaction.mock.calls]
    transaction.mockRestore()

    const shared = calls.find(([names]) => {
      const stores = Array.isArray(names) ? names : [names]
      return stores.includes(STORE_WORKSPACE_ORDER) && stores.includes(STORE_WORKSPACE_META)
    })
    expect(shared).toBeDefined()
    expect(await readWorkspaceOrderIds()).toEqual([a, 'c'])
  })

  it('keeps another tab\'s queued order write instead of clobbering it', async () => {
    const store = new IdbWorkspaceStore()
    const a = (await store.create('A')).workspace
    const b = 'b-other-tab'
    await writeWorkspaceMeta({
      workspace: b, name: 'B', createdAt: 200, updatedAt: 200, references: {}, trash: [],
    })

    // A second connection holds a readwrite transaction on the order store.
    // Our append queues behind it, so it must add to the other tab's slot list
    // rather than overwrite the record it read before the queue drained.
    const otherDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const otherTx = otherDb.transaction(STORE_WORKSPACE_ORDER, 'readwrite')
    otherTx.objectStore(STORE_WORKSPACE_ORDER)
      .put({ key: WORKSPACE_ORDER_KEY, ids: [a, b] })
    const pending = appendWorkspaceOrder('c')
    await new Promise<void>((resolve, reject) => {
      otherTx.oncomplete = () => resolve()
      otherTx.onerror = () => reject(otherTx.error)
      otherTx.onabort = () => reject(otherTx.error ?? new Error('other tab write aborted'))
    })
    await pending
    otherDb.close()

    expect(await readWorkspaceOrderIds()).toEqual([a, b, 'c'])
  })

  it('reconciles a workspace written just before the order append', async () => {
    const store = new IdbWorkspaceStore()
    const a = (await store.create('A')).workspace
    const b = 'b-other-tab'
    await writeWorkspaceMeta({
      workspace: b, name: 'B', createdAt: 200, updatedAt: 200, references: {}, trash: [],
    })

    await appendWorkspaceOrder('c')

    // B has no slot yet, so it lands before the new workspace in createdAt
    // order rather than being dropped by the writer's earlier meta snapshot.
    expect(await readWorkspaceOrderIds()).toEqual([a, b, 'c'])
  })
})
