import { useRef, useEffect } from 'react'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import okIcon from '../assets/icons/dialog-ok.svg'
import cancelIcon from '../assets/icons/dialog-cancel.svg'
import './ContextMenuDialog.css'

export default function ContextMenuDialog() {
  const dialog = useSketchEditorStore(s => s.pendingDialog)
  const closeDialog = useSketchEditorStore(s => s.closeDialog)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialog) {
      // Defer focus so the input is mounted and visible first
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [dialog])

  if (!dialog) return null

  const [x, y] = dialog.position

  const handleConfirm = () => {
    dialog.onConfirm(inputRef.current?.value ?? '')
    closeDialog()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleConfirm()
    } else if (e.key === 'Escape') {
      dialog.onCancel?.()
      closeDialog()
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
        ref={inputRef}
        type="number"
        defaultValue={dialog.defaultValue ?? ''}
        onKeyDown={handleKeyDown}
        className="context-menu-input"
      />
      <button className="context-menu-btn context-menu-btn-ok" onClick={handleConfirm}><img src={okIcon} alt="OK" /></button>
      <button className="context-menu-btn context-menu-btn-cancel" onClick={() => { dialog.onCancel?.(); closeDialog() }}><img src={cancelIcon} alt="Cancel" /></button>
    </div>
  )
}
