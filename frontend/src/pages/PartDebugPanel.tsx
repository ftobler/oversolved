import * as React from 'react'
import { BugReporter, type BugReportAttachments } from '../components/BugReporter'
import CacheInspector from '../components/CacheInspector'
import { describeMutation } from '../utils/mutationDescriptions'
import type { Mutation } from '../types/cad'

type UndoEntry = { doc: unknown; mutation: Mutation }

interface PartDebugPanelProps {
  debugOpen: boolean
  debugTab: 'selection' | 'bug-report' | 'undo-redo' | 'cache-inspector'
  setDebugTab: React.Dispatch<React.SetStateAction<'selection' | 'bug-report' | 'undo-redo' | 'cache-inspector'>>
  hoveredEntityId: string | null
  hoveredVertexId: string | null
  hoveredPlaneId: string | null
  hoveredSurfaceId: string | null
  hovered3DSurfaceId: string | null
  dynamicSelection: Set<string>
  selection: Set<string>
  bugReportForm: { title: string; description: string }
  setBugReportForm: React.Dispatch<React.SetStateAction<{ title: string; description: string }>>
  bugReporting: boolean
  bugReportError: string | null
  bugReportAttachments: BugReportAttachments
  setBugReportAttachments: React.Dispatch<React.SetStateAction<BugReportAttachments>>
  onSubmitBugReport: () => void
  editingFeatureId: string | null
  solveResults: Record<string, unknown> | undefined
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
}

export default function PartDebugPanel({
  debugOpen, debugTab, setDebugTab,
  hoveredEntityId, hoveredVertexId, hoveredPlaneId, hoveredSurfaceId, hovered3DSurfaceId,
  dynamicSelection, selection,
  bugReportForm, setBugReportForm, bugReporting, bugReportError,
  bugReportAttachments, setBugReportAttachments, onSubmitBugReport,
  editingFeatureId, solveResults, undoStack, redoStack,
}: PartDebugPanelProps) {
  if (!debugOpen) return null

  return (
    <aside className="debug-drawer">
      <div className="debug-tabs">
        <button className={`debug-tab ${debugTab === 'selection' ? 'active' : ''}`} onClick={() => setDebugTab('selection')}>Selection</button>
        <button className={`debug-tab ${debugTab === 'bug-report' ? 'active' : ''}`} onClick={() => setDebugTab('bug-report')}>Bug Report</button>
        <button className={`debug-tab ${debugTab === 'undo-redo' ? 'active' : ''}`} onClick={() => setDebugTab('undo-redo')}>Undo</button>
        <button className={`debug-tab ${debugTab === 'cache-inspector' ? 'active' : ''}`} onClick={() => setDebugTab('cache-inspector')}>Cache</button>
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
          onSubmit={onSubmitBugReport}
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
      {debugTab === 'cache-inspector' && <CacheInspector />}
    </aside>
  )
}
