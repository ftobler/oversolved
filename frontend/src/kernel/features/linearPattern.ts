// The linear pattern leaf. One direction repeats the subject along a picked
// edge or face; turning the second direction on adds the grid the retired
// rectangular mode built, with direction 1 as the column and direction 2 as the
// row. The instance keys and their order are the instance model's, so a
// rectangular document keeps every copy UUID when it migrates.
//
// Direction resolution lives here because it is this kind's only geometric
// question; the shared subject dispatch and instance filtering are pattern.ts.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { makeTranslationTrsf } from '../occ/transforms'
import { resolveDirectionQueryStrict } from './shared/directionQuery'
import {
  generatedCount, instanceIndices, rectangularIndices, toInstances,
} from './patternInstances'
import {
  keptInstances, patternCountOf, patternNumber, solvePatternInstances,
  type Dict, type PatternCopy,
} from './pattern'
import type { PatternResult } from './patternFeature'
import type { BodyPatternResult } from './patternBody'

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

/** The copies a linear pattern generates, each with its naming key and the
 *  translation that places it. Count 1 (and 1x1) generate an empty list: the
 *  caller's quiet no-op. */
export function buildLinearCopies(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): { copies: PatternCopy[]; warnings: string[] } {
  const count = patternCountOf(sub, 'count', 2)
  const centered = sub.centered === true
  const pitch = patternNumber(sub, 'pitch', 20)
  const dir = resolvePatternDirection(
    (sub.direction_query as string) ?? '',
    sub.direction,
    (sub.invert as boolean) ?? false,
    'direction',
    globalRepo,
    bodyStore,
  )

  if (sub.second_direction === true) {
    const count2 = patternCountOf(sub, 'count_2', 2)
    const centered2 = sub.centered_2 === true
    const total = generatedCount(count, centered) * generatedCount(count2, centered2)
    const generated = toInstances(rectangularIndices(count, count2, centered, centered2))
    const { kept, warnings } = keptInstances(generated, sub, total, `count ${count} by count_2 ${count2}`)
    const pitch2 = patternNumber(sub, 'pitch_2', 20)
    const dir2 = resolvePatternDirection(
      (sub.direction_2_query as string) ?? '',
      sub.direction_2,
      (sub.invert_2 as boolean) ?? false,
      'direction 2',
      globalRepo,
      bodyStore,
    )
    const copies = kept.map((instance) => {
      const [i, j] = instance.index as readonly [number, number]
      // The seed cell (0,0) is the source slot, never a copy.
      return {
        key: instance.key,
        trsf: makeTranslationTrsf(
          oc,
          scope,
          dir[0] * pitch * i + dir2[0] * pitch2 * j,
          dir[1] * pitch * i + dir2[1] * pitch2 * j,
          dir[2] * pitch * i + dir2[2] * pitch2 * j,
        ),
      }
    })
    return { copies, warnings }
  }

  const generated = toInstances(instanceIndices(count, centered))
  const { kept, warnings } = keptInstances(generated, sub, generatedCount(count, centered), `count ${count}`)
  const copies = kept.map((instance) => {
    const i = instance.index as number
    return {
      key: instance.key,
      trsf: makeTranslationTrsf(oc, scope, dir[0] * pitch * i, dir[1] * pitch * i, dir[2] * pitch * i),
    }
  })
  return { copies, warnings }
}

/** The `linear_pattern` leaf entry. */
export function solveLinearPattern(
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
  const sub = (feature.linear_pattern as Dict) ?? {}
  return solvePatternInstances(
    oc, scope, table, feature, sub, globalRepo, bodyStore, featuresById, solveContext,
    () => buildLinearCopies(oc, scope, sub, globalRepo, bodyStore),
  )
}
