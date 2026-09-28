import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Mutation } from '@/types/cad'
import { executeCommand } from '@/utils/core/commandRegistry'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { usePartEditorStore } from '@/stores/partEditorStore'
import AppHeader from '@/components/layout/AppHeader'
import Breadcrumb from '@/components/layout/Breadcrumb'
import SaveButton from '@/components/layout/SaveButton'

type StackEntry = { mutation: Mutation }

interface PartToolbarProps {
  docName: string | null
  onRename: (name: string) => Promise<boolean>
  // Resolves to whether the bytes actually landed, so a failed save can be
  // told apart from a successful one.
  handleSave: () => boolean | Promise<boolean>
  handleClone: () => void
  // Header-right slot (the page's debug toggles). The header owns the layout;
  // the page owns the state behind the buttons.
  rightContent?: ReactNode
}

export default function PartToolbar({
  docName,
  onRename,
  handleSave,
  handleClone,
  rightContent,
}: PartToolbarProps) {
  const undoStack = usePartEditorStore(s => s.undoStack) as StackEntry[]
  const redoStack = usePartEditorStore(s => s.redoStack) as StackEntry[]
  const [undoHover, setUndoHover] = useState(false)
  const [redoHover, setRedoHover] = useState(false)

  return (
    <AppHeader rightContent={rightContent} breadcrumb={<Breadcrumb docName={docName} onRename={onRename} />}>
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
          <div className="undo-redo-tooltip redo-tooltip">{/* dialog */}
            <div className="undo-redo-tooltip-header">Redo ({redoStack.length}) Ctrl+Shift+Z</div>
            {redoStack.slice(-5).reverse().map((entry, i) => (
              <div key={i} className="undo-redo-tooltip-item">
                {describeMutation(entry.mutation)}
              </div>
            ))}
          </div>
        )}
      </div>
      <SaveButton save={handleSave} />
      <button className="toolbar-btn" aria-label="Clone document" title="Clone document" onClick={handleClone}>
        <span className="material-icons-outlined">file_copy</span>
      </button>
    </AppHeader>
  )
}
