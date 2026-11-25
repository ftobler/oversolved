import { useRef, useEffect, useLayoutEffect, useState } from 'react'
import { useSketchUiStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useWheelStep } from '@/components/editors/widgets/useWheelStep'
import { UnitBox } from '@/components/editors/widgets/UnitLabel'
import { fieldAccessibleName } from '@/utils/fieldUnit'
import { lengthUnitOf } from '@/utils/lengthUnit'
import { acquireModalEscape } from '@/utils/core/modalEscape'
import { clampMenuPosition } from '@/components/dialogs/menuPosition'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'
import '@/components/layout/Glass.css'
import '@/components/dialogs/ContextMenuDialog.css'

export default function ContextMenuDialog() {
  const dialog = useSketchUiStore(s => s.pendingDialog)
  const closeDialog = useSketchUiStore(s => s.closeDialog)
  // A sketch dimension and a feature handle are lengths in the part's own unit,
  // so the box follows the document without the callers having to thread it.
  const lengthUnit = lengthUnitOf(usePartEditorStore(s => s.doc)?.length_unit)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [seenDialog, setSeenDialog] = useState(dialog)
  const [toggleValue, setToggleValue] = useState(dialog?.toggle?.value ?? false)
  // The dialog hangs from the label's point while it fits, and flips or pins to
  // the window margin when the wider glass row would push OK/Cancel off screen.
  const [pos, setPos] = useState<[number, number]>([0, 0])

  // Hover wheel stepping on the dimension entry. The box is uncontrolled, so the
  // wheel writes straight to the DOM value and leaves the confirm/Enter commit
  // to own the mutation; no per-notch validation, matching the dialog's own
  // confirm-time gate. The hook attaches to the existing `inputRef`.
  const readOnly = dialog?.readOnly === true || (dialog?.toggle !== undefined && toggleValue)
  const wheelRef = useWheelStep({
    readText: () => inputRef.current?.value ?? '',
    inputRef,
    // A driven dimension measures: its box is read-only and a wheel notch must
    // not step a value the user cannot author anyway.
    enabled: !readOnly,
    onStep: (next) => {
      if (inputRef.current) inputRef.current.value = String(next)
      if (error) setError(null)
    },
  })

  // Reset the validation error when a different dialog opens (render-phase
  // adjustment on prop change, per the React docs), and hang the new one off
  // its own anchor before the layout pass measures it.
  if (dialog !== seenDialog) {
    setSeenDialog(dialog)
    setError(null)
    setToggleValue(dialog?.toggle?.value ?? false)
    if (dialog) setPos([dialog.position[0] + 12, dialog.position[1] + 8])
  }

  // Measure the rendered row and clamp it before paint. jsdom reports a zero
  // rect, where the anchors already fit, so the raw anchor stands there.
  // `error` is a dependency because a refusal line can widen the row.
  useLayoutEffect(() => {
    if (!dialog) return
    const element = rootRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const next = clampMenuPosition(
      [dialog.position[0] + 12, dialog.position[1] + 8],
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    )
    setPos(previous => (previous[0] === next[0] && previous[1] === next[1] ? previous : next))
  }, [dialog, error])

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

  // The claim is what stands the document-level commands down, not just Escape.
  // Focus rests on the number input, which dispatchKey already ignores, so the
  // hole only showed once Tab or a click moved it to a button: Ctrl+Z then ran
  // the document undo, which committed the pending work, tore the editor state
  // down and nulled this dialog, discarding the typed value with no message.
  useEffect(() => {
    if (!dialog) return
    return acquireModalEscape()
  }, [dialog])

  if (!dialog) return null

  const handleConfirm = () => {
    const value = inputRef.current?.value ?? ''
    // A read-only box shows a measurement, not an authored value: there is
    // nothing to validate, and a measured zero (an angle) is legal.
    if (readOnly) {
      // The box shows a measurement, never what the user typed before the switch
      // flipped. Confirmed against the exact default, an unchanged accept cannot
      // write a stale value onto the driven row.
      dialog.onConfirm(dialog.defaultValue ?? value)
      closeDialog()
      return
    }
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
      ref={rootRef}
      className="context-menu-dialog glass-panel"
      style={{ left: pos[0], top: pos[1] }}
      // Prevent clicks from propagating to canvas
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {dialog.icon && <img className="feature-icon" src={dialog.icon} alt="" />}
      <span className="feature-field-label context-menu-label">{dialog.label}</span>
      <UnitBox quantity={dialog.quantity ?? 'none'} lengthUnit={lengthUnit} grow={false}>
        <input
          key={dialog.defaultValue}
          ref={wheelRef}
          type="text"
          inputMode="decimal"
          defaultValue={dialog.defaultValue ?? ''}
          onKeyDown={handleKeyDown}
          onChange={() => { if (error) setError(null) }}
          className={error
            ? 'feature-field-input context-menu-input feature-field-input--error'
            : 'feature-field-input context-menu-input'}
          aria-label={fieldAccessibleName(dialog.label, dialog.quantity ?? 'none', lengthUnit)}
          readOnly={readOnly}
        />
      </UnitBox>
      {dialog.toggle && (
        <label
          className="context-menu-toggle"
          title={dialog.toggle.hint}
          style={{ opacity: dialog.toggle.locked ? 0.75 : 1, cursor: dialog.toggle.locked ? 'default' : 'pointer' }}
        >
          <input
            type="checkbox"
            checked={toggleValue}
            disabled={dialog.toggle.locked}
            onChange={(e) => {
              if (dialog.toggle!.locked) return
              const next = e.target.checked
              // A refused un-drive leaves the switch where it was: the value
              // box stays read-only and the user sees why through the message.
              if (dialog.toggle!.onChange?.(next) === false) return
              if (next && inputRef.current && dialog.defaultValue !== undefined) {
                // Turning on a reference discards a typed value: the box now
                // shows the measurement again.
                inputRef.current.value = dialog.defaultValue
                if (error) setError(null)
              }
              setToggleValue(next)
            }}
          />
          <span>{dialog.toggle.label}</span>
        </label>
      )}
      <button className="feature-ok-btn" onClick={handleConfirm} title="OK"><img src={okIcon} alt="OK" /></button>
      <button className="feature-cancel-btn" onClick={() => { dialog.onCancel?.(); closeDialog() }} title="Cancel"><img src={cancelIcon} alt="Cancel" /></button>
      {dialog.extraAction && (
        <button
          type="button"
          className="feature-neutral-btn feature-neutral-btn--text context-menu-btn-extra"
          onClick={() => { dialog.extraAction!.onClick(); closeDialog() }}
        >
          {dialog.extraAction.label}
        </button>
      )}
      {error && <span className="context-menu-error" role="alert">{error}</span>}
      {dialog.toggle?.hint && <span className="context-menu-toggle-hint">{dialog.toggle.hint}</span>}
    </div>
  )
}
