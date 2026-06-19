import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HttpDocumentStore } from '../HttpDocumentStore'

// These tests lock the refactor: the store must issue exactly the requests the
// old inlined fetches did (URL, method, body). If a future change alters an
// endpoint, this is the regression that catches it.

function mockFetch(jsonBody: unknown = {}) {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
  } as unknown as Response))
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

function lastCall(fn: ReturnType<typeof mockFetch>) {
  const call = fn.mock.calls[fn.mock.calls.length - 1] as unknown as [string, RequestInit | undefined]
  return { url: call[0], init: call[1] }
}

describe('HttpDocumentStore', () => {
  let store: HttpDocumentStore
  beforeEach(() => { store = new HttpDocumentStore() })
  afterEach(() => { vi.restoreAllMocks() })

  it('list issues GET /api/documents with sort/filter/search params', async () => {
    const fetchFn = mockFetch({ documents: [{ uuid: 'a' }] })
    const out = await store.list({ sort: 'modified', filter: 'owned', search: 'box' })
    const { url, init } = lastCall(fetchFn)
    expect(url).toBe('/api/documents?sort=modified&filter=owned&search=box')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(out).toEqual([{ uuid: 'a' }])
  })

  it('list omits the query string when no options given', async () => {
    const fetchFn = mockFetch({ documents: [] })
    await store.list()
    expect(lastCall(fetchFn).url).toBe('/api/documents')
  })

  it('load issues GET /api/documents/:id', async () => {
    const fetchFn = mockFetch({ content: 'features: []', name: 'Box' })
    const payload = await store.load('uuid-1')
    expect(lastCall(fetchFn).url).toBe('/api/documents/uuid-1')
    expect(payload.name).toBe('Box')
  })

  it('save issues PUT /api/documents/:id with content (+ preview when present)', async () => {
    const fetchFn = mockFetch({})
    await store.save('uuid-1', { content: 'yaml', preview_image: 'b64' })
    const { url, init } = lastCall(fetchFn)
    expect(url).toBe('/api/documents/uuid-1')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ content: 'yaml', preview_image: 'b64' })
  })

  it('save omits preview_image when not provided', async () => {
    const fetchFn = mockFetch({})
    await store.save('uuid-1', { content: 'yaml' })
    expect(JSON.parse(lastCall(fetchFn).init?.body as string)).toEqual({ content: 'yaml' })
  })

  it('remove issues DELETE /api/documents/:id', async () => {
    const fetchFn = mockFetch({})
    await store.remove('uuid-1')
    const { url, init } = lastCall(fetchFn)
    expect(url).toBe('/api/documents/uuid-1')
    expect(init?.method).toBe('DELETE')
  })

  it('create issues POST /api/documents with name + is_public', async () => {
    const fetchFn = mockFetch({ uuid: 'new-1' })
    const res = await store.create('My Doc', { is_public: true })
    const { url, init } = lastCall(fetchFn)
    expect(url).toBe('/api/documents')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'My Doc', is_public: true })
    expect(res).toEqual({ uuid: 'new-1' })
  })

  it('create defaults is_public to false', async () => {
    const fetchFn = mockFetch({ uuid: 'new-2' })
    await store.create('Doc')
    expect(JSON.parse(lastCall(fetchFn).init?.body as string)).toEqual({ name: 'Doc', is_public: false })
  })

  it('rename issues PATCH /api/documents/:id with name', async () => {
    const fetchFn = mockFetch({})
    await store.rename('uuid-1', 'Renamed')
    const { url, init } = lastCall(fetchFn)
    expect(url).toBe('/api/documents/uuid-1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'Renamed' })
  })

  it('duplicate issues POST /api/documents/:id/duplicate', async () => {
    const fetchFn = mockFetch({ uuid: 'dup-1' })
    const res = await store.duplicate('uuid-1')
    const { url, init } = lastCall(fetchFn)
    expect(url).toBe('/api/documents/uuid-1/duplicate')
    expect(init?.method).toBe('POST')
    expect(res).toEqual({ uuid: 'dup-1' })
  })

  it('thumbnailUrl points at the server thumbnail route (no fetch)', () => {
    expect(store.thumbnailUrl('uuid-1')).toBe('/api/documents/uuid-1/thumbnail')
  })
})
