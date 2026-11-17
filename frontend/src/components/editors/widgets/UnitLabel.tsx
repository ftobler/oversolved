import type { ReactNode } from 'react'
import type { LengthUnit } from '@/types/cad'
import { unitLabel, type Quantity } from '@/utils/fieldUnit'

/**
 * The muted unit word beside a number. On its own it is inline text (the
 * feature tree's variable hint); inside a `UnitBox` the box scopes it to the
 * input's right padding, so the word never takes row width from the value.
 *
 * `hidden` is for the adornment: the input's accessible name already says the
 * unit out loud, so a screen reader must not read "mm" as well.
 */
export function UnitText({ label, hidden = false }: { label: string; hidden?: boolean }) {
  return <span className="field-unit" aria-hidden={hidden ? true : undefined}>{label}</span>
}

/** The unit of a quantity, as the schema declares it. Null (a ratio) renders
 *  nothing, which is why the schema marks a ratio `none` rather than omitting. */
export function UnitLabel({ quantity, lengthUnit = 'mm' }: { quantity: Quantity; lengthUnit?: LengthUnit }) {
  const label = unitLabel(quantity, lengthUnit)
  return label === null ? null : <UnitText label={label} hidden />
}

/**
 * One number box, input and unit together: `[ 12.5 mm ]`. The unit sits in the
 * input's own right padding, so a row with a unit and a row without keep the
 * same box width. `grow` lets the box take a row's spare width; a control sized
 * by its own input (the n-gon side count) leaves it off.
 */
export function UnitBox({ quantity, lengthUnit = 'mm', grow = true, children }: {
  quantity: Quantity
  lengthUnit?: LengthUnit
  grow?: boolean
  children: ReactNode
}) {
  const label = unitLabel(quantity, lengthUnit)
  const classes = ['field-unit-box']
  if (grow) classes.push('field-unit-box--grow')
  if (label !== null) classes.push('field-unit-box--with-unit')
  return (
    <span className={classes.join(' ')}>
      {children}
      {label !== null && <UnitText label={label} hidden />}
    </span>
  )
}
