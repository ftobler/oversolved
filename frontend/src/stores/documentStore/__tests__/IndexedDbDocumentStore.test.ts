import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import { IndexedDbDocumentStore, IndexedDbTrashAdapter } from '../IndexedDbDocumentStore'
import { resetDbConnection } from '../idb'

// IDB-specific behavior only. The shared CRUD / filter / search contract lives
// in contract.test.ts (run against every store); this file covers what is
// unique to the local build: single-user list semantics, modified-time sort,
// and the sync-readiness `meta` envelope the HTTP store does not maintain.

// Each test gets a clean database: swap in a fresh fake IndexedDB factory and
// drop the cached connection so the store reopens against it.
beforeEach(() => {
  resetFakeIndexedDb()
  resetDbConnection()
})

describe('IndexedDbDocumentStore', () => {
  it('shared filter is always empty (single-user model)', async () => {
    const store = new IndexedDbDocumentStore()
    await store.create('Bracket')
    expect(await store.list({ filter: 'shared' })).toEqual([])
  })

  it('sorts newest-first by default and oldest-first for modified_asc', async () => {
    // Pin Date.now to distinct, increasing values so updatedAt never ties
    // (saves within the same real millisecond would otherwise be ambiguous).
    const now = vi.spyOn(Date, 'now')
    const store = new IndexedDbDocumentStore()
    now.mockReturnValue(1000)
    const a = await store.create('Zeta')
    await store.save(a.uuid, { content: '1' })
    now.mockReturnValue(2000)
    const b = await store.create('Alpha')
    await store.save(b.uuid, { content: '2' })  // saved later -> newer

    expect((await store.list()).map(s => s.name)).toEqual(['Alpha', 'Zeta'])
    expect((await store.list({ sort: 'modified_asc' })).map(s => s.name)).toEqual(['Zeta', 'Alpha'])
    now.mockRestore()
  })

  describe('document kind', () => {
    it('records the kind parsed from the content and lists it', async () => {
      const store = new IndexedDbDocumentStore()
      const asm = await store.create('Assembly')
      await store.save(asm.uuid, { content: 'kind: assembly\nfeatures: []\n' })
      const part = await store.create('Part')
      await store.save(part.uuid, { content: 'kind: part\nfeatures: []\n' })

      const byName = Object.fromEntries((await store.list()).map(s => [s.name, s]))
      expect(byName.Assembly.kind).toBe('assembly')
      expect(byName.Part.kind).toBe('part')
    })
  })

  describe('sync-readiness meta', () => {
    it('first save sets rev=1, dirty=true, updatedAt populated', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')  // rev 0
      const before = Date.now()
      await store.save(uuid, { content: 'x' })
      const [summary] = await store.list()
      expect(summary.meta?.rev).toBe(1)
      expect(summary.meta?.dirty).toBe(true)
      expect(summary.meta?.updatedAt).toBeGreaterThanOrEqual(before)
    })

    it('subsequent saves monotonically bump rev and update updatedAt', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      await store.save(uuid, { content: 'a' })
      await store.save(uuid, { content: 'b' })
      await store.save(uuid, { content: 'c' })
      const [summary] = await store.list()
      expect(summary.meta?.rev).toBe(3)
    })

    it('local save never touches baseRev', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      await store.save(uuid, { content: 'a' })
      let [s] = await store.list()
      expect(s.meta?.baseRev).toBeUndefined()
      await store.save(uuid, { content: 'b' })
      ;[s] = await store.list()
      expect(s.meta?.baseRev).toBeUndefined()
    })

    it('list summaries carry meta without loading payloads', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      await store.save(uuid, { content: 'a' })
      const [s] = await store.list()
      expect(s.meta).toMatchObject({ id: uuid, rev: 1, dirty: true })
    })

    it('engine ack (markSynced) clears dirty + sets baseRev; next save re-diverges', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      await store.save(uuid, { content: 'a' })  // rev 1
      await store.markSynced(uuid)
      let [s] = await store.list()
      expect(s.meta?.dirty).toBe(false)
      expect(s.meta?.baseRev).toBe(1)

      await store.save(uuid, { content: 'b' })  // rev 2
      ;[s] = await store.list()
      expect(s.meta?.dirty).toBe(true)
      expect(s.meta?.rev).toBe(2)
      expect(s.meta?.baseRev).toBe(1)  // diverged: rev !== baseRev
    })

    it('a save with identical bytes leaves meta untouched (no rev bump, no re-dirty)', async () => {
      // The app no longer wires this ancestor store; the live no-op-save guard
      // is IdbCarrier.write, pinned at the adapter layer in
      // adapters/__tests__/WorkspaceDocumentAdapter.test.ts. This stays as the
      // ancestor's own regression.
      // meta.rev keys the assembly bundle cache (currentRevs): churning it on
      // a no-op save needlessly invalidates every cached part bundle.
      const now = vi.spyOn(Date, 'now')
      const store = new IndexedDbDocumentStore()
      now.mockReturnValue(1000)
      const { uuid } = await store.create('Doc')
      await store.save(uuid, { content: 'a' })
      await store.markSynced(uuid)  // dirty=false, baseRev=1
      const [before] = await store.list()
      now.mockReturnValue(5000)

      await store.save(uuid, { content: 'a' })

      const [after] = await store.list()
      expect(after.meta?.rev).toBe(before.meta?.rev)
      expect(after.meta?.dirty).toBe(false)  // no spurious push either
      expect(after.meta?.updatedAt).toBe(before.meta?.updatedAt)
      expect(after.updated_at).toBe(before.updated_at)
      now.mockRestore()
    })

    it('thumbnailUrl is null (the view reads the preview store)', () => {
      expect(new IndexedDbDocumentStore().thumbnailUrl('any')).toBeNull()
    })

    it('rename bumps rev + re-flags dirty so a synced doc re-diverges', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      await store.save(uuid, { content: 'a' })  // rev 1
      await store.markSynced(uuid)              // dirty=false, baseRev=1
      await store.rename(uuid, 'Renamed')
      const [s] = await store.list()
      expect(s.name).toBe('Renamed')
      expect(s.meta?.rev).toBe(2)
      expect(s.meta?.dirty).toBe(true)  // a rename is a pushable change
      expect(s.meta?.baseRev).toBe(1)
    })
  })

  describe('local trash (soft delete)', () => {
    it('remove soft-deletes: it leaves the library list but load rejects', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Bracket')
      await store.save(uuid, { content: 'body' })
      await store.remove(uuid)
      expect(await store.list()).toEqual([])
      await expect(store.load(uuid)).rejects.toThrow()
    })

    it('trash lists soft-deleted docs, newest deletion first', async () => {
      const now = vi.spyOn(Date, 'now')
      const store = new IndexedDbDocumentStore()
      const trash = new IndexedDbTrashAdapter()
      const a = await store.create('Older')
      const b = await store.create('Newer')
      now.mockReturnValue(1000)
      await store.remove(a.uuid)
      now.mockReturnValue(2000)
      await store.remove(b.uuid)
      const listed = await trash.list()
      expect(listed.map(d => d.name)).toEqual(['Newer', 'Older'])
      expect(listed[0].owner_username).toBe('local')
      expect(listed[0].deleted_at).not.toBe('')
      now.mockRestore()
    })

    it('recover lifts the tombstone: the doc returns to the library, leaves the trash', async () => {
      const store = new IndexedDbDocumentStore()
      const trash = new IndexedDbTrashAdapter()
      const { uuid } = await store.create('Bracket')
      await store.save(uuid, { content: 'body' })
      await store.remove(uuid)
      await trash.recover(uuid)
      expect((await store.list()).map(s => s.name)).toEqual(['Bracket'])
      expect(await trash.list()).toEqual([])
      expect((await store.load(uuid)).content).toBe('body')  // content preserved through the round trip
    })

    it('purge hard-deletes: gone from both the trash and the library for good', async () => {
      const store = new IndexedDbDocumentStore()
      const trash = new IndexedDbTrashAdapter()
      const { uuid } = await store.create('Bracket')
      await store.remove(uuid)
      await trash.purge(uuid)
      expect(await trash.list()).toEqual([])
      await trash.recover(uuid)  // nothing to recover, a no-op
      expect(await store.list()).toEqual([])
    })

    it('removing an already-trashed doc is a no-op (no second tombstone)', async () => {
      const store = new IndexedDbDocumentStore()
      const trash = new IndexedDbTrashAdapter()
      const { uuid } = await store.create('Bracket')
      await store.remove(uuid)
      const first = (await trash.list())[0].deleted_at
      await store.remove(uuid)
      expect((await trash.list())[0].deleted_at).toBe(first)
    })

    // The other half of the soft delete's write side, and the reason it is
    // pinned here as well as in FileSystemDirectoryStore.test.ts: an editor
    // autosave can land after the grid deleted the document, and the two stores
    // have to agree on what that does. Neither may end up holding two records
    // under one uuid.
    it('a save into a trashed id resurrects the document under the same id', async () => {
      const store = new IndexedDbDocumentStore()
      const trash = new IndexedDbTrashAdapter()
      const { uuid } = await store.create('Bracket')
      await store.save(uuid, { content: 'v1' })
      await store.remove(uuid)
      await store.save(uuid, { content: 'v2' })

      const list = await store.list()
      expect(list.map(d => d.uuid)).toEqual([uuid])
      expect(list.map(d => d.name)).toEqual(['Bracket'])
      expect((await store.load(uuid)).content).toBe('v2')
      expect(await trash.list()).toEqual([])
    })

    it('a rename of a trashed id renames it in place, still trashed', async () => {
      const store = new IndexedDbDocumentStore()
      const trash = new IndexedDbTrashAdapter()
      const { uuid } = await store.create('Bracket')
      await store.remove(uuid)
      await store.rename(uuid, 'Gearbox')
      expect((await trash.list()).map(d => d.name)).toEqual(['Gearbox'])
      expect(await store.list()).toEqual([])
    })

    // duplicate/clone read the raw record, so a tombstoned id would otherwise
    // come back as a live copy: resurrecting a trashed doc behind load()'s and
    // list()'s backs, which both reject/hide trashed records.
    it('duplicate and clone reject a trashed id instead of resurrecting it', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Bracket')
      await store.save(uuid, { content: 'body' })
      await store.remove(uuid)
      await expect(store.duplicate(uuid)).rejects.toThrow(/not found/i)
      await expect(store.clone(uuid)).rejects.toThrow(/not found/i)
      // No live copy may have been created under either call.
      expect(await store.list()).toEqual([])
    })

    it('duplicate rolls back the copy when its save fails (no orphan)', async () => {
      const store = new IndexedDbDocumentStore()
      const a = await store.create('Original')
      await store.save(a.uuid, { content: 'shape' })
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('quota exceeded'))

      await expect(store.duplicate(a.uuid)).rejects.toThrow(/quota/)

      // The created copy must not strand as an empty husk tile next to the
      // original.
      expect(await store.list()).toHaveLength(1)
    })

    it('duplicating a live doc still works alongside the trashed-id rejection', async () => {
      const store = new IndexedDbDocumentStore()
      const live = await store.create('Original')
      await store.save(live.uuid, { content: 'shape' })
      const trashed = await store.create('Trashed')
      await store.remove(trashed.uuid)

      const dup = await store.duplicate(live.uuid)
      expect((await store.load(dup.uuid)).content).toBe('shape')
      expect(await store.list()).toHaveLength(2)  // original + copy; the trashed one stays hidden
    })
  })

  describe('atomic read-modify-write (save/rename/remove/markSynced/recover)', () => {
    // review-09: save/rename/remove/markSynced/recover each read a record then
    // write it back. Done as two separate IndexedDB transactions, a concurrent
    // writer against the same id (another in-flight call, another tab) could
    // put its own record between this read and this write, and this write
    // would then silently clobber it -- a lost update. The fix wraps each
    // read+write in ONE readwrite transaction (idbReadModifyWrite in idb.ts),
    // which IndexedDB serializes against any other transaction on the store.

    it('save opens exactly one readwrite transaction for its read+write', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction')
      await store.save(uuid, { content: 'x' })
      expect(transactionSpy).toHaveBeenCalledTimes(1)
      transactionSpy.mockRestore()
    })

    it('rename opens exactly one readwrite transaction for its read+write', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction')
      await store.rename(uuid, 'Renamed')
      expect(transactionSpy).toHaveBeenCalledTimes(1)
      transactionSpy.mockRestore()
    })

    it('concurrent saves against one doc do not lose an update', async () => {
      // Five overlapping saves, no awaits between them (Promise.all). Each
      // save reads the current rev and writes rev+1; a two-transaction
      // implementation lets the async gap between its read and its write be
      // interleaved by another save's write, landing on a rev below 5.
      // IndexedDB serializes whole readwrite transactions in creation order,
      // so with the single-transaction fix every rev bump is applied in turn.
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      await Promise.all([1, 2, 3, 4, 5].map(n => store.save(uuid, { content: `v${n}` })))
      const [summary] = await store.list()
      expect(summary.meta?.rev).toBe(5)
    })

    it('concurrent renames against one doc do not lose an update', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      await Promise.all(['Alpha', 'Beta', 'Gamma'].map(name => store.rename(uuid, name)))
      const [summary] = await store.list()
      // Three renames -> three rev bumps, none lost to interleaving.
      expect(summary.meta?.rev).toBe(3)
    })

    it('a concurrent save and rename against one doc both apply (neither is lost)', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Doc')
      await Promise.all([
        store.save(uuid, { content: 'body' }),
        store.rename(uuid, 'Renamed'),
      ])
      const [summary] = await store.list()
      const loaded = await store.load(uuid)
      expect(summary.name).toBe('Renamed')
      expect(loaded.content).toBe('body')
      expect(summary.meta?.rev).toBe(2)  // both bumps landed, none clobbered the other
    })
  })

  // Regression: create() must not throw when crypto.randomUUID is absent (plain
  // http, no secure context). The fallback must still mint a valid RFC-4122 v4 uuid.
  describe('uuid generation without crypto.randomUUID', () => {
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

    it('create() produces a valid uuid when crypto.randomUUID is missing', async () => {
      const original = (globalThis.crypto as { randomUUID?: unknown }).randomUUID
      ;(globalThis.crypto as { randomUUID?: unknown }).randomUUID = undefined
      try {
        const store = new IndexedDbDocumentStore()
        const { uuid } = await store.create('LanDoc')
        expect(uuid).toMatch(UUID_V4)
        const [s] = await store.list()
        expect(s.uuid).toBe(uuid)
      } finally {
        ;(globalThis.crypto as { randomUUID?: unknown }).randomUUID = original
      }
    })

    it('duplicate() still works without crypto.randomUUID', async () => {
      const original = (globalThis.crypto as { randomUUID?: unknown }).randomUUID
      ;(globalThis.crypto as { randomUUID?: unknown }).randomUUID = undefined
      try {
        const store = new IndexedDbDocumentStore()
        const { uuid } = await store.create('Src')
        await store.save(uuid, { content: 'hi' })
        const { uuid: copy } = await store.duplicate(uuid)
        expect(copy).toMatch(UUID_V4)
        expect(copy).not.toBe(uuid)
      } finally {
        ;(globalThis.crypto as { randomUUID?: unknown }).randomUUID = original
      }
    })
  })
})
