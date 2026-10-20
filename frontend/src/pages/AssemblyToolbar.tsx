import { useState } from 'react'
import type { ReactNode } from 'react'
import { useCommandRegistry } from '@/contexts/CommandRegistryContext'
import { useAssemblyStore, type AssemblyUndoEntry } from '@/stores/assemblyStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { isSessionOpen } from '@/utils/assemblyEditingSubject'
import AppHeader from '@/components/layout/AppHeader'
import Breadcrumb from '@/components/layout/Breadcrumb'
import SaveButton from '@/components/layout/SaveButton'
import exportIcon from '@/assets/icons/icon-download.svg'

interface AssemblyToolbarProps {
  docName: string | null
  onRename: (name: string) => Promise<boolean>
  // Resolves to whether the bytes actually landed, so a failed save can be
  // told apart from a successful one.
  handleSave: () => boolean | Promise<boolean>
  handleClone: () => void
  onExport: () => void
  // Header-right slot (the page's debug toggles). Mirrors PartToolbar.
  rightContent?: ReactNode
}

// Assembly counterpart to PartToolbar: the same AppHeader shell (burger, logo,
// help) with the save / clone / rename controls, so the assembly editor wears
// the same titlebar as the part editor. The undo/redo group mirrors the part
// toolbar, gated on the assembly store's stacks.

// dispatchKey resolves a key through ASSEMBLY_KEYMAP only while the assembly
// editor is the active one; a button click has no such routing, so the toolbar
// has to take the same gate or a co-mount (split view, staged navigation) would
// run whichever engine registered `undo` last while the disabled state below
// reads the assembly store. The gate is strict here, exactly as dispatchKey's
// assembly branch is. Read through a subscription so a mode change re-renders
// the gate, which is the whole point of it.

export default function AssemblyToolbar({
  docName,
  onRename,
  handleSave,
  handleClone,
  onExport,
  rightContent,
}: AssemblyToolbarProps) {
  const undoStack = useAssemblyStore(s => s.undoStack) as AssemblyUndoEntry[]
  const redoStack = useAssemblyStore(s => s.redoStack) as AssemblyUndoEntry[]
  const registry = useCommandRegistry()
  // The disabled state has to agree with the gate: a button that reads enabled
  // from the registry and then refuses to run is worse than a disabled one.
  // The registry's undo/redo predicates read the assembly store's stacks, the
  // same source the tooltips below read.
  const ownsDocument = useEditorModeStore(s => s.activeEditor) === 'assembly'
  const undoDisabled = !ownsDocument || registry.enabled('undo') !== true
  const redoDisabled = !ownsDocument || registry.enabled('redo') !== true
  // The same one-editor session closeOpenEditor acts on: an export mid-edit
  // would read a half-authored assembly. Export is a direct page callback, so
  // it does not take the undo/redo mode gate.
  const editingSubject = useAssemblyStore(s => s.editingSubject)
  const editInProgress = isSessionOpen(editingSubject)
  const [undoHover, setUndoHover] = useState(false)
  const [redoHover, setRedoHover] = useState(false)

  return (
    <AppHeader hasFileActions rightContent={rightContent} breadcrumb={<Breadcrumb docName={docName} fallbackName="Untitled Assembly" onRename={onRename} />}>
      <div className="undo-redo-btn-group">
        <button
          className="toolbar-btn"
          aria-label="Undo"
          onClick={() => { if (ownsDocument) registry.execute('undo') }}
          disabled={undoDisabled}
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
          onClick={() => { if (ownsDocument) registry.execute('redo') }}
          disabled={redoDisabled}
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
      <SaveButton save={handleSave} />
      <button className="toolbar-btn" aria-label="Clone document" title="Clone document" onClick={handleClone}>
        <span className="material-icons-outlined">file_copy</span>
      </button>
      <div className="app-header-separator" />
      <button
        className="toolbar-btn"
        aria-label="Export assembly"
        title={editInProgress ? 'Finish the edit to export' : 'Export assembly'}
        onClick={onExport}
        disabled={editInProgress}
      >
        <img src={exportIcon} alt="" />
      </button>
    </AppHeader>
  )
}
