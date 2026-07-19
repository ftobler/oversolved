import { useEffect, useRef, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import '@/components/dialogs/RenameDialog.css'

export interface RenameDialogProps {
  isOpen: boolean
  title?: string
  label?: string
  currentName: string
  // The gesture is not always a rename: cloning prompts for the new name with
  // the same one-field shape, so the verb and icon are the caller's to set.
  confirmLabel?: string
  icon?: string
  onRename: (name: string) => void
  onCancel: () => void
}

export default function RenameDialog({
  isOpen,
  title = 'Rename',
  label = 'Name',
  currentName,
  confirmLabel = 'Rename',
  icon = 'edit',
  onRename,
  onCancel,
}: RenameDialogProps) {
  const [name, setName] = useState(currentName)
  const inputRef = useRef<HTMLInputElement>(null)
  const [wasOpen, setWasOpen] = useState(isOpen)

  // The dialog stays mounted between renames, so re-seed the field on every open
  // but never while it is open: that would wipe whatever the user typed. This is
  // a render-phase adjustment on prop change (per the React docs), not an effect,
  // which would cost a second render pass.
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) setName(currentName)
  }

  // Select the existing name so typing replaces it, which is what the old
  // window.prompt did and what every rename gesture elsewhere expects.
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isOpen])

  const trimmed = name.trim()

  const handleConfirm = () => {
    if (!trimmed) return
    onRename(trimmed)
  }

  // The shell leaves Enter to the callers; a single-field dialog wants it.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm()
    }
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={title}
      icon={icon}
      onClose={onCancel}
      onConfirm={handleConfirm}
      confirmLabel={confirmLabel}
      confirmDisabled={!trimmed}
    >
      <div className="rename-dialog-field">
        <label className="rename-dialog-label" htmlFor="rename-dialog-input">{label}</label>
        <input
          id="rename-dialog-input"
          ref={inputRef}
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    </Dialog>
  )
}
