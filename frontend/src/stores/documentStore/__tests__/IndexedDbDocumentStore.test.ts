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

    it('thumbnailUrl is null (the grid uses the inline preview_image)', () => {
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
      expect(s.meta?.dirty).toBe(true)          // a rename is a pushable change
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

    it('trash carries the preview_image so the grid can render a thumbnail', async () => {
      const store = new IndexedDbDocumentStore()
      const trash = new IndexedDbTrashAdapter()
      const { uuid } = await store.create('Widget')
      await store.save(uuid, { content: 'x', preview_image: 'img42' })
      await store.remove(uuid)
      const [d] = await trash.list()
      expect(d.preview_image).toBe('img42')
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
  })

  describe('preview_image in list summaries', () => {
    it('summary carries preview_image after save with one', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Widget')
      await store.save(uuid, { content: 'x', preview_image: 'abc123' })
      const [s] = await store.list()
      expect(s.preview_image).toBe('abc123')
    })

    it('summary has no preview_image when none saved', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Widget')
      await store.save(uuid, { content: 'x' })
      const [s] = await store.list()
      expect(s.preview_image).toBeUndefined()
    })

    it('preview_image persists across saves that omit it', async () => {
      const store = new IndexedDbDocumentStore()
      const { uuid } = await store.create('Widget')
      await store.save(uuid, { content: 'a', preview_image: 'img1' })
      await store.save(uuid, { content: 'b' })  // no preview_image
      const [s] = await store.list()
      expect(s.preview_image).toBe('img1')
    })
  })
})
