import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSharingAdapter } from '@/adapters/sharing'

describe('sharing adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('is absent (null) on the static build', () => {
    expect(createSharingAdapter('static')).toBeNull()
  })

  it('lists shares from /api/documents/<uuid>/shares', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ shares: [{ id: 1, username: 'bob', permission: 'view', shared_with_user_id: 2 }] }),
      } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSharingAdapter('http')!
    const shares = await adapter.listShares('doc-1')

    expect(shares).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/shares')
  })

  it('shares via POST', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('{}') } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSharingAdapter('http')!
    await adapter.share('doc-1', { username: 'bob', permission: 'edit' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/doc-1/share',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'bob', permission: 'edit' }),
      }),
    )
  })

  it('unshares via DELETE with a username body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ shares: [] }) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSharingAdapter('http')!
    const result = await adapter.unshare('doc-1', 'bob')

    expect(result).toEqual({ shares: [] })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/doc-1/share',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ username: 'bob' }),
      }),
    )
  })

  it('unshare without a username sends an empty body (link sharing)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ shares: [] }) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSharingAdapter('http')!
    await adapter.unshare('doc-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/doc-1/share',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({}) }),
    )
  })

  it('unshare throws the server error on a failed response', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'nope' }) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSharingAdapter('http')!
    await expect(adapter.unshare('doc-1', 'bob')).rejects.toThrow('nope')
  })

  it('leaveShare removes the recipient view via plain DELETE', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSharingAdapter('http')!
    await adapter.leaveShare('doc-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/doc-1/share',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
