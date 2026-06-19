// Telemetry capability: where a bug report goes.
//
// The HTTP build POSTs the report to the PDM backend; the static (zero-backend)
// build has no server, so the same report object is serialised to a JSON file
// the user downloads instead. The debug panel calls `bugReportSink.send(report)`
// and stays ignorant of which transport it got -- absence of a server is a
// different wiring, not a branch the view carries.
import { http } from '@/utils/core/httpClient'
import { backend, type Backend } from '@/config/capabilities'

export type BugReport = Record<string, unknown>

export interface BugReportSink {
  send(report: BugReport): Promise<void>
}

class HttpBugReportSink implements BugReportSink {
  async send(report: BugReport): Promise<void> {
    await http.postJson('/api/bug-report', report)
  }
}

// No backend: land the report at the browser download edge, the same way local
// STEP/STL export already does (Blob -> object URL -> anchor click).
class DownloadBugReportSink implements BugReportSink {
  async send(report: BugReport): Promise<void> {
    const bytes = JSON.stringify(report, null, 2)
    const blob = new Blob([bytes], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bug-report-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
}

// Pure factory (testable without touching the env).
export function createBugReportSink(b: Backend): BugReportSink {
  return b === 'static' ? new DownloadBugReportSink() : new HttpBugReportSink()
}

// Boot-time singleton, chosen from the build flag.
export const bugReportSink: BugReportSink = createBugReportSink(backend)
