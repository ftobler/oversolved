// Telemetry capability: where a bug report goes.
//
// There is nowhere to send one -- the app is the browser tab -- so the report is
// rendered to a Markdown file the user downloads and forwards themselves. The
// debug panel calls `backendBundle.telemetry.send` and stays ignorant of that:
// the sink is a port precisely so "where reports land" can change (an issue
// tracker, a support address) without the panel learning about it.
//
// Markdown rather than JSON because a downloaded report has a human next stop:
// the user pastes it into an issue tracker or a chat. The bulky attachments stay
// fenced JSON inside it so they remain machine-readable for whoever triages.

export type BugReport = Record<string, unknown>

export interface BugReportSink {
  send(report: BugReport): Promise<void>
}

function jsonBlock(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```'
}

// Keys the formatter gives a shaped rendering to. Anything else the debug panel
// starts attaching later still reaches the file as a generic JSON section rather
// than being silently dropped.
const SHAPED_KEYS = ['title', 'description', 'ast', 'selection', 'history']

export function formatBugReportMarkdown(report: BugReport): string {
  const title = typeof report.title === 'string' && report.title.trim()
    ? report.title.trim()
    : 'Bug report'
  const sections: string[] = [`# ${title}`]

  if (typeof report.description === 'string' && report.description.trim()) {
    sections.push(report.description.trim())
  }

  if (report.ast !== undefined) {
    sections.push('## AST', jsonBlock(report.ast))
  }

  if (report.selection !== undefined) {
    const items = Array.isArray(report.selection) ? report.selection : null
    sections.push(items ? `## Selection (${items.length} items)` : '## Selection')
    sections.push(jsonBlock(report.selection))
  }

  if (report.history !== undefined) {
    const entries = Array.isArray(report.history) ? report.history : null
    if (!entries) {
      sections.push('## Edit history', jsonBlock(report.history))
    } else {
      // The panel attaches {mutation, label} pairs; the label is the human index
      // into the history, the mutation the payload a maintainer replays.
      sections.push(`## Edit history (${entries.length} items)`)
      entries.forEach((entry, i) => {
        const e = entry as { mutation?: unknown; label?: unknown }
        const label = typeof e?.label === 'string' ? e.label : `Entry ${i + 1}`
        sections.push(`${i + 1}. ${label}`, jsonBlock(e?.mutation ?? entry))
      })
    }
  }

  for (const [key, value] of Object.entries(report)) {
    if (SHAPED_KEYS.includes(key)) continue
    sections.push(`## ${key}`, jsonBlock(value))
  }

  return sections.join('\n\n') + '\n'
}

// Land the report at the browser download edge, the same way STEP/STL export
// already does (Blob -> object URL -> anchor click).
export class DownloadBugReportSink implements BugReportSink {
  async send(report: BugReport): Promise<void> {
    const blob = new Blob([formatBugReportMarkdown(report)], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bug-report-${Date.now()}.md`
    a.click()
    URL.revokeObjectURL(url)
  }
}
