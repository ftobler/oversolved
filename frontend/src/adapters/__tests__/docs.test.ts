import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDocsSource } from '@/adapters/docs'

describe('docs adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('is absent (null) on the static build', () => {
    expect(createDocsSource('static')).toBeNull()
  })

  it('HTTP source lists doc names from /api/docs', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ docs: ['overview', 'sketch'] }) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const source = createDocsSource('http')
    expect(source).not.toBeNull()
    const names = await source!.list()

    expect(names).toEqual(['overview', 'sketch'])
    expect(fetchMock).toHaveBeenCalledWith('/api/docs')
  })

  it('HTTP source loads one doc content from /api/docs/<name>', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ content: '# Overview' }) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const source = createDocsSource('http')
    const content = await source!.load('overview')

    expect(content).toBe('# Overview')
    expect(fetchMock).toHaveBeenCalledWith('/api/docs/overview')
  })
})
