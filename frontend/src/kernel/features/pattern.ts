// The pattern core the two pattern kinds share: a body pattern copies a whole
// body, a feature pattern repeats earlier features' own add or cut. Each kind's
// leaf (linearPattern.ts, circularPattern.ts) builds the instance list and the
// rigid transform that places each one; here the list becomes geometry.
//
// - `body` copies a whole body. `operation: add` fuses the copies into the
//   source body and `operation: new` mints one body per copy; that half lives in
//   patternPart.ts.
// - `feature` repeats one or more earlier solid-producing features' own add or
//   cut inside the body each feature already shaped. A body array plus a boolean
//   can produce the same geometry, but it needs the material as its own body
//   first and a merge afterwards; this subject asks the kernel for each source
//   feature's tool once and applies those tools at each copy position through the
//   same `applyPartOperation` every producer uses.
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
import type { PartSolid } from '../types3d'
import type { Repository } from '../query'
import { applyPartPattern, resolvePatternSourcePart, type PartPatternResult } from './patternPart'
import { solveFeaturePattern, type PatternResult } from './patternFeature'
import { patternSubject } from '@/utils/core/patternSubject'
import { canonicalSkip, skipValue, type SkipEntry } from '@/utils/core/patternSkip'
import {
  filterSkippedInstances,
  instanceTotalProblem,
  staleSkipWarnings,
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

/** The stored skip list, canonical. A text spelling is accepted here too: the
 *  drive parses it before it stores, but a direct leaf caller may not. */
export function skipOf(sub: Dict): SkipEntry[] {
  const raw = sub.skip
  if (raw === undefined || raw === null) return []
  const value = skipValue(raw)
  if ('error' in value) throw new Error(`pattern: skip ${value.error}`)
  return canonicalSkip(value.skip)
}

/** The generated instances after the skip list, plus the warning a stale skip
 *  entry earns. The cap is checked on the generated total before skips, so a
 *  centered count cannot slip past it by skipping half the copies. */
export function keptInstances(
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

/** The count rule every axis shares: a whole number of at least 1 and within
 *  the cap. A string is an expression and is judged after it resolves, so only
 *  a literal number can be refused here. */
export function patternCountOf(sub: Dict, key: string, fallback: number): number {
  const count = Number(sub[key] ?? fallback)
  const value = Number.isFinite(count) ? count : NaN
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`pattern: ${key} must be a whole number of at least 1; 1 keeps only the original, got ${sub[key]}`)
  }
  return value
}

/** A required finite number with a default, shared by the pitch and angle
 *  fields. The expression resolver has already turned a string into a number. */
export function patternNumber(sub: Dict, key: string, fallback: number): number {
  const n = Number(sub[key] ?? fallback)
  if (!Number.isFinite(n)) throw new Error(`pattern: ${key} must be a finite number, got ${sub[key]}`)
  return n
}

/** The copies a kind built, plus the computed values a result reports back to
 *  the editor (the pattern's resolved spacing). */
export interface PatternCopies {
  copies: PatternCopy[]
  warnings: string[]
  extra?: Dict
}

/** Merge the instance model's warnings and the leaf's computed values into a
 *  leaf result. */
function withWarnings<T extends { solver_warning?: string }>(
  result: T,
  warnings: readonly string[],
  extra?: Dict,
): T {
  const merged = extra === undefined ? result : { ...result, ...extra }
  if (warnings.length === 0) return merged
  const joined = [result.solver_warning, ...warnings].filter((part): part is string => !!part).join('; ')
  return { ...merged, solver_warning: joined }
}

/**
 * Solve a pattern of either subject from the copies one kind built. A body
 * pattern copies a body through the grid; a feature pattern reapplies an earlier
 * feature's own add or cut.
 */
export function solvePatternInstances(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  sub: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  featuresById: Record<string, Dict>,
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> },
  // Lazy so the subject's own diagnosis (a missing source body, a source that
  // names several) still comes before any direction or axis is resolved, the
  // order the single-kind leaf used to have.
  build: () => PatternCopies,
): PatternResult | PartPatternResult {
  const featureId = (feature.id as string) ?? ''
  // A document authored before the subject field is read from the source it
  // actually names. The editor and the boolean leaf share this one rule, so an
  // old feature pattern is not silently edited or expanded as a body pattern.
  const subject = patternSubject(sub)

  if (subject === 'body') {
    const part = resolvePatternSourcePart(sub, partStore)
    const operation = (sub.operation as string) ?? 'add'
    const built = build()
    // Count 1, 1x1, or a skip list covering every generated instance, leaves the
    // source exactly as it was: ok, no warning, and `new` mints nothing.
    if (built.copies.length === 0) {
      const noop: PartPatternResult = {
        status: 'ok',
        body_id: part.id,
        body_ids: operation === 'new' ? [] : [part.id],
        operation,
      }
      return withWarnings(noop, built.warnings, built.extra)
    }
    const result = applyPartPattern(oc, scope, table, part, built.copies, operation, featureId, partStore)
    return withWarnings(result, built.warnings, built.extra)
  }

  if (subject === 'feature') {
    const built = build()
    return solveFeaturePattern(
      oc, scope, table, feature, sub, globalRepo, partStore, featuresById, solveContext,
      built.copies, built.warnings, built.extra,
    )
  }

  throw new Error(`pattern: unknown subject '${subject}'; choose body or feature`)
}
