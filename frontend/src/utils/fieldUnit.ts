// What a number field measures, in one vocabulary. The field schema names a
// quantity; this module is the only place that turns it into the words the UI
// shows. Display only: a quantity never reaches the document.
//
// `turns` is its own kind, not a count: a helix's turns is a number of
// revolutions, so the box says `rev` and a screen reader says "revolutions".
// `pcs` there would state a different thing. `none` is for a true ratio (a
// scale factor), which has no unit to show.

import type { LengthUnit } from '@/types/cad'
import { LENGTH_UNIT_LABEL, LENGTH_UNIT_NAME } from '@/utils/lengthUnit'

export type Quantity = 'length' | 'angle' | 'count' | 'turns' | 'none'

/** The muted suffix beside a number: the document's own unit for a length, a
 *  fixed word for the others, null when the number has no unit. */
export function unitLabel(quantity: Quantity, lengthUnit: LengthUnit = 'mm'): string | null {
  switch (quantity) {
    case 'length': return LENGTH_UNIT_LABEL[lengthUnit]
    case 'angle': return 'deg'
    case 'count': return 'pcs'
    case 'turns': return 'rev'
    case 'none': return null
  }
}

/** The spelled-out unit, for an accessible name: "Angle, degrees". A screen
 *  reader says "deg" as a word otherwise, which is not the unit. */
export function unitName(quantity: Quantity, lengthUnit: LengthUnit = 'mm'): string | null {
  switch (quantity) {
    case 'length': return LENGTH_UNIT_NAME[lengthUnit]
    case 'angle': return 'degrees'
    case 'count': return 'pieces'
    case 'turns': return 'revolutions'
    case 'none': return null
  }
}

/** The accessible name of a number field: its label, then the said-out-loud
 *  unit. `unitName` returns null for a bare number, so the label stands alone. */
export function fieldAccessibleName(label: string, quantity: Quantity, lengthUnit: LengthUnit = 'mm'): string {
  const name = unitName(quantity, lengthUnit)
  return name === null ? label : `${label}, ${name}`
}
