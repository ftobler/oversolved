// The crash-report replay helper: every crash fix lands with a regression
// test that rebuilds the failing state from the report itself. The replayable
// half of a report is the command journal's repro (baseline doc + mutation
// tail + id seed), so replaying is the drive surface's verified loop, not a
// second implementation: the caller hands in a fresh session and a settle
// step (the real one awaits the solve), and the outcome names the exact step
// where reproduction diverges.
import type { ReplayOutcome, ReplaySession } from '@/drive/replay'
import { replayJournal } from '@/drive/replay'
import type { CrashReportRecord } from '@/recovery/crashReports'

/**
 * Replay a crash report's recorded mutations. Returns null when the report
 * carries nothing recorded (it crashed before any change or after a rewind),
 * which is not a failure: there is simply no sequence to reproduce.
 */
export function replayCrashReport(
  report: CrashReportRecord,
  session: ReplaySession,
  settle?: () => Promise<void> | void,
): Promise<ReplayOutcome> | null {
  if (!report.repro) return null
  return replayJournal(report.repro, session, settle)
}

/** The hash a report's repro must end on: the last recorded step's after-hash. */
export function crashReportFinalHash(report: CrashReportRecord): string | null {
  const journal = report.repro?.journal
  if (!journal || journal.length === 0) return null
  return journal[journal.length - 1].docHashAfter
}
