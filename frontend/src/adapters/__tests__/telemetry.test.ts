import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DownloadBugReportSink, bugReportFilename, formatBugReportMarkdown } from '@/adapters/telemetry'

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
      expect(anchor.download).toMatch(/^\d{8}_\d{4}_boom\.md$/)
      expect(blobs).toHaveLength(1)
      expect(blobs[0].options?.type).toBe('text/markdown')
      expect(blobs[0].parts[0]).toContain('# boom')
    })

    // The name is what a maintainer sorts and searches by before opening
    // anything, so the date leads and the user's own words follow.
    it('names the file by local date, then time, then the report title', () => {
      const at = new Date(2026, 8, 2, 7, 5)
      expect(bugReportFilename({ title: 'Fillet crashes on edge' }, at))
        .toBe('20260902_0705_Fillet_crashes_on_edge.md')
    })

    it('collapses punctuation and falls back when the title carries no words', () => {
      const at = new Date(2026, 11, 31, 23, 59)
      expect(bugReportFilename({ title: '  Extrude: "half" depth?! ' }, at))
        .toBe('20261231_2359_Extrude_half_depth.md')
      expect(bugReportFilename({ title: '???' }, at)).toBe('20261231_2359_bug_report.md')
      expect(bugReportFilename({}, at)).toBe('20261231_2359_bug_report.md')
    })

    it('keeps a long title from running away with the filename', () => {
      const at = new Date(2026, 0, 1, 0, 0)
      const name = bugReportFilename({ title: 'word '.repeat(40) }, at)
      expect(name.length).toBeLessThanOrEqual('20260101_0000_'.length + 60 + '.md'.length)
      expect(name.endsWith('_.md')).toBe(false)
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
