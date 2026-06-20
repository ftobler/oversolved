import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTrashAdapter } from '@/adapters/trash'

describe('trash adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('is absent (null) on the static build', () => {
    expect(createTrashAdapter('static')).toBeNull()
  })

  it('lists trashed documents from /api/documents/trash', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          documents: [
            { uuid: 't-1', name: 'Gone', deleted_at: 'd', created_at: 'c', owner_id: 1, owner_username: 'me' },
          ],
        }),
      } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createTrashAdapter('http')!
    const docs = await adapter.list()

    expect(docs).toHaveLength(1)
    expect(docs[0].uuid).toBe('t-1')
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/trash')
  })

  it('list tolerates a missing documents field', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createTrashAdapter('http')!
    expect(await adapter.list()).toEqual([])
  })

  it('recovers via POST /api/documents/<uuid>/recover', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('{}') } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createTrashAdapter('http')!
    await adapter.recover('t-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/t-1/recover',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('purges via DELETE /api/documents/<uuid>/trash', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createTrashAdapter('http')!
    await adapter.purge('t-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/t-1/trash',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
