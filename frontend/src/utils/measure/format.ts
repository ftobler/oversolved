// The one measurement formatter: the part HUD and the assembly HUD both render
// through it, so the precision and the unit suffix cannot drift apart again.
//
// The number is already in the document's unit, so nothing is converted here;
// only the suffix follows the unit. Angles are degrees and keep one decimal.
import type { LengthUnit } from '@/types/cad'
import { LENGTH_UNIT_LABEL } from '@/utils/lengthUnit'
import type { Readout } from './rules'

export const LENGTH_DECIMALS = 3
export const ANGLE_DECIMALS = 1

export function formatReadout(readout: Readout, unit: LengthUnit = 'mm'): string {
  if (readout.kind === 'angle') {
    return `${readout.label} ${readout.value.toFixed(ANGLE_DECIMALS)}°`
  }
  return `${readout.label} ${readout.value.toFixed(LENGTH_DECIMALS)} ${LENGTH_UNIT_LABEL[unit]}`
}

/** A readout plus its extras, one HUD line each. */
export function formatReadouts(readout: Readout, unit: LengthUnit = 'mm'): string[] {
  return [formatReadout(readout, unit), ...(readout.extra ?? []).map((extra) => formatReadout(extra, unit))]
}
