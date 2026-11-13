import { useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import type { DxfLayerOption } from '@/utils/dxfImport'
import '@/components/dialogs/DxfLayerDialog.css'

export interface DxfLayerDialogProps {
  isOpen: boolean
  // The file the layers come from, named in the title so a second import is
  // not mistaken for the first.
  fileName: string
  // Only the layers whose entities import on their own (utils/dxfImport.ts).
  layers: readonly DxfLayerOption[]
  onImport: (checked: string[]) => void
  onCancel: () => void
}

export default function DxfLayerDialog({
  isOpen,
  fileName,
  layers,
  onImport,
  onCancel,
}: DxfLayerDialogProps) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(layers.map(layer => layer.layer)))
  const [wasOpen, setWasOpen] = useState(isOpen)

  // The dialog stays mounted between imports, so re-seed the checkboxes on
  // every open (all checked, the whole-file import) but never while it is open:
  // that would wipe the user's choice. A render-phase adjustment on prop change,
  // the same shape RenameDialog uses.
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) setChecked(new Set(layers.map(layer => layer.layer)))
  }

  const toggle = (layer: string) => {
    setChecked(previous => {
      const next = new Set(previous)
      if (next.has(layer)) next.delete(layer)
      else next.add(layer)
      return next
    })
  }

  const handleImport = () => {
    if (checked.size === 0) return
    onImport(layers.map(layer => layer.layer).filter(layer => checked.has(layer)))
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={`Import DXF layers from ${fileName}`}
      icon="layers"
      onClose={onCancel}
      onConfirm={handleImport}
      confirmLabel="Import"
      confirmDisabled={checked.size === 0}
    >
      <div className="dxf-layer-dialog-list">
        {layers.map(option => (
          <label className="dxf-layer-dialog-row" key={option.layer}>
            <input
              type="checkbox"
              aria-label={option.layer}
              checked={checked.has(option.layer)}
              onChange={() => toggle(option.layer)}
            />
            <span className="dxf-layer-dialog-name">{option.layer}</span>
            <span className="dxf-layer-dialog-count">
              {option.count} {option.count === 1 ? 'entity' : 'entities'}
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}
