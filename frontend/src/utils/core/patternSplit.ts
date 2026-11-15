// The one translation from the retired single `pattern` kind to the two kinds
// that replaced it. The loader's version-9 step and the drive's one-release
// `add_pattern` alias both call in here, so a document written by the alias and
// one loaded from an old file land byte-for-byte the same row.
//
// The feature id, and therefore every `@<id>` ref, a boolean's `@<patternId>`
// expansion and a face query naming the feature, is untouched. The instance
// keys are untouched too: a linear run keeps the decimal `1`, `2` keys, and a
// rectangular grid keeps its row-major `i:j` order, which is exactly the order
// `rectangularIndices` builds. So the copies' construction UUIDs do not move.
//
// `include_source` is dropped: every pattern always includes the source as
// instance 0, so the retired flag would be a key no reader honours and the new
// schema refuses. A non-integer skip entry on a circular row is dropped as
// well: a `i:j` cell names a grid a circular pattern does not have, so the old
// kernel only ever reported it as a stale entry.

import type { CircularPatternDef, LinearPatternDef } from '@/types/cad'

type Dict = Record<string, unknown>

export type SplitPatternDef =
  | { kind: 'linear_pattern'; def: LinearPatternDef }
  | { kind: 'circular_pattern'; def: CircularPatternDef }

const SOURCE_FIELDS = [
  'subject', 'source_body', 'operation', 'source_features', 'source_feature', 'target_body',
] as const

// Direction-1 fields a linear row inherits unchanged. The rectangular spelling
// maps its `_x` names onto these, so the kernel reads one set of direction keys.
const DIRECTION_1_FIELDS = ['count', 'centered', 'pitch', 'direction', 'direction_query', 'invert'] as const

const CIRCULAR_FIELDS = [
  'count', 'centered', 'angle', 'equal_spacing', 'axis', 'axis_origin', 'axis_direction', 'invert_axis',
] as const

/** Copy only the keys that are present, so a migrated row never carries an
 *  `undefined` the original did not. */
function pick(from: Dict, keys: readonly string[]): Dict {
  const out: Dict = {}
  for (const key of keys) {
    if (from[key] !== undefined) out[key] = from[key]
  }
  return out
}

/** The stored skip list, with the grid cells a circular pattern cannot address
 *  removed. Anything that is not an array passes through untouched so the
 *  loader can refuse it by field instead of the migration inventing a shape. */
function circularSkip(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.filter((entry) => typeof entry === 'number')
}

/**
 * Translate one legacy `pattern` payload into the kind and definition that
 * replace it. Pure; the caller owns where the result is written.
 */
export function splitPatternDef(legacy: Dict): SplitPatternDef {
  const source = pick(legacy, SOURCE_FIELDS)
  const mode = legacy.mode ?? 'linear'

  if (mode === 'circular') {
    const def: Dict = { ...source, ...pick(legacy, CIRCULAR_FIELDS) }
    if (legacy.skip !== undefined) def.skip = circularSkip(legacy.skip)
    // The old `step_angle` was a step, so it becomes the increment form; an
    // absent step was the evenly-spaced default over the full turn.
    const step = legacy.step_angle
    if (step === undefined || step === null) {
      def.angle = 360
      def.equal_spacing = true
    } else {
      def.angle = step
      def.equal_spacing = false
    }
    return { kind: 'circular_pattern', def: def as CircularPatternDef }
  }

  // The old rectangular mode read only its `_x`/`_y` fields; a stray one-axis
  // `centered`, `pitch` or `direction` beside them was ignored, so those are not
  // copied here (copying `centered` would silently turn the grid centered).
  const def: Dict = mode === 'rectangular'
    ? { ...source }
    : { ...source, ...pick(legacy, DIRECTION_1_FIELDS) }
  if (legacy.skip !== undefined) def.skip = legacy.skip
  if (mode === 'rectangular') {
    // The old grid's X axis is direction 1 and its Y axis direction 2. The
    // 2D skip keys (`i:j`, column first) already match the instance model's.
    def.second_direction = true
    const axis2: Array<[keyof LinearPatternDef, unknown]> = [
      ['count_2', legacy.count_y],
      ['centered_2', legacy.centered_y],
      ['pitch_2', legacy.pitch_y],
      ['direction_2', legacy.direction_y],
      ['direction_2_query', legacy.direction_y_query],
      ['invert_2', legacy.invert_y],
    ]
    for (const [key, value] of axis2) {
      if (value !== undefined) def[key] = value
    }
    // The `_x` spelling is the direction-1 axis under its old name.
    const axis1: Array<[keyof LinearPatternDef, unknown]> = [
      ['count', legacy.count_x],
      ['centered', legacy.centered_x],
      ['pitch', legacy.pitch_x],
      ['direction', legacy.direction_x],
      ['direction_query', legacy.direction_x_query],
      ['invert', legacy.invert_x],
    ]
    for (const [key, value] of axis1) {
      if (value !== undefined) def[key] = value
    }
  }
  return { kind: 'linear_pattern', def: def as LinearPatternDef }
}

/** Rewrite one stored feature row in place. Answers whether it changed
 *  anything, so the migration step can report what it healed. A row that is not
 *  the retired kind, or whose payload is not a mapping, is left for the
 *  validator. */
export function splitStoredPattern(row: Dict): boolean {
  if (row.kind !== 'pattern') return false
  const legacy = row.pattern
  if (typeof legacy !== 'object' || legacy === null || Array.isArray(legacy)) return false
  const { kind, def } = splitPatternDef(legacy as Dict)
  delete row.pattern
  row.kind = kind
  row[kind] = def
  return true
}
