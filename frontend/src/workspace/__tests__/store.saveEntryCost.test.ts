import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { STORE_WORKSPACE_ENTRIES } from '@/stores/documentStore/idb'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { resetWorkspaceIdb } from './idbHarness'

const originalPut = IDBObjectStore.prototype.put

// An explicit save is one entry write plus a checkpoint. Re-reading and diffing
// the whole tree to persist nothing new widens the window another tab can
// clobber, so the save path must not take the whole-tree writer at all.
describe('saveEntry cost', () => {
  beforeEach(resetWorkspaceIdb)
  afterEach(() => {
    IDBObjectStore.prototype.put = originalPut
    vi.restoreAllMocks()
  })

  it('writes one entry row and one checkpoint, with no whole-tree re-read', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    const save = vi.spyOn(IdbCarrier.prototype, 'save')
    const open = vi.spyOn(IdbCarrier.prototype, 'open')
    const checkpoint = vi.spyOn(IdbCarrier.prototype, 'checkpoint')

    const puts: string[] = []
    const patched = function (this: IDBObjectStore, ...args: unknown[]) {
      puts.push(this.name)
      return (originalPut as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
    }
    IDBObjectStore.prototype.put = patched as typeof IDBObjectStore.prototype.put
    try {
      await store.saveEntry(workspace, {
        id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v2\n',
      })
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }

    expect(save).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(puts.filter(name => name === STORE_WORKSPACE_ENTRIES)).toEqual([STORE_WORKSPACE_ENTRIES])
    // The checkpoint still lands, so the entry is not left ahead of its save.
    expect((await store.open(workspace)).ahead).toBe(false)
  })

  // A save used to reach the workspace row through the whole-tree write, and
  // that row's updatedAt is the modified time the library tile shows and sorts
  // on. Dropping the whole-tree write must not freeze it. The gestures that
  // adopt the checkpoint stamp it (a save and a bare Keep), and a discard stamps
  // it too, because the recovery reset moves the workspace.
  it('advances the workspace modified time', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    const created = (await store.list())[0]
    await new Promise(resolve => setTimeout(resolve, 2))

    await store.saveEntry(workspace, {
      id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v2\n',
    })

    const [summary] = await store.list()
    expect(summary.updatedAt).toBeGreaterThan(created.updatedAt)
  })

  it('stamps the modified time on a bare Keep and on a discard', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await new Promise(resolve => setTimeout(resolve, 2))
    await store.checkpoint(workspace)
    const kept = (await store.list())[0].updatedAt
    expect(kept).toBeGreaterThan((await store.list())[0].createdAt)

    await new Promise(resolve => setTimeout(resolve, 2))
    await store.discard(workspace)
    expect((await store.list())[0].updatedAt).toBeGreaterThan(kept)
  })
})
