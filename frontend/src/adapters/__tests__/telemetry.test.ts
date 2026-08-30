import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DownloadBugReportSink, formatBugReportMarkdown } from '@/adapters/telemetry'

describe('telemetry adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('download sink', () => {
    let clickSpy: ReturnType<typeof vi.fn>
    let anchor: { href: string; download: string; click: ReturnType<typeof vi.fn> }
    let blobs: { parts: unknown[]; options?: BlobPropertyBag }[]

    beforeEach(() => {
      clickSpy = vi.fn()
      anchor = { href: '', download: '', click: clickSpy }
      blobs = []
      vi.stubGlobal('URL', {
        createObjectURL: vi.fn(() => 'blob:fake'),
        revokeObjectURL: vi.fn(),
      })
      vi.stubGlobal('Blob', class {
        constructor(parts: unknown[], options?: BlobPropertyBag) {
          blobs.push({ parts, options })
        }
      })
      vi.spyOn(document, 'createElement').mockReturnValue(anchor as unknown as HTMLAnchorElement)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    // The "instead of the network" half is the point, not incidental: there is
    // nowhere to POST a report to, so a sink that quietly tried would fail in a
    // way the user never sees.
    it('renders the report to a .md download instead of hitting the network', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      await new DownloadBugReportSink().send({ title: 'boom', description: 'it broke' })

      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(anchor.download).toMatch(/^bug-report-\d+\.md$/)
      expect(blobs).toHaveLength(1)
      expect(blobs[0].options?.type).toBe('text/markdown')
      expect(blobs[0].parts[0]).toContain('# boom')
    })
  })

  describe('markdown formatting', () => {
    it('puts the title in a heading and the description as prose', () => {
      const md = formatBugReportMarkdown({ title: 'boom', description: 'it broke' })
      expect(md).toBe('# boom\n\nit broke\n')
    })

    it('falls back to a generic heading when the title is blank', () => {
      expect(formatBugReportMarkdown({ title: '   ' })).toBe('# Bug report\n')
    })

    it('fences the AST and selection attachments as JSON', () => {
      const md = formatBugReportMarkdown({
        title: 'boom',
        ast: { kind: 'part' },
        selection: ['edge-1', 'edge-2'],
      })
      expect(md).toContain('## AST\n\n```json\n{\n  "kind": "part"\n}\n```')
      expect(md).toContain('## Selection (2 items)')
      expect(md).toContain('"edge-1"')
    })

    it('lists history entries by label with the mutation fenced under each', () => {
      const md = formatBugReportMarkdown({
        title: 'boom',
        history: [
          { mutation: { op: 'add' }, label: 'Add sketch' },
          { mutation: { op: 'del' }, label: 'Delete face' },
        ],
      })
      expect(md).toContain('## Edit history (2 items)')
      expect(md).toContain('1. Add sketch\n\n```json\n{\n  "op": "add"\n}\n```')
      expect(md).toContain('2. Delete face')
    })

    it('keeps unknown attachments instead of dropping them', () => {
      const md = formatBugReportMarkdown({ title: 'boom', viewport: { zoom: 2 } })
      expect(md).toContain('## viewport')
      expect(md).toContain('"zoom": 2')
    })
  })
})
