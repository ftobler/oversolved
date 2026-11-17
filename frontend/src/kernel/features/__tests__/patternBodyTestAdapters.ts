// Test-only adapters for the suites that were written against the removed
// array / circular_array leaves. The two pattern kinds own the same body
// arithmetic; these wrappers translate the old call shape through the loader's
// own split, so a case can stay focused on the geometry it pins instead of on
// the field spelling of the day.
import type { DisposeScope } from '../../occ/disposeScope'
import type { OccModule } from '../../occ/occTypes'
import type { HandleTable } from '../../occ/handleTable'
import type { PartSolid } from '../../types3d'
import type { Repository } from '../../query'
import { solveLinearPattern } from '../linearPattern'
import { solveCircularPattern } from '../circularPattern'
import { splitPatternDef } from '@/utils/core/patternSplit'

type Dict = Record<string, unknown>

/** The old fixtures authored one-axis arrays with the `_x` spelling even when
 *  they said `mode: linear`; the retired adapters folded those onto the
 *  one-axis names, so keep doing that before the split. */
function linearize(sub: Dict): Dict {
  if ((sub.mode ?? 'linear') !== 'linear') return sub
  return {
    ...sub,
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
  store: Record<string, PartSolid>,
) {
  const { def } = splitPatternDef({ subject: 'body', mode: 'linear', ...linearize((feature.array as Dict) ?? {}) })
  return solveLinearPattern(oc, scope, table, { ...feature, linear_pattern: def }, repo, store)
}

export function solveCircularArray(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  repo: Repository,
  store: Record<string, PartSolid>,
) {
  const { def } = splitPatternDef({ subject: 'body', mode: 'circular', ...(feature.circular_array as Dict) })
  return solveCircularPattern(oc, scope, table, { ...feature, circular_pattern: def }, repo, store)
}

/** A body-subject pattern feature row in the kind the retired `kind` argument
 *  names (`array` -> linear, `circular_array` -> circular), translated through
 *  the same split. */
export function patternFeature(id: string, legacyKind: string, sub: Dict): Dict {
  const legacy = {
    subject: 'body',
    mode: legacyKind === 'circular_array' ? 'circular' : 'linear',
    ...(legacyKind === 'circular_array' ? sub : linearize(sub)),
  }
  const { kind, def } = splitPatternDef(legacy)
  return { id, kind, [kind]: def }
}
