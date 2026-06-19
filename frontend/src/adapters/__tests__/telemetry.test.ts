import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBugReportSink } from '@/adapters/telemetry'

describe('telemetry adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('HTTP sink POSTs the report to /api/bug-report', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const sink = createBugReportSink('http')
    await sink.send({ title: 'boom', description: 'it broke' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/bug-report',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'boom', description: 'it broke' }),
      }),
    )
  })

  describe('static download sink', () => {
    let clickSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
      clickSpy = vi.fn()
      vi.stubGlobal('URL', {
        createObjectURL: vi.fn(() => 'blob:fake'),
        revokeObjectURL: vi.fn(),
      })
      vi.spyOn(document, 'createElement').mockReturnValue({
        href: '',
        download: '',
        click: clickSpy,
      } as unknown as HTMLAnchorElement)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('serialises the report to a JSON download instead of hitting the network', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const sink = createBugReportSink('static')
      await sink.send({ title: 'boom' })

      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
