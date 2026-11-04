// Test-only adapters for the suites that were written against the removed
// array / circular_array leaves. The unified pattern leaf owns the same body
// arithmetic, selected by `subject: 'body'` and `mode`; these wrappers keep the
// old call shape so a case can stay focused on the geometry it pins.
import type { DisposeScope } from '../../occ/disposeScope'
import type { OccModule } from '../../occ/occTypes'
import type { HandleTable } from '../../occ/handleTable'
import type { Body } from '../../types3d'
import type { Repository } from '../../query'
import { solvePattern } from '../pattern'

type Dict = Record<string, unknown>

function linearize(sub: Dict): Dict {
  if ((sub.mode ?? 'linear') !== 'linear') return sub
  return {
    ...sub,
    mode: 'linear',
    count: sub.count ?? sub.count_x,
    pitch: sub.pitch ?? sub.pitch_x,
    direction: sub.direction ?? sub.direction_x,
    direction_query: sub.direction_query ?? sub.direction_x_query,
    invert: sub.invert ?? sub.invert_x,
  }
}

export function solveArray(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  repo: Repository,
  store: Record<string, Body>,
) {
  return solvePattern(oc, scope, table, {
    ...feature,
    pattern: { subject: 'body', ...linearize(feature.array as Dict) },
  }, repo, store)
}

export function solveCircularArray(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  repo: Repository,
  store: Record<string, Body>,
) {
  return solvePattern(oc, scope, table, {
    ...feature,
    pattern: { subject: 'body', mode: 'circular', ...(feature.circular_array as Dict) },
  }, repo, store)
}
