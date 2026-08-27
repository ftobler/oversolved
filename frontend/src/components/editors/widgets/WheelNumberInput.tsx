import { useWheelStep } from './useWheelStep'

interface WheelNumberInputProps {
  value: string
  ariaLabel?: string
  className?: string
  placeholder?: string
  disabled?: boolean
  min?: number
  max?: number
  title?: string
  style?: React.CSSProperties
  // The field's own validation; when provided and rejecting a candidate value
  // the wheel notch is swallowed (no commit) so the wheel holds at the boundary.
  accept?: (next: number) => boolean
  onChange: (raw: string) => void
  onStep: (next: number) => void
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onPointerDown?: (e: React.PointerEvent<HTMLInputElement>) => void
}

/** A bare `type="number"` input wired to the same wheel-step behaviour as
 *  `ExpressionInput`, via the shared `useWheelStep` hook. The box reads its own
 *  text for the step, so an in-progress edit is respected and a half-typed value
 *  is left alone. Commits through the caller's normal `onStep` path. */
export function WheelNumberInput({
  value, ariaLabel, className = 'feature-field-input', placeholder, disabled, min, max, title, style, accept, onChange, onStep,
  onBlur, onKeyDown, onPointerDown,
}: WheelNumberInputProps) {
  const ref = useWheelStep({
    readText: () => ref.current?.value ?? '',
    accept,
    enabled: !disabled,
    onStep,
  })
  return (
    <input
      ref={ref}
      type="number"
      className={className}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      max={max}
      title={title}
      style={style}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    />
  )
}
