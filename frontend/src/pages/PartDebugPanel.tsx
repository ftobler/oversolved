import { useState } from 'react'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useDevSettingsStore } from '@/stores/devSettingsStore'
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

  const validateOnRebuild = useDevSettingsStore(s => s.validateOnRebuild)
  const setValidateOnRebuild = useDevSettingsStore(s => s.setValidateOnRebuild)

  const [debugTab, setDebugTab] = useState<'selection' | 'undo-redo'>('selection')

  if (!debugOpen) return null

  return (
    <aside className="debug-drawer">
      <div className="debug-tabs">
        <button className={`debug-tab ${debugTab === 'selection' ? 'active' : ''}`} onClick={() => setDebugTab('selection')}>Selection</button>
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
          <div className="debug-section">
            <div className="debug-section-title">Rebuild</div>
            <label className="debug-value" style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={validateOnRebuild}
                onChange={e => setValidateOnRebuild(e.target.checked)}
              />
              validate (fresh rebuild diff, doubles solve)
            </label>
          </div>
        </div>
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
