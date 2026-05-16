/**
 * Test-only fixture helper for building PartDoc objects with human-readable IDs.
 *
 * Production code uses random base-64url tokens (e.g. `gJk7xQ_o2P`) as
 * feature and entity IDs.  Hand-written tests are unreadable with those names.
 * This module lets test authors supply their own names (`sketch1`, `line1`,
 * `c1`) which are used verbatim as IDs -- the document never knows the
 * difference.
 *
 * No production module imports this file.  The helper performs no runtime
 * substitution or registry: the names ARE the IDs.
 */

import type { PartDoc, PartFeature, PartEntityDef, PartConstraint } from '@/types/cad'

export interface SketchOptions {
  plane?: string
  entities?: PartEntityDef[]
  constraints?: PartConstraint[]
  initial?: Record<string, number[]>
  label?: string
}

/** Return a sketch PartFeature with the given parseable ID and options. */
export function makeSketch(sketchId: string, options: SketchOptions = {}): PartFeature {
  const {
    plane = '@builtin_plane_front',
    entities = [],
    constraints = [],
    initial,
    label,
  } = options

  const feature: PartFeature = {
    id: sketchId,
    kind: 'sketch',
    plane,
    entities,
    constraints,
  }
  if (initial !== undefined) {
    feature.initial = initial
  }
  if (label !== undefined) {
    feature.label = label
  }
  return feature
}

/** Return a minimal PartDoc containing the supplied features. */
export function makeDoc(...features: PartFeature[]): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features,
  }
}
