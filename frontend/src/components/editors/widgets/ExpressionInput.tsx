import { useState } from 'react'
import { evalExpr } from '@/kernel/evalExpr'
import { PLAIN_NUMBER } from './wheelStep'
import { useWheelStep } from './useWheelStep'

interface ExpressionInputProps {
  value: string | number  // raw stored value (number or expression string)
  onChange: (val: string | number) => void
  context?: Record<string, number>  // variable scope (named dimensions, params)
  validate?: (v: number) => boolean  // range check on the evaluated result
  unit?: string
  disabled?: boolean
  ariaLabel?: string
}

/** A numeric field that accepts math expressions (`50+25`, `width*2`). The raw
 *  text is shown while editing; on commit it evaluates and stores either a plain
 *  number (when the input is purely numeric, for backward compatibility) or the
 *  raw expression string. Invalid input reverts to the last committed value.
 *
 *  While idle the field mirrors the external `value` directly (no local copy to
 *  drift); local edit state exists only between focus and blur. */
export function ExpressionInput({
  value, onChange, context = {}, validate, unit, disabled, ariaLabel,
}: ExpressionInputProps) {
  // null = idle (mirror external value); string = actively editing.
  const [draft, setDraft] = useState<string | null>(null)
  const raw = draft ?? String(value)

  // Hover-only wheel stepping: a notch over the box (focused or not) commits
  // value +/- 1 through the field's normal path. The editing branch keeps the
  // open draft in sync so the 3D preview follows the wheel.
  const wheelRef = useWheelStep({
    readText: () => raw,
    accept: validate,
    enabled: !disabled,
    onStep: (next) => {
      onChange(next)
      if (draft !== null) setDraft(String(next))
    },
  })

  const trimmed = raw.trim()
  const result = evalExpr(trimmed, context)
  const valid = !isNaN(result) && (!validate || validate(result))
  const isExpression = trimmed !== '' && !PLAIN_NUMBER.test(trimmed)

  const commit = () => {
    if (valid && draft !== null) {
      onChange(PLAIN_NUMBER.test(trimmed) ? parseFloat(trimmed) : trimmed)
    }
    setDraft(null)  // back to idle: mirror the (possibly updated) external value
  }

  return (
    <>
      <input
        ref={wheelRef}
        type="text"
        aria-label={ariaLabel}
        className={`feature-field-input${!valid && trimmed !== '' ? ' feature-field-input--error' : ''}`}
        value={raw}
        disabled={disabled}
        title={!valid && trimmed !== '' ? `Cannot evaluate "${trimmed}"` : undefined}
        onClick={(e) => e.stopPropagation()}
        onFocus={() => setDraft(String(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
          e.stopPropagation()
        }}
      />
      {isExpression && valid && (
        <span className="feature-field-eval">= {Number(result.toFixed(4))}</span>
      )}
      {unit && <span className="feature-field-unit">{unit}</span>}
    </>
  )
}
