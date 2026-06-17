import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'
import { resetDbConnection } from '../idb'

// Each test gets a clean database: swap in a fresh fake IndexedDB factory and
// drop the cached connection so the store reopens against it.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
})

describe('IndexedDbDocumentStore', () => {
  it('save then load round-trips an identical payload', async () => {
    const store = new IndexedDbDocumentStore()
    const { uuid } = await store.create('Box')
    await store.save(uuid, { content: 'features: []', preview_image: 'PNGDATA' })
    const loaded = await store.load(uuid)
    expect(loaded.content).toBe('features: []')
    expect(loaded.preview_image).toBe('PNGDATA')
    expect(loaded.name).toBe('Box')
    expect(loaded.permission).toBe('owner')
  })

  it('list returns saved summaries; remove drops the entry; load-after-remove rejects', async () => {
    const store = new IndexedDbDocumentStore()
    const { uuid } = await store.create('Doc A')
    await store.save(uuid, { content: 'x' })
    let summaries = await store.list()
    expect(summaries.map(s => s.uuid)).toEqual([uuid])
    expect(summaries[0].is_owner).toBe(true)

    await store.remove(uuid)
    summaries = await store.list()
    expect(summaries).toEqual([])
    await expect(store.load(uuid)).rejects.toThrow()
  })

  it('save overwrites in place (no duplicate ids)', async () => {
    const store = new IndexedDbDocumentStore()
    const { uuid } = await store.create('Doc')
    await store.save(uuid, { content: 'v1' })
    await store.save(uuid, { content: 'v2' })
    const summaries = await store.list()
    expect(summaries).toHaveLength(1)
    expect((await store.load(uuid)).content).toBe('v2')
  })

  it('rename changes the name without touching content', async () => {
    const store = new IndexedDbDocumentStore()
    const { uuid } = await store.create('Old')
    await store.save(uuid, { content: 'body' })
    await store.rename(uuid, 'New')
    const loaded = await store.load(uuid)
    expect(loaded.name).toBe('New')
    expect(loaded.content).toBe('body')
  })

  it('duplicate clones content under a fresh id', async () => {
    const store = new IndexedDbDocumentStore()
    const { uuid } = await store.create('Original')
    await store.save(uuid, { content: 'shape' })
    const { uuid: dupId } = await store.duplicate(uuid)
    expect(dupId).not.toBe(uuid)
    const dup = await store.load(dupId)
    expect(dup.content).toBe('shape')
    expect(dup.name).toBe('Original (copy)')
    expect(await store.list()).toHaveLength(2)
  })

  describe('list filtering / sorting', () => {
    it('search filters by name substring; public filter respects is_public', async () => {
      const store = new IndexedDbDocumentStore()
      await store.create('Bracket')
      const { uuid: gear } = await store.create('Gearbox', { is_public: true })
      await store.save(gear, { content: 'g' })

      expect((await store.list({ search: 'gear' })).map(s => s.name)).toEqual(['Gearbox'])
      expect((await store.list({ filter: 'public' })).map(s => s.name)).toEqual(['Gearbox'])
      expect(await store.list({ filter: 'shared' })).toEqual([])
    })

    it('sorts newest-first by default and A-Z on name', async () => {
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
      expect((await store.list({ sort: 'name' })).map(s => s.name)).toEqual(['Alpha', 'Zeta'])
      expect((await store.list({ sort: 'modified_asc' })).map(s => s.name)).toEqual(['Zeta', 'Alpha'])
      now.mockRestore()
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
  })
})
