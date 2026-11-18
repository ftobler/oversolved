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
  const suffix = readout.note === undefined ? '' : ` (${readout.note})`
  if (readout.kind === 'angle') {
    return `${readout.label} ${readout.value.toFixed(ANGLE_DECIMALS)}°${suffix}`
  }
  if (readout.kind === 'area' || readout.kind === 'volume') {
    const power = readout.kind === 'area' ? '²' : '³'
    return `${readout.label} ${readout.value.toFixed(LENGTH_DECIMALS)} ${LENGTH_UNIT_LABEL[unit]}${power}${suffix}`
  }
  return `${readout.label} ${readout.value.toFixed(LENGTH_DECIMALS)} ${LENGTH_UNIT_LABEL[unit]}${suffix}`
}

/** A readout plus its extras, one HUD line each. */
export function formatReadouts(readout: Readout, unit: LengthUnit = 'mm'): string[] {
  return [formatReadout(readout, unit), ...(readout.extra ?? []).map((extra) => formatReadout(extra, unit))]
}

/** How many extras the HUD shows beside the primary before folding the rest
 *  behind its disclosure. */
export const HUD_INLINE_EXTRAS = 2

/** The HUD's split of a readout: the primary plus a short inline tail, and the
 *  remaining extras behind a disclosure, both in the order the cell emitted. */
export function formatReadoutHud(
  readout: Readout,
  unit: LengthUnit = 'mm',
): { lines: string[]; more: string[] } {
  const extras = (readout.extra ?? []).map((extra) => formatReadout(extra, unit))
  return {
    lines: [formatReadout(readout, unit), ...extras.slice(0, HUD_INLINE_EXTRAS)],
    more: extras.slice(HUD_INLINE_EXTRAS),
  }
}
