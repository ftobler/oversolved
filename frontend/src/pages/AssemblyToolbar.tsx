import { useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { executeCommand } from '@/utils/core/commandRegistry'
import { useAssemblyStore, type AssemblyUndoEntry } from '@/stores/assemblyStore'
import AppHeader from '@/components/layout/AppHeader'

interface AssemblyToolbarProps {
  readOnly: boolean
  docName: string | null
  onRename: (name: string) => Promise<boolean>
  // Resolves to whether the bytes actually landed, so a failed save can be
  // told apart from a successful one.
  handleSave: () => boolean | Promise<boolean>
  handleClone: () => void
  // Header-right slot (the page's debug toggles). Mirrors PartToolbar.
  rightContent?: ReactNode
}

// Assembly counterpart to PartToolbar: the same AppHeader shell (logo, burger,
// account) with the save / clone / rename controls, so the assembly editor wears
// the same titlebar as the part editor. The undo/redo group mirrors the part
// toolbar, gated on the assembly store's stacks.
export default function AssemblyToolbar({
  readOnly,
  docName,
  onRename,
  handleSave,
  handleClone,
  rightContent,
}: AssemblyToolbarProps) {
  const undoStack = useAssemblyStore(s => s.undoStack) as AssemblyUndoEntry[]
  const redoStack = useAssemblyStore(s => s.redoStack) as AssemblyUndoEntry[]
  const [undoHover, setUndoHover] = useState(false)
  const [redoHover, setRedoHover] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docName ?? '')
  const [saveState, setSaveState] = useState<'idle' | 'success'>('idle')
  // Tracks the pending "success" -> "idle" reset so it can be cleared on
  // unmount. Without this a stray timer fires setState after the component
  // (and, in tests, the whole jsdom environment) is gone. Mirrors
  // PartToolbar.tsx's identical fix (5209cd17).
  const saveResetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The save resolves after an await, so it can outlive this component; any
  // state work past that await checks this ref. Re-armed in the effect body so
  // StrictMode's mount/unmount/mount replay cannot leave it stuck false.
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (saveResetTimeout.current !== null) clearTimeout(saveResetTimeout.current)
    }
  }, [])

  const handleSaveClick = async () => {
    // A new attempt retires any previous success flash up front; only this
    // save's own outcome may bring the check back.
    setSaveState('idle')
    // The green check means the bytes landed: only a resolved true may flash
    // it. On a failure the plain save icon stays; the error banner beside the
    // toolbar already reports why, so no second affordance is raised here.
    const saved = await handleSave()
    // A resolve after unmount must not schedule the reset timer: the cleanup
    // already ran and nothing would ever clear it.
    if (!saved || !mountedRef.current) return
    setSaveState('success')
    if (saveResetTimeout.current !== null) clearTimeout(saveResetTimeout.current)
    saveResetTimeout.current = setTimeout(() => setSaveState('idle'), 1500)
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
    <AppHeader rightContent={rightContent}>
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
          <div className="undo-redo-tooltip undo-tooltip">{/* dialog */}
            <div className="undo-redo-tooltip-header">Undo ({undoStack.length}) Ctrl+Z</div>
            {undoStack.slice(-5).reverse().map((entry, i) => (
              <div key={i} className="undo-redo-tooltip-item">{entry.label}</div>
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
          <div className="undo-redo-tooltip redo-tooltip">{/* dialog */}
            <div className="undo-redo-tooltip-header">Redo ({redoStack.length}) Ctrl+Shift+Z</div>
            {redoStack.slice(-5).reverse().map((entry, i) => (
              <div key={i} className="undo-redo-tooltip-item">{entry.label}</div>
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
          {docName || 'Untitled Assembly'}
        </button>
      )}
    </AppHeader>
  )
}
