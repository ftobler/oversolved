import { useEffect, useRef } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import { acquireModalEscape } from '@/utils/core/modalEscape'

interface DialogProps {
  isOpen: boolean
  title: string
  children: ReactNode
  onClose: () => void
  onConfirm?: () => void
  confirmLabel?: ReactNode  // a node, not a string, so a busy label can carry a spinner
  cancelLabel?: string
  confirmDisabled?: boolean
  icon?: string  // material icon ligature, rendered in the title colour (see MessageDialog for the tinted variants)
  busy?: boolean
  // Extra class on the dialog box so complex dialogs (e.g. the document
  // browser) can widen the standardized shell without forking its styling.
  className?: string
  showCancel?: boolean  // confirm-only mode: keep the onConfirm semantics but drop the cancel button
  autoFocusConfirm?: boolean  // for dialogs the user only acknowledges; leave off where a field should take focus
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
  busy = false,
  className,
  showCancel = true,
  autoFocusConfirm = false,
}: DialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const pressedBackdropRef = useRef(false)
  const releasedBackdropRef = useRef(false)

  // `busy` seals every exit: an operation already handed to a worker cannot be
  // recalled, so a close would only desync the caller's state. The owner still
  // has to guard its own handlers, since a stale click can land mid-flight.
  const canClose = isOpen && !busy

  // Claiming Escape is keyed on `isOpen`, not `canClose`: a busy dialog refuses
  // to close, but it is still the thing on screen, so the global Escape command
  // must not reach past it and cancel whatever raised the dialog.
  useEffect(() => {
    if (!isOpen) return
    return acquireModalEscape()
  }, [isOpen])

  useEffect(() => {
    if (!canClose) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    // Enter deliberately stays out of the shell: dialogs that own a textarea
    // would submit on a newline. Callers that want it bind it themselves.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canClose, onClose])

  useEffect(() => {
    if (isOpen && autoFocusConfirm) confirmRef.current?.focus()
  }, [isOpen, autoFocusConfirm])

  if (!isOpen) return null

  const handleClose = () => {
    if (!busy) onClose()
  }

  // A backdrop dismiss has to be a click ON the backdrop, and `click` alone
  // does not say that: the browser fires it at the nearest common ancestor of
  // press and release, so selecting text in a field and releasing past the
  // dialog edge targets the overlay and used to throw the dialog away mid-edit.
  // Both ends of the gesture must therefore land on the backdrop itself. The
  // latches are refs, not state: they steer the event that follows them in the
  // same gesture and must never schedule a render.
  const handleOverlayPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    pressedBackdropRef.current = e.target === e.currentTarget
  }
  const handleOverlayPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    releasedBackdropRef.current = e.target === e.currentTarget
  }
  const handleOverlayClick = () => {
    const dismiss = pressedBackdropRef.current && releasedBackdropRef.current
    pressedBackdropRef.current = false
    releasedBackdropRef.current = false
    if (dismiss) handleClose()
  }

  return (
    <div
      className="dialog-component-overlay"
      onPointerDown={handleOverlayPointerDown}
      onPointerUp={handleOverlayPointerUp}
      onClick={handleOverlayClick}
    >
      <div
        className={`dialog-component${className ? ` ${className}` : ''}`}
        onClick={e => e.stopPropagation()}
        aria-busy={busy}
      >
        <div className="dialog-component-header">
          {icon && <span className="material-icons-outlined dialog-component-icon">{icon}</span>}
          <h2 className="dialog-component-title">{title}</h2>
          <button
            className="dialog-component-close-btn"
            onClick={handleClose}
            disabled={busy}
            title="Close"
            type="button"
          >
            <span className="material-icons">close</span>
          </button>
        </div>
        <div className="dialog-component-body">{children}</div>
        {onConfirm && (
          <div className="dialog-component-buttons">
            <button
              ref={confirmRef}
              className="btn btn-primary"
              onClick={onConfirm}
              disabled={confirmDisabled || busy}
            >
              {confirmLabel}
            </button>
            {showCancel && (
              <button className="btn btn-secondary" onClick={handleClose} disabled={busy}>
                {cancelLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
