import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { readWorkspaceOrderIds, writeWorkspaceOrderIds } from '../order'
import { readWorkspaceMeta, writeWorkspaceMeta } from '../idbCarrier'
import { importBag } from '../import'
import { resetWorkspaceIdb } from './idbHarness'
import { STORE_WORKSPACE_ORDER, idbPutTo } from '@/persistence/idb'

// The custom order is a library-level IDB list, not a field on a workspace's
// meta row: a reorder must not touch updatedAt or the Date view's modified time.
describe('custom workspace order', () => {
  beforeEach(resetWorkspaceIdb)

  it('appends every created workspace at the bottom and lists in that order', async () => {
    const store = new IdbWorkspaceStore()
    const a = (await store.create('A')).workspace
    const b = (await store.create('B')).workspace
    const c = (await store.create('C')).workspace
    expect(await readWorkspaceOrderIds()).toEqual([a, b, c])

    const d = (await store.create('D')).workspace
    expect(await readWorkspaceOrderIds()).toEqual([a, b, c, d])
    expect((await store.list({ sort: 'custom' })).map(s => s.workspace)).toEqual([a, b, c, d])
  })

  it('appends an imported and a duplicated workspace at the bottom', async () => {
    const store = new IdbWorkspaceStore()
    const first = (await store.create('First')).workspace
    const imported = await importBag({ items: [{ path: 'Widget.yaml', bytes: new TextEncoder().encode('kind: part\n') }] }, {}, store)
    expect(await readWorkspaceOrderIds()).toEqual([first, imported.workspace])

    const duplicate = (await store.duplicate(first)).workspace
    expect(await readWorkspaceOrderIds()).toEqual([first, imported.workspace, duplicate])
    expect((await store.list({ sort: 'custom' })).map(s => s.workspace)).toEqual([first, imported.workspace, duplicate])
  })

  it('moveWorkspace reorders without touching updatedAt or the Date sort', async () => {
    const store = new IdbWorkspaceStore()
    const a = (await store.create('A')).workspace
    const b = (await store.create('B')).workspace
    const c = (await store.create('C')).workspace
    const before = await Promise.all([a, b, c].map(id => readWorkspaceMeta(id)))

    const dateBefore = (await store.list({ sort: 'modified' })).map(s => s.workspace)
    await store.moveWorkspace(c, 0)

    expect(await readWorkspaceOrderIds()).toEqual([c, a, b])
    expect((await store.list({ sort: 'custom' })).map(s => s.workspace)).toEqual([c, a, b])
    const after = await Promise.all([a, b, c].map(id => readWorkspaceMeta(id)))
    expect(after.map(meta => meta?.updatedAt)).toEqual(before.map(meta => meta?.updatedAt))
    expect((await store.list({ sort: 'modified' })).map(s => s.workspace)).toEqual(dateBefore)
  })

  it('drops stale ids and appends missing workspaces in createdAt order on read', async () => {
    const store = new IdbWorkspaceStore()
    const a = (await store.create('A')).workspace
    const b = (await store.create('B')).workspace
    const c = (await store.create('C')).workspace
    for (const [id, createdAt] of [[a, 100], [b, 200], [c, 300]] as const) {
      const meta = (await readWorkspaceMeta(id))!
      await writeWorkspaceMeta({ ...meta, createdAt })
    }

    await writeWorkspaceOrderIds(['stale', c])
    expect((await store.list({ sort: 'custom' })).map(s => s.workspace)).toEqual([c, a, b])

    // The next write also reconciles, so a new workspace is appended after all
    // the old ones rather than ahead of the ids the record had forgotten.
    const d = (await store.create('D')).workspace
    expect(await readWorkspaceOrderIds()).toEqual([c, a, b, d])
  })

  it('treats a malformed order record as an empty one instead of failing the list', async () => {
    const store = new IdbWorkspaceStore()
    const a = (await store.create('A')).workspace
    await idbPutTo(STORE_WORKSPACE_ORDER, { key: 'workspace_order', ids: 'not a list' })

    expect(await readWorkspaceOrderIds()).toEqual([])
    expect((await store.list({ sort: 'custom' })).map(s => s.workspace)).toEqual([a])
  })

  it('trash and recover keep the slot; permanent delete removes the id', async () => {
    const store = new IdbWorkspaceStore()
    const a = (await store.create('A')).workspace
    const b = (await store.create('B')).workspace
    const c = (await store.create('C')).workspace

    await store.trash(b)
    expect(await readWorkspaceOrderIds()).toEqual([a, b, c])
    expect((await store.list({ sort: 'custom' })).map(s => s.workspace)).toEqual([a, c])

    await store.recover(b)
    expect((await store.list({ sort: 'custom' })).map(s => s.workspace)).toEqual([a, b, c])

    await store.purge(b)
    expect(await readWorkspaceOrderIds()).toEqual([a, c])
  })
})
