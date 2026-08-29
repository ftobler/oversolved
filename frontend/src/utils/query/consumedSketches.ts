// Which sketches a feature has swallowed.
//
// A solid feature (extrude, revolve, sweep, hole) consumes the sketch it is
// built from: once the body exists, the profile wires floating inside it are
// clutter, so picking a profile hides the sketch that owns it. The same answer
// is needed twice and must not be computed two different ways -- the mutation
// that hides the sketch (yamlMutations/featureDefs) and the editor that forces
// it back on screen while its consumer is open (pages/Part) both ask here.

import type { PartFeature } from '@/types/cad'
import { selectionSourceFeatureIds } from '@/utils/query/pickOrder'

function refList(ref: string | string[] | undefined): string[] {
  if (Array.isArray(ref)) return ref.filter(r => r)
  return ref ? [ref] : []
}

/** The sketch features one stored pick query derives from. */
export function sketchIdsInQuery(query: string, features: PartFeature[]): string[] {
  if (!query) return []
  const known = new Set(features.map(f => f.id))
  return selectionSourceFeatureIds(query, known)
    .filter(id => features.find(f => f.id === id)?.kind === 'sketch')
}

/**
 * Every sketch `feature` consumes as profile or path geometry. A feature that
 * merely references a body face (an extrude off a flat face, say) consumes no
 * sketch and yields nothing.
 */
export function consumedSketchIds(feature: PartFeature, features: PartFeature[]): string[] {
  const queries = [
    ...refList(feature.extrude?.sketch),
    ...refList(feature.revolve?.sketch),
    ...refList(feature.sweep?.sketch),
    ...refList(feature.sweep?.path),
    ...refList(feature.hole?.sketch),
  ]
  const out = new Set<string>()
  for (const q of queries) {
    for (const id of sketchIdsInQuery(q, features)) out.add(id)
  }
  return [...out]
}
