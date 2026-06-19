import * as React from 'react'
import { BugReporter, type BugReportAttachments } from '@/components/dialogs/BugReporter'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { http } from '@/utils/core/httpClient'
import { hasBackend } from '@/config/capabilities'
import type { Mutation } from '@/types/cad'

type UndoEntry = { doc: unknown; mutation: Mutation }

interface PartDebugPanelProps {
  debugOpen: boolean
}

export default function PartDebugPanel({ debugOpen }: PartDebugPanelProps) {
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const selection = useSketchEditorStore(s => s.normalSelection)

  const undoStack = usePartEditorStore(s => s.undoStack) as UndoEntry[]
  const redoStack = usePartEditorStore(s => s.redoStack) as UndoEntry[]
  const doc = usePartEditorStore(s => s.doc)

  const [debugTab, setDebugTab] = React.useState<'selection' | 'bug-report' | 'undo-redo'>('selection')
  const [bugReportForm, setBugReportForm] = React.useState({ title: '', description: '' })
  const [bugReporting, setBugReporting] = React.useState(false)
  const [bugReportError, setBugReportError] = React.useState<string | null>(null)
  const [bugReportAttachments, setBugReportAttachments] = React.useState<BugReportAttachments>({
    ast: true,
    selection: true,
    history: true,
    historyCount: 5,
  })

  const handleSubmitBugReport = async () => {
    if (!bugReportForm.title.trim()) {
      setBugReportError('Title is required')
      return
    }
    setBugReporting(true)
    setBugReportError(null)
    try {
      const report: Record<string, unknown> = {
        title: bugReportForm.title,
        description: bugReportForm.description,
      }
      if (bugReportAttachments.ast) report.ast = doc
      if (bugReportAttachments.selection) report.selection = [...selection]
      if (bugReportAttachments.history) {
        const historyItems = undoStack.slice(-bugReportAttachments.historyCount).map(entry => ({
          mutation: entry.mutation,
          label: describeMutation(entry.mutation),
        }))
        report.history = historyItems
      }
      if (hasBackend) {
        await http.postJson('/api/bug-report', report)
      } else {
        // No backend: serialise the report to JSON and trigger a browser download.
        const bytes = JSON.stringify(report, null, 2)
        const blob = new Blob([bytes], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `bug-report-${Date.now()}.json`
        a.click()
        URL.revokeObjectURL(url)
      }
      alert('Bug report submitted successfully!')
      setDebugTab('selection')
    } catch (e) {
      setBugReportError(`Failed to submit: ${e}`)
    } finally {
      setBugReporting(false)
    }
  }

  if (!debugOpen) return null

  return (
    <aside className="debug-drawer">
      <div className="debug-tabs">
        <button className={`debug-tab ${debugTab === 'selection' ? 'active' : ''}`} onClick={() => setDebugTab('selection')}>Selection</button>
        <button className={`debug-tab ${debugTab === 'bug-report' ? 'active' : ''}`} onClick={() => setDebugTab('bug-report')}>Bug Report</button>
        <button className={`debug-tab ${debugTab === 'undo-redo' ? 'active' : ''}`} onClick={() => setDebugTab('undo-redo')}>Undo</button>
      </div>
      {debugTab === 'selection' && (
        <div className="debug-content">
          <div className="debug-section">
            <div className="debug-section-title">Hover</div>
            {hoveredSelectionId ? <div className="debug-value">{hoveredSelectionId}</div>
              : hoveredVertexId ? <div className="debug-value">{hoveredVertexId}</div>
              : <div className="debug-empty">none</div>}
          </div>
          <div className="debug-section">
            <div className="debug-section-title">Normal ({selection.size})</div>
            {selection.size === 0 ? <div className="debug-empty">none</div>
              : [...selection].map(id => <div key={id} className="debug-value">{id}</div>)}
          </div>
        </div>
      )}
      {debugTab === 'bug-report' && (
        <BugReporter
          bugReportForm={bugReportForm}
          setBugReportForm={setBugReportForm}
          bugReporting={bugReporting}
          bugReportError={bugReportError}
          bugReportAttachments={bugReportAttachments}
          setBugReportAttachments={setBugReportAttachments}
          onSubmit={handleSubmitBugReport}
          selectionCount={selection.size}
          undoStackCount={undoStack.length}
        />
      )}
      {debugTab === 'undo-redo' && (
        <div className="debug-content">
          <div className="debug-section">
            <div className="debug-section-title">Undo Stack ({undoStack.length})</div>
            {undoStack.length === 0 ? <div className="debug-empty">empty</div>
              : undoStack.map((entry, idx) => (
                <div key={idx} className="debug-value">
                  <div>[{idx}] {describeMutation(entry.mutation)}</div>
                  <div style={{ fontSize: '9px', color: '#666', marginTop: '2px' }}>
                    {JSON.stringify(entry.mutation).slice(0, 100)}
                  </div>
                </div>
              ))}
          </div>
          <div className="debug-section">
            <div className="debug-section-title">Redo Stack ({redoStack.length})</div>
            {redoStack.length === 0 ? <div className="debug-empty">empty</div>
              : redoStack.map((entry, idx) => (
                <div key={idx} className="debug-value">
                  <div>[{idx}] {describeMutation(entry.mutation)}</div>
                  <div style={{ fontSize: '9px', color: '#666', marginTop: '2px' }}>
                    {JSON.stringify(entry.mutation).slice(0, 100)}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </aside>
  )
}
