// Structural validation of a raw JSON selector, run at the MCP argument
// boundary before the engine sees it. Unknown keys fail loud by name so a typo
// (`parallelish`) is rejected rather than silently matching everything, which
// is the same contract the tool schemas keep for top-level fields.

import type { Predicate, RadiusTest, SelectKind, Selector, Vec3 } from './types'
import { SelectorError } from './errors'
import { suggestTypeName, typeVocabulary } from './geometry'

// Every predicate key the grammar admits. `and`/`or`/`not` compose; the rest
// are leaves. Kept as data so the unknown-key rejection and the schema agree.
export const PREDICATE_KEYS = [
  'and', 'or', 'not', 'parallel', 'perpendicular', 'type', 'extreme', 'within', 'on_face', 'created_by', 'radius',
] as const

const SELECTOR_KEYS = ['from', 'kind', 'where']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asObject(v: unknown, path: string): Record<string, unknown> {
  if (!isObject(v)) throw new SelectorError(`${path} must be an object`)
  return v
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new SelectorError(`${path} has unknown key "${key}"`)
  }
}

function vec3(v: unknown, path: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new SelectorError(`${path} must be three finite numbers`)
  }
  // A zero axis is degenerate: the dot product with every direction is zero, so
  // a perpendicular test would match everything. Refuse it at the boundary.
  if (v[0] === 0 && v[1] === 0 && v[2] === 0) {
    throw new SelectorError(`${path} must be a non-zero axis`)
  }
  return [v[0], v[1], v[2]]
}

function radiusTest(v: unknown, path: string): RadiusTest {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const record = asObject(v, path)
  rejectUnknown(record, ['eq', 'min', 'max'], path)
  const out: { eq?: number; min?: number; max?: number } = {}
  for (const key of ['eq', 'min', 'max'] as const) {
    if (record[key] === undefined) continue
    const n = record[key]
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new SelectorError(`${path}.${key} must be a finite number`)
    out[key] = n
  }
  if (Object.keys(out).length === 0) throw new SelectorError(`${path} needs at least one of eq/min/max`)
  return out
}

// The three world axes an author may name as one letter instead of spelling the
// vector. Kept as sugar only: the stored selector always carries a vector.
const AXIS_SUGAR: Readonly<Record<string, Vec3>> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

/** An extreme axis: the sugar letter or three finite non-zero numbers. The
 *  failure repeats the whole clause, so a caller sees the shape it must fix
 *  rather than a bare "axis must be three finite numbers". */
function extremeAxis(value: unknown, path: string, clause: unknown): Vec3 {
  if (typeof value === 'string') {
    const sugar = AXIS_SUGAR[value.trim().toLowerCase()]
    if (sugar !== undefined) return sugar
  }
  if (Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n))
    && !(value[0] === 0 && value[1] === 0 && value[2] === 0)) {
    return [value[0], value[1], value[2]]
  }
  throw new SelectorError(
    `${path} {"extreme":${JSON.stringify(clause)}} needs a non-zero axis: "x" | "y" | "z" or three finite numbers`,
  )
}

function predicate(raw: unknown, path: string): Predicate {
  const record = asObject(raw, path)
  const keys = Object.keys(record).filter(k => record[k] !== undefined)
  if (keys.length !== 1) {
    // A side-by-side pair is the natural mistake; name the composition key
    // instead of leaving the author to guess how to combine two tests.
    const hint = keys.length > 1
      ? '; wrap several keys in "and", e.g. {"and":[{"type":"line"},{"parallel":[0,1,0]}]}'
      : ''
    throw new SelectorError(
      `${path} must carry exactly one predicate key (${PREDICATE_KEYS.join(', ')})${hint}`,
    )
  }
  const key = keys[0]
  if (!(PREDICATE_KEYS as readonly string[]).includes(key)) {
    throw new SelectorError(`${path} has unknown predicate "${key}"`)
  }
  const value = record[key]
  switch (key) {
    case 'and':
    case 'or': {
      if (!Array.isArray(value) || value.length === 0) throw new SelectorError(`${path}.${key} must be a non-empty array`)
      return { [key]: value.map((child, i) => predicate(child, `${path}.${key}[${i}]`)) } as Predicate
    }
    case 'not':
      return { not: predicate(value, `${path}.not`) }
    case 'parallel':
      return { parallel: vec3(value, `${path}.parallel`) }
    case 'perpendicular':
      return { perpendicular: vec3(value, `${path}.perpendicular`) }
    case 'type':
      if (typeof value !== 'string' || value.length === 0) throw new SelectorError(`${path}.type must be a non-empty string`)
      return { type: value }
    case 'extreme': {
      const spec = asObject(value, `${path}.extreme`)
      rejectUnknown(spec, ['axis', 'side'], `${path}.extreme`)
      const side = spec.side
      if (side !== 'min' && side !== 'max') throw new SelectorError(`${path}.extreme.side must be "min" or "max"`)
      const clause = { axis: spec.axis, side: spec.side }
      return { extreme: { axis: extremeAxis(spec.axis, `${path}.extreme`, clause), side } }
    }
    case 'within': {
      const spec = asObject(value, `${path}.within`)
      rejectUnknown(spec, ['axis', 'min', 'max'], `${path}.within`)
      const axis = spec.axis
      if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
        throw new SelectorError(`${path}.within.axis must be "x", "y" or "z"`)
      }
      const out: { axis: 'x' | 'y' | 'z'; min?: number; max?: number } = { axis }
      for (const key of ['min', 'max'] as const) {
        if (spec[key] === undefined) continue
        const n = spec[key]
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          throw new SelectorError(`${path}.within.${key} must be a finite number`)
        }
        out[key] = n
      }
      if (out.min === undefined && out.max === undefined) {
        throw new SelectorError(`${path}.within needs at least one of min/max`)
      }
      if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
        throw new SelectorError(`${path}.within.min (${out.min}) must not exceed max (${out.max})`)
      }
      return { within: out }
    }
    case 'on_face':
      return { on_face: selector(value, `${path}.on_face`) }
    case 'created_by':
      if (typeof value !== 'string' || value.length === 0) throw new SelectorError(`${path}.created_by must be a non-empty string`)
      return { created_by: value }
    case 'radius':
      return { radius: radiusTest(value, `${path}.radius`) }
    default:
      // Unreachable: the key check above gates this.
      throw new SelectorError(`${path} has unknown predicate "${key}"`)
  }
}

/** Refuse a `type` name outside the kind's vocabulary. Left to the engine, such
 *  a clause matches nothing; under a `not` it would silently match everything.
 *  The message names the vocabulary and the likely spelling. */
function validateTypeNames(p: Predicate, kind: SelectKind, path: string): void {
  if ('type' in p) {
    const valid = typeVocabulary(kind)
    if (valid.includes(p.type)) return
    const suggestion = suggestTypeName(p.type, kind)
    const noun = kind === 'edge' ? 'edge kind' : 'face surface type'
    throw new SelectorError(
      `${path}.type "${p.type}" is not a valid ${noun}`
      + `${suggestion === null ? '' : `; did you mean "${suggestion}"?`}; valid: ${valid.join(', ')}`,
    )
  }
  if ('and' in p) {
    for (const child of p.and) validateTypeNames(child, kind, path)
    return
  }
  if ('or' in p) {
    for (const child of p.or) validateTypeNames(child, kind, path)
    return
  }
  if ('not' in p) validateTypeNames(p.not, kind, path)
}

/** Validate a selector expression, naming the offending field. */
export function selector(raw: unknown, path = 'selector'): Selector {
  const record = asObject(raw, path)
  rejectUnknown(record, SELECTOR_KEYS, path)
  const kind = record.kind
  if (kind !== 'edge' && kind !== 'face') throw new SelectorError(`${path}.kind must be "edge" or "face"`)
  if (record.from !== undefined && (typeof record.from !== 'string' || record.from.length === 0)) {
    throw new SelectorError(`${path}.from must be a non-empty string`)
  }
  const where = record.where === undefined ? undefined : predicate(record.where, `${path}.where`)
  if (where !== undefined) validateTypeNames(where, kind, `${path}.where`)
  return {
    ...(record.from !== undefined && { from: record.from as string }),
    kind,
    ...(where !== undefined && { where }),
  }
}
