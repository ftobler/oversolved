// The pattern leaf. It repeats one or more subjects through a grid of rigid
// instance transforms. The subject is the authored choice:
//
// - `body` copies a whole body. `operation: add` fuses the copies into the
//   source body and `operation: new` mints one body per copy; that half lives in
//   patternBody.ts.
// - `feature` repeats one or more earlier solid-producing features' own add or
//   cut inside the body each feature already shaped. A body array plus a boolean
//   can produce the same geometry, but it needs the material as its own body
//   first and a merge afterwards; this subject asks the kernel for each source
//   feature's tool once and applies those tools at each copy position through the
//   same `applyBodyOperation` every producer uses.
//
// Each source feature's tool is obtained by re-solving the source feature with
// its operation forced to `new` into a throwaway body store: the same leaf, the
// same profile resolution and the same names, with no second geometry builder.
// Those scratch bodies are released at the end of this solve; they never enter
// the real store, so no part row or checkpoint sees them.
//
// Several sources are a union: every source's tool is applied at every grid
// instance, in the order the sources sit in the feature log (then each source's
// own output order). The first source's first produced body is the instance-0
// seed, because the grid always leaves the seed slot to the sources. A source
// that no longer exists or now sits after the pattern is dropped with a named
// warning on the result; a pattern left with no source is refused by name.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccTrsf } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { applyBodyPattern, resolvePatternSourceBody, type BodyPatternResult } from './patternBody'
import { resolveDirectionQueryStrict, resolveAxisQueryStrict } from './shared/directionQuery'
import { makeTranslationTrsf, makeRotationTrsf } from '../occ/transforms'
import { solveFeaturePattern, type PatternResult } from './patternFeature'
import { patternSubject } from '@/utils/core/patternSubject'
import { canonicalSkip, skipValue, type SkipEntry } from '@/utils/core/patternSkip'
import {
  circularCoincidentRefusal,
  filterSkippedInstances,
  generatedCount,
  instanceIndices,
  instanceTotalProblem,
  patternCountProblem,
  rectangularIndices,
  staleSkipWarnings,
  toInstances,
  type PatternInstance,
} from './patternInstances'

export type Dict = Record<string, unknown>

/** One copy to build: its naming key and the rigid transform that places it.
 *  The key, not the array position, is what `arrayInstancePath` records, so a
 *  skipped or reverse-side instance cannot renumber its siblings. */
export interface PatternCopy {
  key: string
  trsf: OccTrsf
}

/**
 * Resolve a required linear direction, applying an invert toggle. An explicit
 * pick query wins. Without one, a stored vector is honoured as a unit world
 * vector: the schema accepted it but the leaf used to ignore it and report the
 * direction as missing. With neither, the solve fails rather than falling back
 * to a world axis, so a user cannot accidentally repeat geometry along an
 * arbitrary direction.
 */
export function resolvePatternDirection(
  query: string,
  stored: unknown,
  invert: boolean,
  field: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null,
): number[] {
  let dir: number[]
  if (query) {
    const resolved = resolveDirectionQueryStrict(query, globalRepo, bodyStore)
    if (!resolved) {
      throw new Error(`pattern: ${field} query '${query}' did not resolve to a straight edge or planar face`)
    }
    dir = resolved
  } else {
    if (stored === undefined || stored === null) {
      throw new Error(`pattern: ${field} is required; pick a straight edge or planar face`)
    }
    if (!Array.isArray(stored) || stored.length !== 3 || !stored.every((c) => typeof c === 'number' && Number.isFinite(c))) {
      throw new Error(`pattern: ${field} must be three finite numbers, got ${JSON.stringify(stored)}`)
    }
    const len = Math.hypot(stored[0], stored[1], stored[2])
    if (len < 1e-12) throw new Error(`pattern: ${field} must be a non-zero vector`)
    dir = (stored as number[]).map((c) => c / len)
  }
  // `c === 0 ? 0 : -c` keeps the negated zero components as +0, not -0.
  return invert ? dir.map((c) => (c === 0 ? 0 : -c)) : dir
}

/** A stored VEC3 field, or null when absent; a malformed value is a solve error. */
function storedVec3(value: unknown, key: string): number[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length !== 3 || !value.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    throw new Error(`pattern: ${key} must be three finite numbers, got ${JSON.stringify(value)}`)
  }
  return value as number[]
}

/**
 * A rotation axis, with the same precedence transform uses for its rotation: an
 * `axis` pick wins; else the stored `axis_origin` / `axis_direction` pair, where
 * a direction alone rotates about the world origin and an origin alone uses +Z
 * (transform's rule, so one default holds for both). Neither is a solve error
 * rather than a silent rotation about a world axis.
 */
export function resolvePatternAxis(
  axisQuery: string,
  originValue: unknown,
  directionValue: unknown,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): [number[], number[]] {
  // The pick can be a straight edge, circular edge, sketch line, sketch
  // circle, cylindrical face, or planar face.
  if (axisQuery) {
    const axis = resolveAxisQueryStrict(axisQuery, globalRepo, bodyStore)
    if (!axis) throw new Error(`pattern: axis query '${axisQuery}' did not resolve to a usable axis`)
    return axis
  }
  const origin = storedVec3(originValue, 'axis_origin')
  const direction = storedVec3(directionValue, 'axis_direction')
  if (origin === null && direction === null) {
    throw new Error(
      'pattern: axis is required; pick an edge, sketch entity, or face as `axis`, ' +
        'or store the pair `axis_origin` + `axis_direction`',
    )
  }
  const dir = direction ?? [0, 0, 1]
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (len < 1e-12) throw new Error('pattern: axis_direction must be a non-zero vector')
  return [origin ?? [0, 0, 0], dir.map((c) => c / len)]
}

function countOf(sub: Dict, fallback: number): number {
  const count = Number(sub.count ?? fallback)
  const problem = patternCountProblem(count)
  if (problem !== null) throw new Error(`pattern: ${problem}`)
  return count
}

/** The stored skip list, canonical. A text spelling is accepted here too: the
 *  drive parses it before it stores, but a direct leaf caller may not. */
function skipOf(sub: Dict): SkipEntry[] {
  const raw = sub.skip
  if (raw === undefined || raw === null) return []
  const value = skipValue(raw)
  if ('error' in value) throw new Error(`pattern: skip ${value.error}`)
  return canonicalSkip(value.skip)
}

/** The generated instances after the skip list, plus the warning a stale skip
 *  entry earns. The cap is checked on the generated total before skips, so a
 *  centered count cannot slip past it by skipping half the copies. */
function keptInstances(
  generated: PatternInstance[],
  sub: Dict,
  total: number,
  setting: string,
): { kept: PatternInstance[]; warnings: string[] } {
  const cap = instanceTotalProblem(total)
  if (cap !== null) throw new Error(`pattern: ${cap}`)
  const filtered = filterSkippedInstances(generated, skipOf(sub))
  return { kept: filtered.kept, warnings: staleSkipWarnings(filtered.stale, setting) }
}

function positiveInteger(value: unknown, key: string, fallback: number): number {
  const count = Number(value ?? fallback)
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`pattern: ${key} must be a positive integer, got ${value}`)
  }
  return count
}

function finite(value: unknown, key: string, fallback: number): number {
  const n = Number(value ?? fallback)
  if (!Number.isFinite(n)) throw new Error(`pattern: ${key} must be a finite number, got ${value}`)
  return n
}

/**
 * The copies one pattern generates, each with its naming key. The subject's own
 * slot is instance 0 and every mode counts it, so the builder emits one copy per
 * generated instance except the source. Count 1, and a skip list covering every
 * generated instance, therefore return an empty copy list: the caller's quiet
 * no-op.
 */
export function buildPatternCopies(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): { copies: PatternCopy[]; warnings: string[] } {
  const mode = (sub.mode as string) ?? 'linear'

  if (mode === 'linear') {
    const count = countOf(sub, 2)
    const centered = sub.centered === true
    const generated = toInstances(instanceIndices(count, centered))
    const { kept, warnings } = keptInstances(generated, sub, generatedCount(count, centered), `count ${count}`)
    const pitch = finite(sub.pitch, 'pitch', 20)
    const dir = resolvePatternDirection(
      (sub.direction_query as string) ?? '',
      sub.direction,
      (sub.invert as boolean) ?? false,
      'direction',
      globalRepo,
      bodyStore,
    )
    const copies = kept.map((instance) => {
      const i = instance.index as number
      return {
        key: instance.key,
        trsf: makeTranslationTrsf(oc, scope, dir[0] * pitch * i, dir[1] * pitch * i, dir[2] * pitch * i),
      }
    })
    return { copies, warnings }
  }

  if (mode === 'rectangular') {
    const countX = positiveInteger(sub.count_x, 'count_x', 2)
    const countY = positiveInteger(sub.count_y, 'count_y', 2)
    const centeredX = sub.centered_x === true
    const centeredY = sub.centered_y === true
    const total = generatedCount(countX, centeredX) * generatedCount(countY, centeredY)
    const generated = toInstances(rectangularIndices(countX, countY, centeredX, centeredY))
    const { kept, warnings } = keptInstances(generated, sub, total, `count_x ${countX} by count_y ${countY}`)
    const pitchX = finite(sub.pitch_x, 'pitch_x', 20)
    const pitchY = finite(sub.pitch_y, 'pitch_y', 20)
    const dirX = resolvePatternDirection(
      (sub.direction_x_query as string) ?? '', sub.direction_x, (sub.invert_x as boolean) ?? false,
      'direction X', globalRepo, bodyStore,
    )
    const dirY = resolvePatternDirection(
      (sub.direction_y_query as string) ?? '', sub.direction_y, (sub.invert_y as boolean) ?? false,
      'direction Y', globalRepo, bodyStore,
    )
    const copies = kept.map((instance) => {
      const [i, j] = instance.index as readonly [number, number]
      // The seed cell (0,0) is the source slot, never a copy.
      return {
        key: instance.key,
        trsf: makeTranslationTrsf(
          oc,
          scope,
          dirX[0] * pitchX * i + dirY[0] * pitchY * j,
          dirX[1] * pitchX * i + dirY[1] * pitchY * j,
          dirX[2] * pitchX * i + dirY[2] * pitchY * j,
        ),
      }
    })
    return { copies, warnings }
  }

  if (mode === 'circular') {
    const count = countOf(sub, 4)
    const centered = sub.centered === true
    const generated = toInstances(instanceIndices(count, centered))
    const { kept, warnings } = keptInstances(generated, sub, generatedCount(count, centered), `count ${count}`)
    const stepRaw = sub.step_angle
    // A centered pattern with no explicit step spreads its instances over the
    // full turn: 2 * count - 1 slots, not count, so the reverse side does not
    // land on the forward side.
    const step = stepRaw === undefined || stepRaw === null
      ? 360.0 / (centered ? generatedCount(count, true) : count)
      : Number(stepRaw)
    if (!Number.isFinite(step)) {
      throw new Error(`pattern: step_angle must be a finite number, got ${sub.step_angle}`)
    }
    const coincident = circularCoincidentRefusal(kept.map((instance) => instance.index), step)
    if (coincident !== null) throw new Error(coincident)
    const [origin, resolvedDirection] = resolvePatternAxis(
      (sub.axis as string) ?? '',
      sub.axis_origin,
      sub.axis_direction,
      globalRepo,
      bodyStore,
    )
    // Invert flips the axis direction, which reverses the sweep sense.
    const invert = (sub.invert_axis as boolean) ?? false
    const axisDirection = invert ? resolvedDirection.map((c) => (c === 0 ? 0 : -c)) : resolvedDirection
    const copies = kept.map((instance) => {
      const i = instance.index as number
      return {
        key: instance.key,
        trsf: makeRotationTrsf(oc, scope, origin, axisDirection, ((step * i) * Math.PI) / 180),
      }
    })
    return { copies, warnings }
  }

  throw new Error(`pattern: unknown mode '${mode}'`)
}

/** Merge the instance model's warnings into a leaf result. */
function withWarnings<T extends { solver_warning?: string }>(result: T, warnings: readonly string[]): T {
  if (warnings.length === 0) return result
  const joined = [result.solver_warning, ...warnings].filter((part): part is string => !!part).join('; ')
  return { ...result, solver_warning: joined }
}

/**
 * Solve a pattern of either subject. A body pattern copies a body through the
 * grid; a feature pattern reapplies an earlier feature's own add or cut.
 */
export function solvePattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict> = {},
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> } = {
    variables: {}, laterVariables: {},
  },
): PatternResult | BodyPatternResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.pattern as Dict) ?? {}
  // A document authored before the subject field is read from the source it
  // actually names. The editor and the boolean leaf share this one rule, so an
  // old feature pattern is not silently edited or expanded as a body pattern.
  const subject = patternSubject(sub)

  if (subject === 'body') {
    const body = resolvePatternSourceBody(sub, bodyStore)
    const operation = (sub.operation as string) ?? 'add'
    const built = buildPatternCopies(oc, scope, sub, globalRepo, bodyStore)
    // Count 1, or a skip list covering every generated instance, leaves the
    // source exactly as it was: ok, no warning, and `new` mints nothing.
    if (built.copies.length === 0) {
      const noop: BodyPatternResult = {
        status: 'ok',
        body_id: body.id,
        body_ids: operation === 'new' ? [] : [body.id],
        operation,
      }
      return withWarnings(noop, built.warnings)
    }
    const result = applyBodyPattern(oc, scope, table, body, built.copies, operation, featureId, bodyStore)
    return withWarnings(result, built.warnings)
  }

  if (subject === 'feature') {
    const built = buildPatternCopies(oc, scope, sub, globalRepo, bodyStore)
    return solveFeaturePattern(
      oc, scope, table, feature, globalRepo, bodyStore, featuresById, solveContext,
      built.copies, built.warnings,
    )
  }

  throw new Error(`pattern: unknown subject '${subject}'; choose body or feature`)
}
