// Which sketches a feature has swallowed.
//
// A solid feature (extrude, revolve, sweep, hole) consumes the sketch it is
// built from: once the body exists, the profile wires floating inside it are
// clutter, so picking a profile hides the sketch that owns it. The same answer
// is needed twice and must not be computed two different ways -- the mutation
// that hides the sketch (yamlMutations/featureDefs), the visibility rule that
// hides a consumed sketch no pick ever hid (utils/featureVisibility) and the
// editor that forces it back on screen while its consumer is open all ask here.

import type { PartFeature } from '@/types/cad'
import { selectionSourceFeatureIds } from '@/utils/query/pickOrder'

function refList(ref: string | string[] | undefined): string[] {
  if (Array.isArray(ref)) return ref.filter(r => r)
  return ref ? [ref] : []
}

/** The sketch features one stored pick query derives from. */
export function sketchIdsInQuery(query: string, features: PartFeature[]): string[] {
  if (!query) return []
  const byId = new Map(features.map(f => [f.id, f] as const))
  return sketchIdsInQueryWith(query, byId, new Set(byId.keys()))
}

// The per-query variant: `known` and `byId` are built once by the caller so a
// multi-ref feature (consumedSketchIds) does not rebuild the feature set per
// stored ref (g2-L5).
function sketchIdsInQueryWith(
  query: string,
  byId: ReadonlyMap<string, PartFeature>,
  known: ReadonlySet<string>,
): string[] {
  if (!query) return []
  return selectionSourceFeatureIds(query, known)
    .filter(id => byId.get(id)?.kind === 'sketch')
}

/**
 * Every sketch `feature` consumes as profile or path geometry. A feature that
 * merely references a body face (an extrude off a flat face, say) consumes no
 * sketch and yields nothing.
 */
export function consumedSketchIds(feature: PartFeature, features: PartFeature[]): string[] {
  const byId = new Map(features.map(f => [f.id, f] as const))
  const out = new Set<string>()
  collectConsumed(feature, byId, new Set(byId.keys()), out)
  return [...out]
}

/**
 * Every sketch that ANY feature in the list consumes. The rollback bar is
 * deliberately not consulted: a feature added while the bar is parked lands
 * past it, and a consumer the bar hides for the moment still owns the sketch.
 */
export function allConsumedSketchIds(features: PartFeature[]): Set<string> {
  const byId = new Map(features.map(f => [f.id, f] as const))
  const known = new Set(byId.keys())
  const out = new Set<string>()
  for (const f of features) collectConsumed(f, byId, known, out)
  return out
}

function collectConsumed(
  feature: PartFeature,
  byId: ReadonlyMap<string, PartFeature>,
  known: ReadonlySet<string>,
  out: Set<string>,
): void {
  const queries = [
    ...refList(feature.extrude?.sketch),
    ...refList(feature.revolve?.sketch),
    ...refList(feature.sweep?.sketch),
    ...refList(feature.sweep?.path),
    ...refList(feature.hole?.sketch),
  ]
  for (const q of queries) {
    for (const id of sketchIdsInQueryWith(q, byId, known)) out.add(id)
  }
}
