import { useEffect } from 'react'
import type { ReactNode } from 'react'
import Dialog from '@/components/dialogs/Dialog'
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

// A message box built on the shared dialog shell. What it adds over the shell is
// the variant tint, Enter-to-acknowledge, and an OK-only mode for dialogs that
// carry no decision. The tint rides in on the shell's className passthrough: the
// shell's own icon is deliberately untinted, since a topic icon is not a signal.
export default function MessageDialog({ isOpen, title, message, variant = 'info', onClose, onConfirm, confirmLabel = 'Confirm', cancelLabel = 'Cancel', showCancel = true, className }: MessageDialogProps) {
  // Escape comes from the shell. Enter stays here: it is only safe because a
  // message box holds no field a newline could belong to.
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (onConfirm) {
        onConfirm()
      } else {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose, onConfirm])

  // Without a confirm handler the dialog is an acknowledgement: a lone OK that
  // closes, and no cancel to sit beside it.
  const isAcknowledgement = !onConfirm

  return (
    <Dialog
      isOpen={isOpen}
      title={title}
      icon={ICON[variant]}
      className={`message-dialog message-dialog-${variant}${className ? ` ${className}` : ''}`}
      onClose={onClose}
      onConfirm={isAcknowledgement ? onClose : onConfirm}
      confirmLabel={isAcknowledgement ? 'OK' : confirmLabel}
      cancelLabel={cancelLabel}
      showCancel={!isAcknowledgement && showCancel}
      autoFocusConfirm
    >
      {/* div, not p: rich messages may contain their own paragraphs */}
      <div className="message-dialog-message">{message}</div>
    </Dialog>
  )
}
