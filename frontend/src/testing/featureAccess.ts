// Test-only accessors for the feature discriminated union.
//
// Tests build documents and then read one feature's payload; the union makes
// that a narrowing step, and these helpers keep it one call with a loud failure
// instead of a `!` per field. They are deliberately not production code: the
// app narrows by `kind` at the call site where the meaning is explicit.

import type { FeatureKind, PartFeature, PartDoc, SketchFeature } from '@/types/cad'

/** The feature at `index`, required to have exactly `kind`; throws otherwise. */
export function featureAt<K extends FeatureKind>(
  doc: PartDoc,
  index: number,
  kind: K,
): Extract<PartFeature, { kind: K }> {
  const feature = doc.features?.[index]
  if (feature?.kind !== kind) {
    throw new Error(`feature ${index} is not a ${kind} (got ${feature?.kind ?? 'missing'})`)
  }
  return feature as Extract<PartFeature, { kind: K }>
}

/** The feature with `id`, required to have exactly `kind`; throws otherwise. */
export function featureById<K extends FeatureKind>(
  doc: PartDoc,
  id: string,
  kind: K,
): Extract<PartFeature, { kind: K }> {
  const feature = doc.features?.find(f => f.id === id)
  if (feature?.kind !== kind) {
    throw new Error(`feature '${id}' is not a ${kind} (got ${feature?.kind ?? 'missing'})`)
  }
  return feature as Extract<PartFeature, { kind: K }>
}

/** Shorthand for the sketch feature most mutation tests build first. */
export function sketchAt(doc: PartDoc, index = 0): SketchFeature {
  return featureAt(doc, index, 'sketch')
}
