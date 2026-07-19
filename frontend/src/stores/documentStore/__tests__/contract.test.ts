import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import type { DocumentStore } from '../types'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'
import { HttpDocumentStore } from '../HttpDocumentStore'
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

// A faithful in-memory stand-in for the Flask `/api/documents` endpoints, just
// complete enough to exercise the same observable behavior as the local store.
// It is NOT the real backend -- the wire-shape tests guard that -- it only lets
// the HTTP store run the same behavioral assertions as the IDB store.
function mountFakeServer(): () => void {
  interface Rec {
    uuid: string
    name: string
    content: string
    preview_image?: string
    is_public: boolean
    created_at: string
    updated_at: string
  }
  const docs = new Map<string, Rec>()
  let clock = 1000
  const stamp = () => new Date(clock++).toISOString()
  const original = globalThis.fetch

  const respond = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response)

  const toSummary = (r: Rec) => ({
    uuid: r.uuid,
    name: r.name,
    created_at: r.created_at,
    updated_at: r.updated_at,
    is_owner: true,
    owner_username: 'server-user',
    is_public: r.is_public,
  })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString()
    const url = new URL(raw, 'http://test')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    const path = url.pathname

    if (path === '/api/documents') {
      if (method === 'POST') {
        const uuid = crypto.randomUUID()
        docs.set(uuid, {
          uuid, name: body.name, content: '',
          is_public: body.is_public ?? false,
          created_at: stamp(), updated_at: stamp(),
        })
        return respond(200, { uuid })
      }
      // GET list with server-side filter / search / sort.
      let list = [...docs.values()]
      const filter = url.searchParams.get('filter')
      const search = url.searchParams.get('search')
      const sort = url.searchParams.get('sort')
      if (filter === 'public') list = list.filter(d => d.is_public)
      else if (filter === 'shared') list = []
      if (search) {
        const needle = search.toLowerCase()
        list = list.filter(d => d.name.toLowerCase().includes(needle))
      }
      if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
      else list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      return respond(200, { documents: list.map(toSummary) })
    }

    const dup = path.match(/^\/api\/documents\/([^/]+)\/duplicate$/)
    if (dup && method === 'POST') {
      const src = docs.get(dup[1])
      if (!src) return respond(404)
      const uuid = crypto.randomUUID()
      docs.set(uuid, {
        ...src, uuid, name: `${src.name} (copy)`,
        created_at: stamp(), updated_at: stamp(),
      })
      return respond(200, { uuid })
    }

    const clone = path.match(/^\/api\/documents\/([^/]+)\/clone$/)
    if (clone && method === 'POST') {
      const src = docs.get(clone[1])
      if (!src) return respond(404)
      const uuid = crypto.randomUUID()
      docs.set(uuid, {
        ...src, uuid, name: body?.name?.trim() || `${src.name} (Clone)`,
        created_at: stamp(), updated_at: stamp(),
      })
      return respond(200, { uuid })
    }

    const one = path.match(/^\/api\/documents\/([^/]+)$/)
    if (one) {
      const id = one[1]
      const rec = docs.get(id)
      if (method === 'GET') {
        if (!rec) return respond(404)
        return respond(200, {
          content: rec.content, name: rec.name,
          owner_username: 'server-user', permission: 'owner',
          is_public: rec.is_public, preview_image: rec.preview_image,
        })
      }
      if (method === 'PUT') {
        if (!rec) return respond(404)
        rec.content = body.content
        if (body.preview_image !== undefined) rec.preview_image = body.preview_image
        rec.updated_at = stamp()
        return respond(200, {})
      }
      if (method === 'PATCH') {
        if (!rec) return respond(404)
        rec.name = body.name
        return respond(200, {})
      }
      if (method === 'DELETE') {
        docs.delete(id)
        return respond(200, {})
      }
    }
    return respond(404)
  }) as typeof fetch

  return () => { globalThis.fetch = original }
}

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
    unmount = adapter.name === 'HttpDocumentStore' ? mountFakeServer() : () => {}
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

  it('remove drops the entry; load-after-remove rejects', async () => {
    const { uuid } = await store.create('Doc')
    await store.save(uuid, { content: 'x' })
    await store.remove(uuid)
    expect(await store.list()).toEqual([])
    await expect(store.load(uuid)).rejects.toThrow()
  })

  it('rename changes the name without touching content', async () => {
    const { uuid } = await store.create('Old')
    await store.save(uuid, { content: 'body' })
    await store.rename(uuid, 'New')
    const loaded = await store.load(uuid)
    expect(loaded.name).toBe('New')
    expect(loaded.content).toBe('body')
  })

  it('duplicate clones content under a fresh id named "(copy)"', async () => {
    const { uuid } = await store.create('Original')
    await store.save(uuid, { content: 'shape' })
    const { uuid: dupId } = await store.duplicate(uuid)
    expect(dupId).not.toBe(uuid)
    const dup = await store.load(dupId)
    expect(dup.content).toBe('shape')
    expect(dup.name).toBe('Original (copy)')
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
