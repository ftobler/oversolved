import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import {
  useNotices,
  headingSlug,
  noticeSections,
  resolveNoticeHref,
  NOTICES_ROOT,
} from '@/pages/hooks/useNotices'

// The notices page anchors nav entries to heading slugs and rewrites relative
// links against the published notices folder. Both derive from the markdown at
// runtime, so the parsing rules are the contract between the fetched documents
// and the rendered page.

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(impl: (url: string) => Promise<{ ok: boolean, status?: number, statusText?: string, text: () => Promise<string> }>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => impl(String(input)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('headingSlug', () => {
  it('lowercases, collapses non-alphanumerics and trims the edges', () => {
    expect(headingSlug('Third Party Notices')).toBe('third-party-notices')
    expect(headingSlug('  OpenCascade / OCCT  ')).toBe('opencascade-occt')
    expect(headingSlug('MIT (v2)')).toBe('mit-v2')
  })
})

describe('noticeSections', () => {
  it('keeps second-level headings in document order and slugs their ids', () => {
    const md = '# Title\n\n## Alpha License\ntext\n## Beta License\n'
    expect(noticeSections(md)).toEqual([
      { id: 'alpha-license', label: 'Alpha License' },
      { id: 'beta-license', label: 'Beta License' },
    ])
  })

  it('ignores a ## line inside a fenced code block', () => {
    const md = '## Real\ntext\n```\n## Not A Heading\n```\n'
    expect(noticeSections(md).map(s => s.label)).toEqual(['Real'])
  })
})

describe('resolveNoticeHref', () => {
  it('leaves absolute URLs and anchors alone', () => {
    expect(resolveNoticeHref('https://example.com/a', 'guide.md')).toBe('https://example.com/a')
    expect(resolveNoticeHref('mailto:legal@example.com', 'guide.md')).toBe('mailto:legal@example.com')
    expect(resolveNoticeHref('#section', 'guide.md')).toBe('#section')
  })

  it('resolves a relative link against the notices folder, not the route', () => {
    expect(resolveNoticeHref('LICENSE.txt', 'guide.md')).toBe(`${NOTICES_ROOT}LICENSE.txt`)
  })

  it('returns undefined when there is no href', () => {
    expect(resolveNoticeHref(undefined, 'guide.md')).toBeUndefined()
  })
})

describe('useNotices', () => {
  it('reads the fetched markdown into a ready state', async () => {
    stubFetch(async () => ({ ok: true, text: async () => '# Notices' }))
    const { result } = renderHook(() => useNotices('guide.md'))

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current).toEqual({ status: 'ready', markdown: '# Notices' })
  })

  it('reports a non-ok response by status', async () => {
    stubFetch(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' }))
    const { result } = renderHook(() => useNotices('missing.md'))

    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current).toEqual({ status: 'failed', reason: '404 Not Found' })
  })

  it('reports a non-Error rejection as unknown, not a bare empty banner', async () => {
    stubFetch(async () => { throw 'network down' })
    const { result } = renderHook(() => useNotices('guide.md'))

    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current).toEqual({ status: 'failed', reason: 'unknown' })
  })

  it('shows loading for a new file rather than the previous document', async () => {
    const fetched: string[] = []
    stubFetch(async (url) => {
      fetched.push(url)
      return { ok: true, text: async () => `body of ${url}` }
    })
    const { result, rerender } = renderHook(({ file }: { file: string }) => useNotices(file), {
      initialProps: { file: 'first.md' },
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    rerender({ file: 'second.md' })
    // The first document must not flash under the second's heading.
    expect(result.current.status).toBe('loading')

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current).toEqual({ status: 'ready', markdown: `body of ${NOTICES_ROOT}second.md` })
    expect(fetched).toContain(`${NOTICES_ROOT}second.md`)
  })
})
