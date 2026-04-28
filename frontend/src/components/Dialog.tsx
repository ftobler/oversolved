import type { ReactNode } from 'react'

interface DialogProps {
  isOpen: boolean
  title: string
  children: ReactNode
  onClose: () => void
  onConfirm?: () => void
  confirmLabel?: string
  cancelLabel?: string
  confirmDisabled?: boolean
}

export default function Dialog({
  isOpen,
  title,
  children,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmDisabled = false,
}: DialogProps) {
  if (!isOpen) return null

  return (
    <div className="add-dialog-overlay" onClick={onClose}>
      <div className="add-dialog" onClick={e => e.stopPropagation()}>
        <div className="add-dialog-title">{title}</div>
        {children}
        {onConfirm && (
          <div className="add-form-row">
            <button className="btn btn-primary" onClick={onConfirm} disabled={confirmDisabled}>
              {confirmLabel}
            </button>
            <button className="btn btn-secondary" onClick={onClose}>
              {cancelLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
