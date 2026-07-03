import { useEffect, useRef } from 'react'
import './MessageDialog.css'

export type MessageVariant = 'info' | 'success' | 'error'

interface MessageDialogProps {
  isOpen: boolean
  title: string
  message: string
  variant?: MessageVariant
  onClose: () => void
}

const ICON: Record<MessageVariant, string> = {
  info: 'info',
  success: 'check_circle',
  error: 'error',
}

export default function MessageDialog({ isOpen, title, message, variant = 'info', onClose }: MessageDialogProps) {
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return

    okRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="message-dialog-overlay" onClick={onClose}>
      <div className={`message-dialog-content message-dialog-${variant}`} onClick={e => e.stopPropagation()}>
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
          <p className="message-dialog-message">{message}</p>
        </div>

        <div className="message-dialog-footer">
          <button ref={okRef} className="btn btn-primary message-dialog-ok-btn" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
