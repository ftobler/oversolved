import { useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import type { StepImportMode } from '@/workspace/stepImportMode'
import '@/components/dialogs/StepImportDialog.css'

// Which STEP import the user asked for. Presentational only: the chosen mode is
// a pure value the workspace writer consumes, so every rule about what an
// import creates is testable without a DOM.
export type StepImportDialogVariant = 'workspace' | 'assembly'

export interface StepImportDialogProps {
  isOpen: boolean
  // The picked file, named in the title so a second import is not mistaken for
  // the first.
  fileName: string
  // 'assembly' is the assembly editor's gesture: the assembly already exists,
  // so B1 would be the same as A and is not offered; the wording names the add.
  variant?: StepImportDialogVariant
  onImport: (mode: StepImportMode) => void
  onCancel: () => void
}

interface ModeRow {
  mode: StepImportMode
  label: string
  hint: string
}

// The solid count is only known after the parse, so all rows show for a STEP
// that holds one solid; B2 on such a file produces the B1 result and says
// nothing extra.
function modeRows(variant: StepImportDialogVariant): ModeRow[] {
  if (variant === 'assembly') {
    return [
      {
        mode: 'part',
        label: 'Add as one part',
        hint: 'One part document holding one body per solid in the file.',
      },
      {
        mode: 'assembly_split',
        label: 'Add a part per solid',
        hint: 'A separate part document per solid, all added to this assembly.',
      },
    ]
  }
  return [
    {
      mode: 'part',
      label: 'One part',
      hint: 'One part document holding one body per solid in the file.',
    },
    {
      mode: 'assembly_one_part',
      label: 'Assembly with one part',
      hint: 'A new assembly holding one part document for the whole file.',
    },
    {
      mode: 'assembly_split',
      label: 'Assembly, a part per solid',
      hint: 'A new assembly with a separate part document per solid in the file.',
    },
  ]
}

export default function StepImportDialog({
  isOpen,
  fileName,
  variant = 'workspace',
  onImport,
  onCancel,
}: StepImportDialogProps) {
  const [mode, setMode] = useState<StepImportMode>('part')
  const [wasOpen, setWasOpen] = useState(isOpen)

  // The dialog stays mounted between imports, so the default returns on every
  // open (a mode picked for one file must not silently apply to the next) but
  // never while it is open. The same render-phase adjustment DxfLayerDialog uses.
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) setMode('part')
  }

  const rows = modeRows(variant)

  return (
    <Dialog
      isOpen={isOpen}
      title={`Import ${fileName}`}
      icon="view_in_ar"
      onClose={onCancel}
      onConfirm={() => onImport(mode)}
      confirmLabel="Import"
    >
      <div className="step-import-dialog-modes" role="radiogroup" aria-label="STEP import mode">
        {rows.map(row => (
          <label className="step-import-dialog-row" key={row.mode}>
            <input
              type="radio"
              name="step-import-mode"
              aria-label={row.label}
              checked={mode === row.mode}
              onChange={() => setMode(row.mode)}
            />
            <span className="step-import-dialog-text">
              <span className="step-import-dialog-label">{row.label}</span>
              <span className="step-import-dialog-hint">{row.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}
