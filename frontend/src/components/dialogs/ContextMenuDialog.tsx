import { useRef, useEffect, useState } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useWheelStep } from '@/components/editors/widgets/useWheelStep'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'
import '@/components/dialogs/ContextMenuDialog.css'

export default function ContextMenuDialog() {
  const dialog = useSketchEditorStore(s => s.pendingDialog)
  const closeDialog = useSketchEditorStore(s => s.closeDialog)
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [seenDialog, setSeenDialog] = useState(dialog)

  // Hover wheel stepping on the dimension entry. The box is uncontrolled, so the
  // wheel writes straight to the DOM value and leaves the confirm/Enter commit
  // to own the mutation; no per-notch validation, matching the dialog's own
  // confirm-time gate. The hook attaches to the existing `inputRef`.
  const wheelRef = useWheelStep({
    readText: () => inputRef.current?.value ?? '',
    inputRef,
    onStep: (next) => {
      if (inputRef.current) inputRef.current.value = String(next)
      if (error) setError(null)
    },
  })

  // Reset the validation error when a different dialog opens (render-phase
  // adjustment on prop change, per the React docs).
  if (dialog !== seenDialog) {
    setSeenDialog(dialog)
    setError(null)
  }

  useEffect(() => {
    if (dialog) {
      // Defer focus so the input is mounted and visible first
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [dialog])

  // Escape lives on the window rather than on the input: cancel_draw stands down
  // while this dialog is up (see commandEntries), so an input-only handler would
  // leave Escape completely inert once focus moved to one of the buttons.
  useEffect(() => {
    if (!dialog) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      dialog.onCancel?.()
      closeDialog()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialog, closeDialog])

  if (!dialog) return null

  const [x, y] = dialog.position

  const handleConfirm = () => {
    const value = inputRef.current?.value ?? ''
    // Reject invalid input in place: keep the dialog open and show why, rather
    // than silently dropping the gesture.
    const err = dialog.validate?.(value) ?? null
    if (err) {
      setError(err)
      return
    }
    dialog.onConfirm(value)
    closeDialog()
  }

  // Enter only: Escape is handled on the window above so it works from any focus.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleConfirm()
    }
  }

  return (
    <div
      className="context-menu-dialog"
      style={{ left: x + 12, top: y + 8 }}
      // Prevent clicks from propagating to canvas
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <span className="context-menu-label">{dialog.label}</span>
      <input
        key={dialog.defaultValue}
        ref={wheelRef}
        type="number"
        defaultValue={dialog.defaultValue ?? ''}
        onKeyDown={handleKeyDown}
        onChange={() => { if (error) setError(null) }}
        className={error ? 'context-menu-input invalid' : 'context-menu-input'}
      />
      <button className="context-menu-btn context-menu-btn-ok" onClick={handleConfirm}><img src={okIcon} alt="OK" /></button>
      <button className="context-menu-btn context-menu-btn-cancel" onClick={() => { dialog.onCancel?.(); closeDialog() }}><img src={cancelIcon} alt="Cancel" /></button>
      {dialog.extraAction && (
        <button
          type="button"
          className="context-menu-btn context-menu-btn-extra"
          onClick={() => { dialog.extraAction!.onClick(); closeDialog() }}
        >
          {dialog.extraAction.label}
        </button>
      )}
      {error && <span className="context-menu-error" role="alert">{error}</span>}
    </div>
  )
}
