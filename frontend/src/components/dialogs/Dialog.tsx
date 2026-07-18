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
  icon?: string  // material icon ligature, rendered in the title colour (see MessageDialog for the tinted variants)
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
  icon,
}: DialogProps) {
  if (!isOpen) return null

  return (
    <div className="dialog-component-overlay" onClick={onClose}>
      <div className="dialog-component" onClick={e => e.stopPropagation()}>
        <div className="dialog-component-header">
          {icon && <span className="material-icons-outlined dialog-component-icon">{icon}</span>}
          <h2 className="dialog-component-title">{title}</h2>
          <button
            className="dialog-component-close-btn"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <span className="material-icons">close</span>
          </button>
        </div>
        <div className="dialog-component-body">{children}</div>
        {onConfirm && (
          <div className="dialog-component-buttons">
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
