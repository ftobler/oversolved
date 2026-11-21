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
  // Returns the reason the typed name would be refused, or null. Shown under the
  // field while typing, and OK stays disabled while it is non-null.
  validate?: (name: string) => string | null
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
  validate,
  onRename,
  onCancel,
}: RenameDialogProps) {
  const [name, setName] = useState(currentName)
  const inputRef = useRef<HTMLInputElement>(null)
  const [wasOpen, setWasOpen] = useState(isOpen)
  // The prefilled current name is never judged: a legacy document can carry one
  // the rule would refuse, and an error before the user types reads as their
  // mistake. Validation starts with the first edit.
  const [edited, setEdited] = useState(false)

  // The dialog stays mounted between renames, so re-seed the field on every open
  // but never while it is open: that would wipe whatever the user typed. This is
  // a render-phase adjustment on prop change (per the React docs), not an effect,
  // which would cost a second render pass.
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) {
      setName(currentName)
      setEdited(false)
    }
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
  const problem = edited && validate ? validate(trimmed) : null

  const handleConfirm = () => {
    if (!trimmed) return
    // A legacy-prefilled label is not judged until the first edit. If it is
    // invalid, reveal the hint instead of dispatching a confirm the applier
    // would refuse behind the modal overlay.
    if (!edited && validate && validate(trimmed) !== null) {
      setEdited(true)
      return
    }
    if (problem !== null) return
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
      confirmDisabled={!trimmed || problem !== null}
    >
      <div className="rename-dialog-field">
        <label className="rename-dialog-label" htmlFor="rename-dialog-input">{label}</label>
        <input
          id="rename-dialog-input"
          ref={inputRef}
          type="text"
          value={name}
          onChange={e => {
            setEdited(true)
            setName(e.target.value)
          }}
          onKeyDown={handleKeyDown}
          aria-invalid={problem !== null}
          aria-describedby={problem !== null ? 'rename-dialog-hint' : undefined}
        />
        {problem !== null && (
          <div className="rename-dialog-hint" id="rename-dialog-hint" aria-live="polite">{problem}</div>
        )}
      </div>
    </Dialog>
  )
}
