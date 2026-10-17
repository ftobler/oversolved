import { useState } from 'react'
import { evalExpr } from '@/kernel/evalExpr'
import { PLAIN_NUMBER } from './wheelStep'
import { useWheelStep } from './useWheelStep'
import { StatusMessage } from '@/components/shared/StatusMessage'
import { fieldRefusal } from '@/utils/core/statusMark'
import { cannotEvaluate } from '@/utils/core/valueRules'

interface ExpressionInputProps {
  value: string | number  // raw stored value (number or expression string)
  onChange: (val: string | number) => void
  context?: Record<string, number>  // variable scope (named dimensions, params)
  // Rule on the evaluated result: null accepts, a string is the refusal reason.
  validate?: (v: number) => string | null
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
 *  drift); local edit state exists only between focus and blur.
 *
 *  A refused value is a field refusal like a refused pick: while the user
 *  edits, the reason shows as a line in the row, so "cannot evaluate" and
 *  "must be greater than 0" are told apart instead of both reading as one red
 *  border. */
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
    accept: validate ? (next) => validate(next) === null : undefined,
    enabled: !disabled,
    onStep: (next) => {
      onChange(next)
      if (draft !== null) setDraft(String(next))
    },
  })

  const trimmed = raw.trim()
  const result = evalExpr(trimmed, context)
  // An empty box is unfinished input, not a refusal: it simply does not commit.
  const reason = trimmed === '' ? null
    : isNaN(result) ? cannotEvaluate(trimmed)
    : validate ? validate(result) : null
  const valid = !isNaN(result) && reason === null
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
        className={`feature-field-input${reason !== null ? ' feature-field-input--error' : ''}`}
        value={raw}
        disabled={disabled}
        // A stored value that no longer passes (a deleted variable, an imported
        // doc) was never refused by the user: border plus hover, no field line.
        title={draft === null && reason !== null ? reason : undefined}
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
      <StatusMessage mark={fieldRefusal('Value', draft !== null ? reason : null)} />
    </>
  )
}
