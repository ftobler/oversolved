import * as React from 'react'
import { BugReporter, type BugReportAttachments } from '@/components/BugReporter'
import { describeMutation } from '@/utils/mutationDescriptions'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { http } from '@/utils/httpClient'
import type { Mutation } from '@/types/cad'

type UndoEntry = { doc: unknown; mutation: Mutation }

interface PartDebugPanelProps {
  debugOpen: boolean
  mode: string
}

export default function PartDebugPanel({ debugOpen, mode }: PartDebugPanelProps) {
  const hoveredEntityId = useSketchEditorStore(s => s.hoveredEntityId)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredPlaneId = useSketchEditorStore(s => s.hoveredPlaneId)
  const hoveredSurfaceId = useSketchEditorStore(s => s.hoveredSurfaceId)
  const hovered3DSurfaceId = useSketchEditorStore(s => s.hovered3DSurfaceId)
  const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const selection = useSketchEditorStore(s => s.normalSelection)

  const editingFeatureId = usePartEditorStore(s => s.editingFeatureId)
  const activeSketchFeatureId = usePartEditorStore(s => s.activeSketchFeatureId)
  const solveResults = usePartEditorStore(s => s.solveResults)
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
    solveResults: true,
    internalState: true,
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
      const activeTool = useSketchEditorStore.getState().activeTool
      const report: Record<string, unknown> = {
        title: bugReportForm.title,
        description: bugReportForm.description,
      }
      if (bugReportAttachments.ast) report.ast = doc
      if (bugReportAttachments.selection) report.selection = [...selection]
      if (bugReportAttachments.solveResults) {
        report.solveResults = editingFeatureId && solveResults?.[editingFeatureId] ? solveResults[editingFeatureId] : null
      }
      if (bugReportAttachments.internalState) {
        report.internalState = {
          mode,
          activeTool,
          editingFeatureId,
          activeSketchFeatureId,
        }
      }
      if (bugReportAttachments.history) {
        const historyItems = undoStack.slice(-bugReportAttachments.historyCount).map(entry => ({
          mutation: entry.mutation,
          label: describeMutation(entry.mutation),
        }))
        report.history = historyItems
      }
      await http.postJson('/api/bug-report', report)
      setBugReportForm({ title: '', description: '' })
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
            {hoveredEntityId ? <div className="debug-value">{hoveredEntityId}</div>
              : hoveredVertexId ? <div className="debug-value">{hoveredVertexId}</div>
              : hoveredPlaneId ? <div className="debug-value">{hoveredPlaneId}</div>
              : hoveredSurfaceId ? <div className="debug-value">{hoveredSurfaceId}</div>
              : hovered3DSurfaceId ? <div className="debug-value">{hovered3DSurfaceId}</div>
              : <div className="debug-empty">none</div>}
          </div>
          <div className="debug-section">
            <div className="debug-section-title">Dynamic ({dynamicSelection.size})</div>
            {dynamicSelection.size === 0 ? <div className="debug-empty">none</div>
              : [...dynamicSelection].map(id => <div key={id} className="debug-value">{id}</div>)}
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
          hasSolveResults={!!(editingFeatureId && solveResults?.[editingFeatureId])}
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
