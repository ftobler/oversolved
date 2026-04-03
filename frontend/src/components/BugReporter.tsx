import React from 'react'
import './BugReporter.css'

export interface BugReportAttachments {
  ast: boolean
  selection: boolean
  solveResults: boolean
  internalState: boolean
  history: boolean
  historyCount: number
}

interface BugReporterProps {
  bugReportForm: { title: string; description: string }
  setBugReportForm: (f: (prev: { title: string; description: string }) => { title: string; description: string }) => void
  bugReporting: boolean
  bugReportError: string | null
  bugReportAttachments: BugReportAttachments
  setBugReportAttachments: (a: (prev: BugReportAttachments) => BugReportAttachments) => void
  onSubmit: () => void
  selectionCount?: number
  hasSolveResults?: boolean
  undoStackCount?: number
}

export const BugReporter: React.FC<BugReporterProps> = ({
  bugReportForm,
  setBugReportForm,
  bugReporting,
  bugReportError,
  bugReportAttachments,
  setBugReportAttachments,
  onSubmit,
  selectionCount = 0,
  hasSolveResults = false,
  undoStackCount = 0,
}) => {
  return (
    <div className="debug-content">
      <div className="debug-section">
        <div className="debug-section-title">Submit Bug Report</div>
        <input
          type="text"
          placeholder="Title"
          value={bugReportForm.title}
          onChange={(e) => setBugReportForm(f => ({ ...f, title: e.target.value }))}
          disabled={bugReporting}
          className="bug-report-input"
        />
        <textarea
          placeholder="Description (what went wrong?)"
          value={bugReportForm.description}
          onChange={(e) => setBugReportForm(f => ({ ...f, description: e.target.value }))}
          disabled={bugReporting}
          className="bug-report-textarea"
        />
        <button
          onClick={onSubmit}
          disabled={bugReporting}
          className="bug-report-submit-btn"
        >
          {bugReporting ? 'Submitting...' : 'Submit Report'}
        </button>
        {bugReportError && (
          <div className="bug-report-error">
            {bugReportError}
          </div>
        )}
        <div className="bug-report-attachments">
          <div className="debug-section-title">Attached Data</div>
          <div className="bug-report-attachments-list">
            <label className="bug-report-checkbox-label">
              <input
                type="checkbox"
                checked={bugReportAttachments.ast}
                onChange={(e) => setBugReportAttachments(a => ({ ...a, ast: e.target.checked }))}
                disabled={bugReporting}
              />
              AST (current document)
            </label>
            <label className="bug-report-checkbox-label">
              <input
                type="checkbox"
                checked={bugReportAttachments.selection}
                onChange={(e) => setBugReportAttachments(a => ({ ...a, selection: e.target.checked }))}
                disabled={bugReporting}
              />
              Selection ({selectionCount} items)
            </label>
            {hasSolveResults && (
              <label className="bug-report-checkbox-label">
                <input
                  type="checkbox"
                  checked={bugReportAttachments.solveResults}
                  onChange={(e) => setBugReportAttachments(a => ({ ...a, solveResults: e.target.checked }))}
                  disabled={bugReporting}
                />
                Solver result
              </label>
            )}
            <label className="bug-report-checkbox-label">
              <input
                type="checkbox"
                checked={bugReportAttachments.internalState}
                onChange={(e) => setBugReportAttachments(a => ({ ...a, internalState: e.target.checked }))}
                disabled={bugReporting}
              />
              Edit mode & tool state
            </label>
            <label className="bug-report-checkbox-label">
              <input
                type="checkbox"
                checked={bugReportAttachments.history}
                onChange={(e) => setBugReportAttachments(a => ({ ...a, history: e.target.checked }))}
                disabled={bugReporting}
              />
              Edit history (last
              <input
                type="number"
                min="1"
                max={undoStackCount || 50}
                value={bugReportAttachments.historyCount}
                onChange={(e) => setBugReportAttachments(a => ({ ...a, historyCount: Math.max(1, Math.min(undoStackCount, parseInt(e.target.value) || 1)) }))}
                disabled={bugReporting || !bugReportAttachments.history}
                className="bug-report-history-input"
              />
              of {undoStackCount} items)
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
