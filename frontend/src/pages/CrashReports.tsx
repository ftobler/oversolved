import { useCallback, useEffect, useState } from 'react'
import {
  buildCrashReportZip,
  crashReportFilename,
  deleteCrashReport,
  listCrashReports,
  type CrashReportRecord,
} from '@/recovery/crashReports'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { errorMessage } from '@/utils/core/errorMessage'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import '@/pages/CrashReports.css'

// The local crash reports: what the error paths recorded, newest first. Nothing
// is ever sent anywhere, so this page is the only place they can be read; the
// zip export is what turns one into a bug report that carries a replay.
export default function CrashReports() {
  const [reports, setReports] = useState<CrashReportRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setReports(await listCrashReports())
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Could not read the crash reports'))
      setReports([])
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleDownload = async (report: CrashReportRecord): Promise<void> => {
    setBusyId(report.id)
    try {
      const bytes = await buildCrashReportZip(report)
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), crashReportFilename(report))
    } catch (e) {
      setError(errorMessage(e, 'Could not build the crash report zip'))
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (report: CrashReportRecord): Promise<void> => {
    setBusyId(report.id)
    try {
      await deleteCrashReport(report.id)
      await refresh()
    } catch (e) {
      setError(errorMessage(e, 'Could not delete the crash report'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="crash-reports-page">
      <h1>Crash reports</h1>
      <p className="crash-reports-intro">
        When the app hits an uncaught error, a worker trap or an editor crash, it records the
        details here, locally. Each report carries the document and its recent edits, so
        exporting one gives a bug report something to replay.
      </p>
      {error && <p className="crash-reports-error">{error}</p>}
      {reports === null && <p className="crash-reports-status">Loading...</p>}
      {reports !== null && reports.length === 0 && (
        <p className="crash-reports-status">No crash reports. That is the good case.</p>
      )}
      {reports !== null && reports.length > 0 && (
        <ul className="crash-reports-list">
          {reports.map(report => (
            <li key={report.id} className="crash-report-row">
              <div className="crash-report-info">
                <div className="crash-report-headline">
                  <span className={`crash-report-source crash-report-source-${report.source}`}>{report.source}</span>
                  <span className="crash-report-message">{report.message}</span>
                </div>
                <div className="crash-report-meta">
                  {formatRelativeDate(new Date(report.at).toISOString())}
                  {report.docName ? ` - ${report.docName}` : report.docId ? ` - ${report.docId}` : ''}
                  {report.repro && report.repro.journal.length > 0
                    ? ` - ${report.repro.journal.length} recorded edit(s)`
                    : ' - no recorded edits'}
                  {` - app ${report.appVersion}`}
                </div>
              </div>
              <div className="crash-report-actions">
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={busyId === report.id}
                  onClick={() => { void handleDownload(report) }}
                >
                  Download zip
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={busyId === report.id}
                  onClick={() => { void handleDelete(report) }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
