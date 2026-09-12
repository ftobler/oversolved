import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import type { DocumentStore } from '../types'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'
import { InMemoryDocumentStore } from './InMemoryDocumentStore'
import { openDirectoryLibrary } from '../FileSystemDirectoryStore'
import { fakeDirectory } from './fakeFileSystemDirectory'
import { MemoryPreviewStore } from '@/stores/previewStore'
import { resetDbConnection } from '../idb'
import { suggestedCloneName } from '../cloneName'

// One behavioral contract, run against every DocumentStore implementation. The
// rule: given the same sequence of calls, each store must present the same
// observable document state.
//
// IndexedDB is the browser-storage default, but the seam exists so another
// store can be dropped in at the composition root without touching a caller --
// and a seam with a single conformer rots, because nothing distinguishes "the
// interface promises this" from "this is what IndexedDB happens to do".
// InMemoryDocumentStore is the second conformer that keeps the distinction
// real: it is written from this contract rather than ported from the IndexedDB
// store, so a behaviour only one of them has shows up here as a failure instead
// of as silent coupling.
//
// FileSystemDirectoryStore is the third, and the first one that is not a
// browser-private database: a folder the user picked, one .yaml file per
// document. It was built to this suite -- passing it UNCHANGED was the whole
// acceptance bar for that feature -- so anything it needed that the interface
// did not already promise would have shown up here as a contract change.
//
// Impl-specific concerns stay in their own files: IndexedDbDocumentStore.test.ts
// covers the local-only sync `meta` envelope, the tombstone lifecycle and the
// no-op-save optimization, none of which the interface promises.
//
// Known accepted divergences (documented, not contracted):
// - load() after remove(): the IndexedDB store rejects because its tombstone
//   hides the record from every read; the in-memory store rejects because the
//   record is simply gone. Both reject, so the contract pins list membership
//   (below) and leaves the tombstone lifecycle to the IDB suite.

interface Adapter {
  name: string
  make: () => DocumentStore
  setup: () => void
  teardown: () => void
}

const adapters: Adapter[] = [
  {
    name: 'IndexedDbDocumentStore',
    make: () => new IndexedDbDocumentStore(),
    setup: () => { resetFakeIndexedDb(); resetDbConnection() },
    teardown: () => {},
  },
  {
    name: 'InMemoryDocumentStore',
    make: () => new InMemoryDocumentStore(),  // state lives on the instance
    setup: () => {},
    teardown: () => {},
  },
  {
    name: 'FileSystemDirectoryStore',
    // A fresh in-memory directory handle per case, the same way the IDB adapter
    // gets a fresh fake database. Impl-specific behaviour (the on-disk layout,
    // save atomicity, adopting files that appeared underneath the app) lives in
    // FileSystemDirectoryStore.test.ts, not here.
    make: () => openDirectoryLibrary(fakeDirectory(), new MemoryPreviewStore()).documents,
    setup: () => {},
    teardown: () => {},
  },
]

describe.each(adapters)('DocumentStore contract: $name', (adapter) => {
  let store: DocumentStore

  beforeEach(() => {
    adapter.setup()
    store = adapter.make()
  })
  afterEach(() => {
    adapter.teardown()
  })

  // Membership-based comparison: the contract does not pin default list order
  // (that is an impl detail; see the IDB sort test), only which docs surface.
  const names = (list: { name: string }[]) => list.map(s => s.name).sort()

  it('create then list surfaces the document', async () => {
    const { uuid } = await store.create('Box')
    const list = await store.list()
    expect(list.map(s => s.uuid)).toContain(uuid)
    expect(list.find(s => s.uuid === uuid)?.is_owner).toBe(true)
  })

  // Previews left the seam in C2 (A9): they are derived and live in the preview
  // store, so the record carries content and identity only.
  it('save then load round-trips content and name', async () => {
    const { uuid } = await store.create('Box')
    await store.save(uuid, { content: 'features: []' })
    const loaded = await store.load(uuid)
    expect(loaded.content).toBe('features: []')
    expect(loaded.name).toBe('Box')
  })

  it('save overwrites in place (no duplicate ids)', async () => {
    const { uuid } = await store.create('Doc')
    await store.save(uuid, { content: 'v1' })
    await store.save(uuid, { content: 'v2' })
    expect(await store.list()).toHaveLength(1)
    expect((await store.load(uuid)).content).toBe('v2')
  })

  // `meta.rev` is the assembly bundle cache key (`${doc_id}@${rev}`), so a store
  // that failed to move it would serve stale geometry for an edited part with no
  // error anywhere. Only the direction is contracted -- the numbering is the
  // store's own business.
  it('save advances meta.rev so a cached rebuild is invalidated', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'v1' })
    const first = (await store.list()).find(s => s.uuid === uuid)!
    await store.save(uuid, { content: 'v2' })
    const second = (await store.list()).find(s => s.uuid === uuid)!
    expect(second.meta!.rev).toBeGreaterThan(first.meta!.rev)
  })

  // Only list membership is contracted after remove: both stores hide a deleted
  // document from listings, but what happens to the record underneath (tombstone
  // vs. gone) is the store's business, so load-after-remove is pinned per store.
  it('remove drops the entry from list', async () => {
    const { uuid } = await store.create('Doc')
    await store.save(uuid, { content: 'x' })
    await store.remove(uuid)
    expect(await store.list()).toEqual([])
  })

  it('load of a missing id rejects', async () => {
    await expect(store.load('no-such-doc')).rejects.toThrow()
  })

  // A rename of an id that does not exist must fail loudly rather than invent a
  // record. (save() is the deliberate exception: it upserts, so an editor whose
  // create() has not landed yet cannot lose the user's bytes.)
  it('rename of a missing id rejects and creates nothing', async () => {
    await expect(store.rename('no-such-doc', 'New')).rejects.toThrow()
    expect(await store.list()).toEqual([])
  })

  it('rename changes the name without touching content', async () => {
    const { uuid } = await store.create('Old')
    await store.save(uuid, { content: 'body' })
    await store.rename(uuid, 'New')
    const loaded = await store.load(uuid)
    expect(loaded.name).toBe('New')
    expect(loaded.content).toBe('body')
  })

  // The suffix is matched case-insensitively on purpose: the casing is cosmetic,
  // what is contracted is the copy relationship.
  it('duplicate clones content under a fresh id named after the source', async () => {
    const { uuid } = await store.create('Original')
    await store.save(uuid, { content: 'shape' })
    const { uuid: dupId } = await store.duplicate(uuid)
    expect(dupId).not.toBe(uuid)
    const dup = await store.load(dupId)
    expect(dup.content).toBe('shape')
    expect(dup.name).toMatch(/^Original \(copy\)$/i)
    expect(await store.list()).toHaveLength(2)
  })

  it('duplicate of a missing id rejects', async () => {
    await expect(store.duplicate('no-such-doc')).rejects.toThrow()
  })

  it('clone copies content into a fresh document', async () => {
    const { uuid } = await store.create('Original')
    await store.save(uuid, { content: 'shape' })
    const { uuid: cloneId } = await store.clone(uuid)
    expect(cloneId).not.toBe(uuid)
    expect((await store.load(cloneId)).content).toBe('shape')
    expect(await store.list()).toHaveLength(2)
  })

  it('clone defaults to the suggested name and honors an explicit one', async () => {
    const { uuid } = await store.create('Original')
    await store.save(uuid, { content: 'shape' })
    const auto = await store.clone(uuid)
    expect((await store.load(auto.uuid)).name).toBe(suggestedCloneName('Original'))
    const named = await store.clone(uuid, 'Bracket v2')
    expect((await store.load(named.uuid)).name).toBe('Bracket v2')
  })

  it('create defaults is_public to false and honors an explicit true', async () => {
    const priv = await store.create('Private')
    const pub = await store.create('Public', { is_public: true })
    expect((await store.load(priv.uuid)).is_public).toBe(false)
    expect((await store.load(pub.uuid)).is_public).toBe(true)
  })

  it('list search filters by name substring', async () => {
    await store.create('Bracket')
    await store.create('Gearbox')
    expect(names(await store.list({ search: 'gear' }))).toEqual(['Gearbox'])
  })

  it('list public filter returns only public documents', async () => {
    await store.create('Bracket')
    await store.create('Gearbox', { is_public: true })
    expect(names(await store.list({ filter: 'public' }))).toEqual(['Gearbox'])
  })

  it('list sort=name returns documents A-Z', async () => {
    await store.create('Zeta')
    await store.create('Alpha')
    await store.create('Mike')
    expect((await store.list({ sort: 'name' })).map(s => s.name)).toEqual(['Alpha', 'Mike', 'Zeta'])
  })

  // Content is opaque to the seam: a store must not parse, normalise or
  // re-serialise the document text, so `kind` survives by never being read.
  it('round-trips assembly content preserving kind', async () => {
    const asmContent = 'kind: assembly\nfeatures: []\n'
    const { uuid } = await store.create('Asm')
    await store.save(uuid, { content: asmContent })
    const loaded = await store.load(uuid)
    expect(loaded.content).toBe(asmContent)
  })

  it('round-trips assembly content with features preserving kind', async () => {
    const asmContent = 'kind: assembly\nfeatures:\n  - id: O1\n    kind: origin\n'
    const { uuid } = await store.create('Asm2')
    await store.save(uuid, { content: asmContent })
    const loaded = await store.load(uuid)
    expect(loaded.content).toBe(asmContent)
  })

  it('round-trips part content preserving kind', async () => {
    const partContent = 'kind: part\nfeatures: []\n'
    const { uuid } = await store.create('Part')
    await store.save(uuid, { content: partContent })
    const loaded = await store.load(uuid)
    expect(loaded.content).toBe(partContent)
  })
})
