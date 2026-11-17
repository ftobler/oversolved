// The linear pattern leaf. One direction repeats the subject along a picked
// edge or face; turning the second direction on adds the grid the retired
// rectangular mode built, with direction 1 as the column and direction 2 as the
// row. The instance keys and their order are the instance model's, so a
// rectangular document keeps every copy UUID when it migrates.
//
// Each direction has a step mode (LinearDirectionMode in types/cad.ts):
// - direction_distance (the default, and what a document written before the
//   field means): the pick or the stored vector gives the unit direction and
//   `pitch` the spacing.
// - directive_length: the pick's own length IS the spacing, so a 15 mm edge puts
//   neighbours 15 mm apart; `pitch` is not read. A pick without a length (a
//   planar face, a circle, an arc) is refused by name.
// - manual: `direction` is the step vector itself, direction and spacing in one,
//   so its magnitude is the spacing. No pick and no pitch.
// Instance i translates by i * step (the second direction by j * step2), and the
// instance model and its keys are unchanged whichever mode produced the step.
//
// Direction resolution lives here because it is this kind's only geometric
// question; the shared subject dispatch and instance filtering are pattern.ts.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { PartSolid } from '../types3d'
import type { Repository } from '../query'
import { makeTranslationTrsf } from '../occ/transforms'
import {
  resolveAxisCarrierRef, resolveCircularReference, resolveDirectionQueryStrict,
} from './shared/directionQuery'
import { resolveAxisCarrier, type AxisSenseContext } from './shared/axisSense'
import type { LinearDirectionMode } from '@/types/cad'
import { isLinearDirectionMode } from '@/utils/core/linearPatternModes'
import {
  generatedCount, instanceIndices, rectangularIndices, toInstances,
} from './patternInstances'
import {
  keptInstances, patternCountOf, patternNumber, solvePatternInstances,
  type Dict, type PatternCopy,
} from './pattern'
import type { PatternResult } from './patternFeature'
import type { PartPatternResult } from './patternPart'

/** What resolving a direction's pick needs from the OCC side, beyond the repo.
 *  Optional so a pure caller of the copy builders keeps working: without it an
 *  axis carrier keeps its raw OCC axis sense, and a directive-length pick on a
 *  face is refused because its extent cannot be read. */
export type LinearOccContext = AxisSenseContext

/** The stored keys one direction owns. */
interface DirectionSide {
  mode: string
  query: string
  stored: string
  invert: string
  pitch: string
  label: string
}

const SIDES: Record<1 | 2, DirectionSide> = {
  1: {
    mode: 'direction_mode', query: 'direction_query', stored: 'direction',
    invert: 'invert', pitch: 'pitch', label: 'direction',
  },
  2: {
    mode: 'direction_2_mode', query: 'direction_2_query', stored: 'direction_2',
    invert: 'invert_2', pitch: 'pitch_2', label: 'direction 2',
  },
}

/** The stored mode, or the default. An unknown spelling is refused here rather
 *  than folded to the default, so a direct leaf caller hears about it. */
function directionModeOf(sub: Dict, side: DirectionSide): LinearDirectionMode {
  const raw = sub[side.mode]
  if (raw === undefined || raw === null) return 'direction_distance'
  if (!isLinearDirectionMode(raw)) {
    throw new Error(
      `pattern: ${side.mode} must be direction_distance, directive_length or manual, got ${JSON.stringify(raw)}`,
    )
  }
  return raw
}

function invertOf(sub: Dict, side: DirectionSide): boolean {
  return (sub[side.invert] as boolean) ?? false
}

/** `c === 0 ? 0 : -c` keeps the negated zero components as +0, not -0. */
function flipped(vector: number[], invert: boolean): number[] {
  return invert ? vector.map((c) => (c === 0 ? 0 : -c)) : vector
}

/**
 * Resolve a required linear direction, applying an invert toggle. An explicit
 * pick query wins. Without one, a stored vector is honoured as a unit world
 * vector: the schema accepted it but the leaf used to ignore it and report the
 * direction as missing. With neither, the solve fails rather than falling back
 * to a world axis, so a user cannot accidentally repeat geometry along an
 * arbitrary direction.
 *
 * An axis carrier pick (cylindrical or conical face, circular edge, sketch
 * circle) resolves to its own axis, with the free-end sense when an OCC context
 * is supplied.
 */
export function resolvePatternDirection(
  query: string,
  stored: unknown,
  invert: boolean,
  field: string,
  globalRepo: Repository,
  partStore: Record<string, unknown> | null,
  occ: LinearOccContext | null = null,
): number[] {
  let dir: number[]
  if (query) {
    const resolved = resolveDirectionQueryStrict(query, globalRepo, partStore, occ)
    if (!resolved) {
      throw new Error(
        `pattern: ${field} query '${query}' did not resolve to an edge, sketch line, or face`,
      )
    }
    dir = resolved
  } else {
    if (stored === undefined || stored === null) {
      throw new Error(`pattern: ${field} is required; pick an edge or face, or store a direction vector`)
    }
    if (!Array.isArray(stored) || stored.length !== 3 || !stored.every((c) => typeof c === 'number' && Number.isFinite(c))) {
      throw new Error(`pattern: ${field} must be three finite numbers, got ${JSON.stringify(stored)}`)
    }
    const len = Math.hypot(stored[0], stored[1], stored[2])
    if (len < 1e-12) throw new Error(`pattern: ${field} must be a non-zero vector`)
    dir = (stored as number[]).map((c) => c / len)
  }
  return flipped(dir, invert)
}

/** Why a directive-length pick cannot give a length, or null when it can. */
function lengthPickRefusal(query: string, globalRepo: Repository, partStore: Dict | null): string | null {
  const data = globalRepo.query(query, null, partStore) as Dict | null
  const start = data?.start as number[] | undefined
  const end = data?.end as number[] | undefined
  if (Array.isArray(start) && Array.isArray(end)) {
    return 'a zero-length edge has none'
  }
  if (data !== null && 'normal' in data) return 'a planar face has none'
  return 'a circle has none'
}

/**
 * The step vector for one direction, one branch per mode. `invert` flips the
 * sense in every mode; the magnitude is the spacing and never changes sign.
 */
export function resolveLinearStep(
  sub: Dict,
  side: 1 | 2,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  occ: LinearOccContext | null = null,
): number[] {
  const keys = SIDES[side]
  const mode = directionModeOf(sub, keys)
  const invert = invertOf(sub, keys)
  const query = (sub[keys.query] as string) ?? ''

  if (mode === 'direction_distance') {
    const pitch = patternNumber(sub, keys.pitch, 20)
    const dir = resolvePatternDirection(query, sub[keys.stored], invert, keys.label, globalRepo, partStore, occ)
    return dir.map((c) => c * pitch)
  }

  if (mode === 'manual') {
    const stored = sub[keys.stored]
    if (
      !Array.isArray(stored) || stored.length !== 3
      || !stored.every((c) => typeof c === 'number' && Number.isFinite(c))
    ) {
      throw new Error(
        `pattern: ${keys.label} must be three finite numbers as a step vector in manual mode, got ${JSON.stringify(stored)}`,
      )
    }
    const step = stored as number[]
    if (Math.hypot(step[0], step[1], step[2]) < 1e-12) {
      throw new Error(`pattern: ${keys.label} must be a non-zero step vector in manual mode`)
    }
    return flipped(step, invert)
  }

  // directive_length: the pick's own direction and length are the step.
  if (!query) {
    throw new Error(
      `pattern: ${keys.label} needs a pick with a length in directive_length mode; a stored vector has none`,
    )
  }
  const carrier = resolveAxisCarrierRef(query, globalRepo, partStore)
  if (carrier !== null) {
    if (carrier.kind === 'circular_edge' || carrier.kind === 'sketch_circle') {
      throw new Error(
        `pattern: directive length needs a pick with a length (a straight edge, cylinder or cone); ${lengthPickRefusal(query, globalRepo, partStore)}`,
      )
    }
    const resolved = occ === null
      ? null
      : resolveAxisCarrier(
        carrier.kind, query,
        carrier.axis === null ? null : carrier.axis as [number, number, number],
        occ, globalRepo, partStore,
      )
    const extent = resolved?.extent ?? null
    if (resolved === null || extent === null) {
      throw new Error(
        `pattern: directive length could not read the picked face's length; pick a straight edge, cylinder or cone`,
      )
    }
    return flipped(resolved.direction, invert).map((c) => c * extent)
  }

  const line = resolveCircularReference(query, globalRepo, partStore)
  const extent = line?.extent
  if (line !== null && (line.kind === 'straight_edge' || line.kind === 'sketch_line') && extent !== undefined) {
    return flipped(line.axis, invert).map((c) => c * extent)
  }
  if (line !== null) {
    throw new Error(
      `pattern: directive length needs a pick with a length (a straight edge, cylinder or cone); ${lengthPickRefusal(query, globalRepo, partStore)}`,
    )
  }
  // A pick the circular reference skipped may still be a face or an edge too
  // short to carry a direction: say which, instead of "did not resolve".
  const data = globalRepo.query(query, null, partStore) as Dict | null
  if (data !== null && ('normal' in data || Array.isArray(data.start))) {
    throw new Error(
      `pattern: directive length needs a pick with a length (a straight edge, cylinder or cone); ${lengthPickRefusal(query, globalRepo, partStore)}`,
    )
  }
  throw new Error(
    `pattern: ${keys.label} query '${query}' did not resolve to an edge, sketch line, or face`,
  )
}

/** The copies a linear pattern generates, each with its naming key and the
 *  translation that places it. Count 1 (and 1x1) generate an empty list: the
 *  caller's quiet no-op. */
export function buildLinearCopies(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  table: HandleTable | null = null,
): { copies: PatternCopy[]; warnings: string[]; extra?: Dict } {
  const count = patternCountOf(sub, 'count', 2)
  const centered = sub.centered === true
  const occ: LinearOccContext | null = table === null ? null : { oc, scope, table }
  const step = resolveLinearStep(sub, 1, globalRepo, partStore, occ)
  const extra: Dict = { resolved_pitch: Math.hypot(step[0], step[1], step[2]) }

  if (sub.second_direction === true) {
    const count2 = patternCountOf(sub, 'count_2', 2)
    const centered2 = sub.centered_2 === true
    const total = generatedCount(count, centered) * generatedCount(count2, centered2)
    const generated = toInstances(rectangularIndices(count, count2, centered, centered2))
    const { kept, warnings } = keptInstances(generated, sub, total, `count ${count} by count_2 ${count2}`)
    const step2 = resolveLinearStep(sub, 2, globalRepo, partStore, occ)
    extra.resolved_pitch_2 = Math.hypot(step2[0], step2[1], step2[2])
    const copies = kept.map((instance) => {
      const [i, j] = instance.index as readonly [number, number]
      // The seed cell (0,0) is the source slot, never a copy.
      return {
        key: instance.key,
        trsf: makeTranslationTrsf(
          oc,
          scope,
          step[0] * i + step2[0] * j,
          step[1] * i + step2[1] * j,
          step[2] * i + step2[2] * j,
        ),
      }
    })
    return { copies, warnings, extra }
  }

  const generated = toInstances(instanceIndices(count, centered))
  const { kept, warnings } = keptInstances(generated, sub, generatedCount(count, centered), `count ${count}`)
  const copies = kept.map((instance) => {
    const i = instance.index as number
    return {
      key: instance.key,
      trsf: makeTranslationTrsf(oc, scope, step[0] * i, step[1] * i, step[2] * i),
    }
  })
  return { copies, warnings, extra }
}

/** The `linear_pattern` leaf entry. */
export function solveLinearPattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  featuresById: Record<string, Dict> = {},
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> } = {
    variables: {}, laterVariables: {},
  },
): PatternResult | PartPatternResult {
  const sub = (feature.linear_pattern as Dict) ?? {}
  return solvePatternInstances(
    oc, scope, table, feature, sub, globalRepo, partStore, featuresById, solveContext,
    () => buildLinearCopies(oc, scope, sub, globalRepo, partStore, table),
  )
}
