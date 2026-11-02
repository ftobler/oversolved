import { useState } from 'react'
import type { ReactNode } from 'react'
import type { LengthUnit, Mutation } from '@/types/cad'
import { useCommandRegistry } from '@/contexts/CommandRegistryContext'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { LENGTH_UNIT_LABEL, lengthUnitOf } from '@/utils/lengthUnit'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { useEditorState } from '@/hooks/useEditorState'
import { domHandleProps } from '@/picking'
import AppHeader from '@/components/layout/AppHeader'
import Breadcrumb from '@/components/layout/Breadcrumb'
import SaveButton from '@/components/layout/SaveButton'
import featureImportIcon from '@/assets/icons/icon-upload.svg'
import featureExportIcon from '@/assets/icons/icon-download.svg'

type StackEntry = { mutation: Mutation }

// dispatchKey routes every key on useEditorModeStore; the toolbar's clicks go
// through the page's own registry (via context), but the mode gate stays for
// the same co-mount reason: a split view could render both toolbars against
// one document while only the active editor should act. An unresolved mode is
// the sketch/part branch of dispatchKey, so only the assembly editor locks
// this toolbar out. Read through a subscription, not getState: the gate exists
// for the moment the mode changes, and a render-time sample would not re-run.

interface PartToolbarProps {
  docName: string | null
  onRename: (name: string) => Promise<boolean>
  // Resolves to whether the bytes actually landed, so a failed save can be
  // told apart from a successful one.
  handleSave: () => boolean | Promise<boolean>
  handleClone: () => void
  onImport: () => void
  onExport: () => void
  // The document's length unit. Stored numbers keep their values; the unit says
  // what they mean and the STEP/STL export scales an inch document to mm.
  lengthUnit: LengthUnit
  onSetLengthUnit: (unit: LengthUnit) => void
  // Header-right slot (the page's debug toggles). The header owns the layout;
  // the page owns the state behind the buttons.
  rightContent?: ReactNode
}

export default function PartToolbar({
  docName,
  onRename,
  handleSave,
  handleClone,
  onImport,
  onExport,
  lengthUnit,
  onSetLengthUnit,
  rightContent,
}: PartToolbarProps) {
  const undoStack = usePartEditorStore(s => s.undoStack) as StackEntry[]
  const redoStack = usePartEditorStore(s => s.redoStack) as StackEntry[]
  const registry = useCommandRegistry()
  // The disabled state has to agree with the gate: a button that reads enabled
  // from the registry and then refuses to run is worse than a disabled one.
  // The registry's undo/redo predicates read the session history, the source
  // the stacks above mirror.
  const ownsDocument = useEditorModeStore(s => s.activeEditor) !== 'assembly'
  const undoDisabled = !ownsDocument || registry.enabled('undo') !== true
  const redoDisabled = !ownsDocument || registry.enabled('redo') !== true
  // The file actions are direct page callbacks, not registry commands, so they
  // act on this page's part whatever editor the keymap resolves to. Only an
  // open edit gates them: an import is an add path and an export would read a
  // half-edited doc.
  const editingFeatureId = useEditorState(s => s.editingFeatureId)
  const editInProgress = editingFeatureId !== null
  const [undoHover, setUndoHover] = useState(false)
  const [redoHover, setRedoHover] = useState(false)

  return (
    <AppHeader hasFileActions mountBugReport={false} rightContent={rightContent} breadcrumb={<Breadcrumb docName={docName} onRename={onRename} />}>
      <div className="undo-redo-btn-group">
        <button
          className="toolbar-btn"
          aria-label="Undo"
          onClick={() => { if (ownsDocument) registry.execute('undo') }}
          disabled={undoDisabled}
          onMouseEnter={() => setUndoHover(true)}
          onMouseLeave={() => setUndoHover(false)}
          {...domHandleProps('toolbar:undo')}
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
          onClick={() => { if (ownsDocument) registry.execute('redo') }}
          disabled={redoDisabled}
          onMouseEnter={() => setRedoHover(true)}
          onMouseLeave={() => setRedoHover(false)}
          {...domHandleProps('toolbar:redo')}
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
      <button
        className="toolbar-btn"
        aria-label="Clone document"
        title="Clone document"
        onClick={handleClone}
        {...domHandleProps('toolbar:clone_document')}
      >
        <span className="material-icons-outlined">file_copy</span>
      </button>
      <div className="app-header-separator" />
      <button
        className="toolbar-btn"
        aria-label="Import STEP"
        title={editInProgress ? 'Finish the edit to import' : 'Import STEP'}
        onClick={onImport}
        disabled={editInProgress}
        {...domHandleProps('toolbar:import_step')}
      >
        <img src={featureImportIcon} alt="" />
      </button>
      <button
        className="toolbar-btn"
        aria-label="Export"
        title={editInProgress ? 'Finish the edit to export' : 'Export'}
        onClick={onExport}
        disabled={editInProgress}
        {...domHandleProps('toolbar:export')}
      >
        <img src={featureExportIcon} alt="" />
      </button>
      {/* A document property, not an export option: it decides what every
          stored number means and how the file leaves. Changing it reinterprets
          the numbers (the part resizes by the unit ratio), which the title says
          in words; undo restores it in one step. */}
      <select
        className="toolbar-unit"
        aria-label="Document length unit"
        title={editInProgress
          ? 'Finish the edit to change the unit'
          : "Document length unit. Existing numbers keep their values and are reinterpreted in the new unit, so the part's physical size changes."}
        value={lengthUnit}
        onChange={(e) => onSetLengthUnit(lengthUnitOf(e.target.value))}
        disabled={editInProgress}
      >
        <option value="mm">{LENGTH_UNIT_LABEL.mm}</option>
        <option value="inch">{LENGTH_UNIT_LABEL.inch}</option>
      </select>
    </AppHeader>
  )
}
