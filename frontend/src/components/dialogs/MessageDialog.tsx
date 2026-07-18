import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import './MessageDialog.css'

export type MessageVariant = 'info' | 'success' | 'error'

interface MessageDialogProps {
  isOpen: boolean
  title: string
  message: ReactNode  // plain strings render with pre-wrap; JSX for rich content
  variant?: MessageVariant
  onClose: () => void
  onConfirm?: () => void
  confirmLabel?: string
  cancelLabel?: string
  showCancel?: boolean  // confirm-only mode: keep onConfirm semantics but drop the cancel button
  className?: string  // extra class on the content box so callers can restyle
}

const ICON: Record<MessageVariant, string> = {
  info: 'info',
  success: 'check_circle',
  error: 'error',
}

export default function MessageDialog({ isOpen, title, message, variant = 'info', onClose, onConfirm, confirmLabel = 'Confirm', cancelLabel = 'Cancel', showCancel = true, className }: MessageDialogProps) {
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return

    okRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (onConfirm) {
          onConfirm()
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose, onConfirm])

  if (!isOpen) return null

  return (
    <div className="message-dialog-overlay" onClick={onClose}>
      <div className={`message-dialog-content message-dialog-${variant}${className ? ` ${className}` : ''}`} onClick={e => e.stopPropagation()}>
        <div className="message-dialog-header">
          <span className={`material-icons message-dialog-icon message-dialog-icon-${variant}`}>
            {ICON[variant]}
          </span>
          <h2 className="message-dialog-title">{title}</h2>
          <button
            className="message-dialog-close-btn"
            onClick={onClose}
            title="Close"
          >
            <span className="material-icons">close</span>
          </button>
        </div>

        <div className="message-dialog-body">
          {/* div, not p: rich messages may contain their own paragraphs */}
          <div className="message-dialog-message">{message}</div>
        </div>

        <div className="message-dialog-footer">
          {onConfirm ? (
            <>
              <button ref={okRef} className="btn btn-primary message-dialog-confirm-btn" onClick={onConfirm}>
                {confirmLabel}
              </button>
              {showCancel && (
                <button className="btn btn-secondary message-dialog-cancel-btn" onClick={onClose}>
                  {cancelLabel}
                </button>
              )}
            </>
          ) : (
            <button ref={okRef} className="btn btn-primary message-dialog-ok-btn" onClick={onClose}>
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
