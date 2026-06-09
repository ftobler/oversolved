import { useState } from 'react'
import type { Mutation } from '@/types/cad'
import { executeCommand } from '@/stores/commandRegistry'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { usePartEditorStore } from '@/stores/partEditorStore'
import AppHeader from '@/components/layout/AppHeader'

type StackEntry = { mutation: Mutation }

interface PartToolbarProps {
  readOnly: boolean
  permission: string | null
  docName: string | null
  onRename: (name: string) => Promise<boolean>
  handleSave: () => void
  handleClone: () => void
  onShare: () => void
}

export default function PartToolbar({
  readOnly,
  permission,
  docName,
  onRename,
  handleSave,
  handleClone,
  onShare,
}: PartToolbarProps) {
  const undoStack = usePartEditorStore(s => s.undoStack) as StackEntry[]
  const redoStack = usePartEditorStore(s => s.redoStack) as StackEntry[]
  const [undoHover, setUndoHover] = useState(false)
  const [redoHover, setRedoHover] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docName ?? '')
  const [saveState, setSaveState] = useState<'idle' | 'success'>('idle')

  const handleSaveClick = () => {
    handleSave()
    setSaveState('success')
    setTimeout(() => setSaveState('idle'), 1500)
  }

  const handleRename = async () => {
    const trimmed = editName.trim()
    if (!trimmed || trimmed === docName) {
      setIsEditing(false)
      return
    }
    const success = await onRename(trimmed)
    if (success) {
      setIsEditing(false)
    } else {
      setEditName(docName ?? '')
    }
  }

  return (
    <AppHeader>
      <div className="undo-redo-btn-group">
        <button
          className="toolbar-btn"
          aria-label="Undo"
          onClick={() => executeCommand('undo')}
          disabled={undoStack.length === 0}
          onMouseEnter={() => setUndoHover(true)}
          onMouseLeave={() => setUndoHover(false)}
        >
          <span className="material-icons-outlined">undo</span>
        </button>
        {undoHover && undoStack.length > 0 && (
          <div className="undo-redo-tooltip undo-tooltip">
            <div className="undo-redo-tooltip-header">Undo ({undoStack.length}) Ctrl+Z</div>
            {undoStack.slice(-5).reverse().map((entry, i) => (
              <div key={i} className="undo-redo-tooltip-item">
                {describeMutation(entry.mutation)}
              </div>
            ))}
          </div>
        )}
        <button
          className="toolbar-btn"
          aria-label="Redo"
          onClick={() => executeCommand('redo')}
          disabled={redoStack.length === 0}
          onMouseEnter={() => setRedoHover(true)}
          onMouseLeave={() => setRedoHover(false)}
        >
          <span className="material-icons-outlined">redo</span>
        </button>
        {redoHover && redoStack.length > 0 && (
          <div className="undo-redo-tooltip redo-tooltip">
            <div className="undo-redo-tooltip-header">Redo ({redoStack.length}) Ctrl+Shift+Z</div>
            {redoStack.slice(-5).reverse().map((entry, i) => (
              <div key={i} className="undo-redo-tooltip-item">
                {describeMutation(entry.mutation)}
              </div>
            ))}
          </div>
        )}
      </div>
      <button className="toolbar-btn" aria-label="Save" title="Save" onClick={handleSaveClick} disabled={readOnly}>
        <span className="material-icons-outlined">{saveState === 'success' ? 'check' : 'save'}</span>
      </button>
      <button className="toolbar-btn" aria-label="Clone document" title="Clone document" onClick={handleClone}>
        <span className="material-icons-outlined">file_copy</span>
      </button>
      {permission === 'owner' && (
        <button
          className="toolbar-btn"
          aria-label="Share document"
          title="Share document"
          onClick={onShare}
          disabled={readOnly}
        >
          <span className="material-icons-outlined">share</span>
        </button>
      )}
      {readOnly && (
        <span className="doc-name" style={{ color: '#ef5350', fontSize: '12px', marginLeft: '8px' }}>
          <span className="material-icons-outlined" style={{ fontSize: '14px', verticalAlign: 'middle' }}>lock</span>
          {' '}View Only
        </span>
      )}
      {isEditing ? (
        <input
          className="doc-name-input"
          value={editName}
          onChange={e => setEditName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={e => {
            if (e.key === 'Enter') handleRename()
          }}
          autoFocus
        />
      ) : (
        <button className="doc-name" aria-label="Edit document name" onClick={() => {
          setEditName(docName ?? '')
          setIsEditing(true)
        }}>
          {docName}
        </button>
      )}
    </AppHeader>
  )
}
