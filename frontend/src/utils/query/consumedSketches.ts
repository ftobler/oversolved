// Which sketch-class features a feature has swallowed.
//
// A solid feature (extrude, revolve, sweep, hole) consumes the sketch it is
// built from: once the body exists, the profile wires floating inside it are
// clutter, so a consumed sketch is not drawn. A helix picked as a sweep path is
// reference geometry the same way, so it is consumed by the same rule. The
// answer is needed twice and must not be computed two different ways -- the
// document rule that hides every consumed feature and the editor that keeps its
// own profiles on screen while it is open (utils/featureVisibility) both ask
// here.

import type { PartFeature } from '@/types/cad'
import { featureRefId } from '@/utils/query'
import { selectionSourceFeatureIds } from '@/utils/query/pickOrder'
import { isSketchClassFeature } from '@/utils/sketchClass'

function refList(ref: string | string[] | undefined): string[] {
  if (Array.isArray(ref)) return ref.filter(r => r)
  return ref ? [ref] : []
}

// The sketches one stored pick query picks from. `byId` and `known` are built
// once by the caller so a multi-ref feature, or a whole feature list, does not
// rebuild the feature set per stored ref (g2-L5).
function sketchIdsInQuery(
  query: string,
  byId: ReadonlyMap<string, PartFeature>,
  known: ReadonlySet<string>,
): string[] {
  if (!query) return []
  // A bare feature-level ref (`@<sketchId>` canonical, `$<sketchId>` legacy)
  // names the sketch itself. selectionSourceFeatureIds only reads the `@`
  // spelling, so routing through the one grammar seam here keeps a legacy `$`
  // doc's consumed sketch hidden instead of silently leaving it on screen.
  // A bare `@<helixId>` names the reference curve the same way.
  const featureId = featureRefId(query)
  if (featureId !== null) {
    return isSketchClassFeature(byId.get(featureId)) ? [featureId] : []
  }
  const sources = selectionSourceFeatureIds(query, known)
  // A body face or edge names the sketch edges that swept it in its ancestry
  // (`@ex1@body_ex1@sk1/left`), so it mentions the sketch without being sketch
  // geometry. Picking it consumes the body, not the sketch: only a query whose
  // every source is sketch-class picks from sketch-class geometry.
  if (!sources.every(id => isSketchClassFeature(byId.get(id)))) return []
  return sources
}

/**
 * Every sketch-class feature `feature` consumes as profile or path geometry. A
 * feature that merely references a body face (an extrude off a flat face, say)
 * consumes no sketch and yields nothing.
 */
export function consumedSketchIds(feature: PartFeature, features: PartFeature[]): string[] {
  const byId = new Map(features.map(f => [f.id, f] as const))
  const out = new Set<string>()
  collectConsumed(feature, byId, new Set(byId.keys()), out)
  return [...out]
}

/**
 * Every sketch-class feature that ANY feature in the list consumes. The
 * rollback bar is deliberately not consulted: a consumer the bar hides for the
 * moment still owns the sketch.
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
  // The payload reads stay tolerant of a missing def: feature records reach the
  // UI straight out of stored YAML, and until the document loader validates
  // them at the boundary a hand-edited kind without its payload must degrade to
  // "consumes nothing" rather than take the visibility scan down.
  let queries: string[] = []
  switch (feature.kind) {
    case 'extrude':
      queries = refList(feature.extrude?.sketch)
      break
    case 'revolve':
      queries = refList(feature.revolve?.sketch)
      break
    case 'sweep':
      queries = [...refList(feature.sweep?.sketch), ...refList(feature.sweep?.path)]
      break
    case 'hole':
      queries = refList(feature.hole?.sketch)
      break
  }
  for (const q of queries) {
    for (const id of sketchIdsInQuery(q, byId, known)) out.add(id)
  }
}
