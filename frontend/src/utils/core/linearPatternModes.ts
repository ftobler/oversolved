// The linear pattern's direction modes: which authored fields each one reads.
// One table, read by the kernel leaf (what it obeys), the drive (what it
// refuses), and the editor (which rows it shows), so the three cannot drift the
// way a hand-kept list per surface would.
//
// The mode is optional in the document. A document written before the field
// existed has none and means `direction_distance`, which is what `modeOf`
// folds it to; nothing is rewritten.

import type { LinearDirectionMode } from '@/types/cad'

export const LINEAR_DIRECTION_MODES: readonly LinearDirectionMode[] = [
  'direction_distance', 'directive_length', 'manual',
]

/** The label the editor shows for each mode. */
export const LINEAR_DIRECTION_MODE_LABELS: Record<LinearDirectionMode, string> = {
  direction_distance: 'Direction + Distance',
  directive_length: 'Directive length',
  manual: 'Manual',
}

/** The direction fields each mode reads. A field outside its mode's list is not
 *  obeyed by the kernel, so the drive refuses setting it rather than storing a
 *  value that reads as accepted and changes nothing. `invert` and the two
 *  direction slots are shared; the spacing field is not. */
export const LINEAR_DIRECTION_MODE_FIELDS: Record<LinearDirectionMode, readonly string[]> = {
  direction_distance: ['direction_query', 'direction', 'invert', 'pitch'],
  directive_length: ['direction_query', 'invert'],
  manual: ['direction', 'invert'],
}

export function isLinearDirectionMode(value: unknown): value is LinearDirectionMode {
  return typeof value === 'string' && (LINEAR_DIRECTION_MODES as readonly string[]).includes(value)
}

/** The stored mode, or the default an old document means. An unknown spelling
 *  is not folded to the default here: the loader refuses it by name, and the
 *  kernel reads a raw value through this function only after the loader. */
export function linearDirectionModeOf(value: unknown): LinearDirectionMode {
  return isLinearDirectionMode(value) ? value : 'direction_distance'
}

/** Why a field cannot be set under the mode, or null when the mode reads it.
 *  The sentence names both, so an author who mixes the two hears which one to
 *  change instead of watching a value vanish. */
export function unreadDirectionFieldProblem(mode: LinearDirectionMode, field: string): string | null {
  return LINEAR_DIRECTION_MODE_FIELDS[mode].includes(field)
    ? null
    : `${field} is not read in ${mode} mode`
}
