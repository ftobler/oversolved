import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import { mountFakeDocumentsServer } from './fakeDocumentsServer'
import type { DocumentStore } from '../types'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'
import { HttpDocumentStore } from '../HttpDocumentStore'
import { HttpError } from '@/utils/core/httpClient'
import { resetDbConnection } from '../idb'
import { suggestedCloneName } from '../cloneName'

// One behavioral contract, run against every DocumentStore implementation. The
// rule: given the same sequence of calls, each store must present the same
// observable document state. Anything here is asserted once and guaranteed
// identical across HTTP and IndexedDB, so the two builds can't silently drift.
//
// Impl-specific concerns live in their own files: HttpDocumentStore.test.ts
// locks the exact wire protocol (the real Flask contract), and
// IndexedDbDocumentStore.test.ts covers the local-only sync `meta` envelope.
//
// Known accepted divergences (documented, not contracted):
// - save() to an unknown id: the HTTP store 404s (require_doc_permission runs
//   before update_document), while the local store deliberately upserts a
//   phantom 'Untitled' record because a static build may save into an id that
//   only exists in memory (a fresh doc whose create() raced the first save).
//   Do NOT "fix" either side toward the other without revisiting that intent.
// - load() after remove(): the local store rejects (its tombstone hides the
//   record from every read), while the cloud keeps serving a trashed row to
//   its owner over GET until purge (DocumentStore.retrieve has no deleted_at
//   filter). Pinned per side: IndexedDbDocumentStore.test.ts for the local
//   rejection, fakeDocumentsServer.ts + the drift pins below for the cloud.

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
    name: 'HttpDocumentStore',
    make: () => new HttpDocumentStore(),
    setup: () => {},  // server mounted per-test below so teardown can restore fetch
    teardown: () => {},
  },
]

describe.each(adapters)('DocumentStore contract: $name', (adapter) => {
  let store: DocumentStore
  let unmount: () => void

  beforeEach(() => {
    adapter.setup()
    unmount = adapter.name === 'HttpDocumentStore' ? mountFakeDocumentsServer() : () => {}
    store = adapter.make()
  })
  afterEach(() => {
    unmount()
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

  it('save then load round-trips content, name and preview', async () => {
    const { uuid } = await store.create('Box')
    await store.save(uuid, { content: 'features: []', preview_image: 'PNGDATA' })
    const loaded = await store.load(uuid)
    expect(loaded.content).toBe('features: []')
    expect(loaded.preview_image).toBe('PNGDATA')
    expect(loaded.name).toBe('Box')
    expect(loaded.permission).toBe('owner')
  })

  it('save overwrites in place (no duplicate ids)', async () => {
    const { uuid } = await store.create('Doc')
    await store.save(uuid, { content: 'v1' })
    await store.save(uuid, { content: 'v2' })
    expect(await store.list()).toHaveLength(1)
    expect((await store.load(uuid)).content).toBe('v2')
  })

  // Only list membership is contracted after remove: both backends hide a
  // deleted document from listings, but they disagree on direct reads (see the
  // divergence note in the file header), so load-after-remove is pinned per
  // store, not here.
  it('remove drops the entry from list', async () => {
    const { uuid } = await store.create('Doc')
    await store.save(uuid, { content: 'x' })
    await store.remove(uuid)
    expect(await store.list()).toEqual([])
  })

  it('load of a missing id rejects', async () => {
    await expect(store.load('no-such-doc')).rejects.toThrow()
  })

  // Unknown-id rename rejects everywhere: the backend answers 404 through
  // require_doc_permission and the local store throws on its own (the
  // canonical local semantic, see IndexedDbDocumentStore.rename).
  it('rename of a missing id rejects', async () => {
    await expect(store.rename('no-such-doc', 'New')).rejects.toThrow()
  })

  it('rename changes the name without touching content', async () => {
    const { uuid } = await store.create('Old')
    await store.save(uuid, { content: 'body' })
    await store.rename(uuid, 'New')
    const loaded = await store.load(uuid)
    expect(loaded.name).toBe('New')
    expect(loaded.content).toBe('body')
  })

  // The suffix is matched case-insensitively on purpose: the backend spells it
  // "(Copy)" and the local store still says "(copy)". The casing is cosmetic;
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

// Per-store pins for behavior the shared contract cannot express: the error
// SHAPE each store uses to reject unknown ids, and the fake server's fidelity
// to the real blueprints (review-17 L12 drift items). If one of these fails,
// fakeDocumentsServer.ts has drifted from oversolved/blueprints/documents.py.
describe('unknown-id semantics and fake-server fidelity', () => {
  let unmount: () => void
  beforeEach(() => { unmount = mountFakeDocumentsServer() })
  afterEach(() => { unmount() })

  it('HTTP rename of a missing id surfaces the backend 404 as a typed HttpError', async () => {
    const store = new HttpDocumentStore()
    const err = await store.rename('no-such-doc', 'X').then(() => null, e => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(404)
    // The body carries the unified api_error shape, so parseHttpError at the
    // call site renders "Document not found" instead of a generic fallback.
    expect(JSON.parse((err as HttpError).body)).toMatchObject({ error: 'Document not found', code: 'NOT_FOUND' })
  })

  it('local rename of a missing id throws not-found (canonical local semantic)', async () => {
    resetFakeIndexedDb(); resetDbConnection()
    const store = new IndexedDbDocumentStore()
    await expect(store.rename('no-such-doc', 'X')).rejects.toThrow(/not found/i)
    // Nothing may have been created by the failed rename.
    expect(await store.list()).toEqual([])
  })

  // ─── fake-server drift pins vs documents.py ───

  it('create/duplicate/clone return the real statuses (201) and duplicate uses "(Copy)" casing', async () => {
    const created = await fetch('/api/documents', { method: 'POST', body: JSON.stringify({ name: 'Box' }) })
    expect(created.status).toBe(201)
    const { uuid } = await created.json()

    const dup = await fetch(`/api/documents/${uuid}/duplicate`, { method: 'POST' })
    expect(dup.status).toBe(201)
    expect((await dup.json()).name).toBe('Box (Copy)')

    const clone = await fetch(`/api/documents/${uuid}/clone`, { method: 'POST' })
    expect(clone.status).toBe(201)

    const put = await fetch(`/api/documents/${uuid}`, { method: 'PUT', body: JSON.stringify({ content: 'x' }) })
    expect(put.status).toBe(200)
  })

  it('clone uniquifies the suggested name with (Clone N); an explicit name is verbatim', async () => {
    // clone_document uniquifies only the fallback suggestion, against the
    // caller's existing names; a requested name is never touched.
    const created = await fetch('/api/documents', { method: 'POST', body: JSON.stringify({ name: 'Bracket' }) })
    const { uuid } = await created.json()
    await fetch('/api/documents', { method: 'POST', body: JSON.stringify({ name: 'Bracket (Clone)' }) })

    const first = await fetch(`/api/documents/${uuid}/clone`, { method: 'POST' })
    expect((await first.json()).name).toBe('Bracket (Clone 1)')

    const named = await fetch(`/api/documents/${uuid}/clone`, {
      method: 'POST',
      body: JSON.stringify({ name: '  Bracket (Clone)  ' }),
    })
    expect((await named.json()).name).toBe('Bracket (Clone)')  // trimmed, not uniquified
  })

  it('DELETE tombstones like the backend: hidden from list, still served by GET', async () => {
    const created = await fetch('/api/documents', { method: 'POST', body: JSON.stringify({ name: 'Gone' }) })
    const { uuid } = await created.json()
    await fetch(`/api/documents/${uuid}`, { method: 'PUT', body: JSON.stringify({ content: 'body' }) })

    const del = await fetch(`/api/documents/${uuid}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ uuid, status: 'moved_to_trash' })

    const list = await fetch('/api/documents')
    expect((await list.json()).documents.map((d: { uuid: string }) => d.uuid)).not.toContain(uuid)

    // retrieve() has no deleted_at filter: the row keeps serving GET.
    const get = await fetch(`/api/documents/${uuid}`)
    expect(get.status).toBe(200)
    expect((await get.json()).content).toBe('body')
  })

  it('every per-document verb 404s a missing uuid with the unified error shape', async () => {
    for (const [method, init] of [
      ['GET', undefined],
      ['PUT', { body: JSON.stringify({ content: '' }) }],
      ['PATCH', { body: JSON.stringify({ name: 'X' }) }],
      ['DELETE', undefined],
    ] as const) {
      const res = await fetch('/api/documents/no-such-doc', { method, ...init })
      expect(res.status, method).toBe(404)
      expect(await res.json()).toMatchObject({ ok: false, error: 'Document not found', code: 'NOT_FOUND' })
    }
  })

  // ─── synthesized meta.rev (assembly bundle cache key) ───

  it('HTTP list synthesizes meta.rev from the server updated_at and bumps it on edit', async () => {
    // The server rows have no meta column; HttpDocumentStore.list maps
    // updated_at into the local meta shape so cloud-picked parts get a real
    // bundle cache key instead of pinning doc_rev 0 forever (review-18 PS-H1).
    const store = new HttpDocumentStore()
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'v1' })

    const first = (await store.list()).find(s => s.uuid === uuid)
    expect(first?.meta).toEqual({
      id: uuid,
      rev: Date.parse(first!.updated_at),
      updatedAt: Date.parse(first!.updated_at),
      dirty: false,  // the server is the source of truth: nothing pending
    })

    await store.save(uuid, { content: 'v2' })
    const second = (await store.list()).find(s => s.uuid === uuid)
    expect(second!.meta!.rev).toBeGreaterThan(first!.meta!.rev)
    // solveAssembly cache-hits `${doc_id}@${rev}`: this bump is exactly what
    // forces a post-edit rebuild instead of serving stale geometry.
  })
})
