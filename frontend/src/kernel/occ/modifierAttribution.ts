// Which feature a face, edge or vertex of a modified body is attributed to.
//
// A modifier (cut, fillet, hole, boolean, ...) records the sub-shapes it
// created in the body's `brep_diff`. Those are attributed to the modifier, the
// rest to the body's creator. Membership is by sub-shape identity (IsSame): the
// producers hand the diff over in the space of the body's own shape, so no
// geometry is compared. After a checkpoint restore the diff is null and
// everything is attributed to the creator.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import type { BrepDiff } from '../types3d'
import { canonicalVertices } from './bodyNames'
import { SubShapeDedup } from './subshapeIdentity'

/** The sub-shapes a modifier created, as identity sets. */
export interface NewSubShapes {
  faces: SubShapeDedup
  edges: SubShapeDedup
  // Vertices only new edges reach: an endpoint an inherited edge also has is
  // an old corner the modifier merely touched.
  vertices: SubShapeDedup
}

/** The new sub-shapes `diff` records, or null when there is no diff. */
export function newSubShapes(oc: OccModule, scope: DisposeScope, diff: BrepDiff | null | undefined): NewSubShapes | null {
  if (!diff) return null
  const set = (items: unknown[] | undefined): SubShapeDedup => {
    const s = new SubShapeDedup()
    for (const item of items ?? []) s.add(item as OccSubShape)
    return s
  }
  const inheritedVertices = new SubShapeDedup()
  for (const edge of diff.inherited_edges ?? []) {
    for (const v of canonicalVertices(oc, scope, edge as OccShape)) inheritedVertices.add(v)
  }
  const vertices = new SubShapeDedup()
  for (const edge of diff.new_edges ?? []) {
    for (const v of canonicalVertices(oc, scope, edge as OccShape)) {
      if (!inheritedVertices.has(v)) vertices.add(v)
    }
  }
  return { faces: set(diff.new_faces), edges: set(diff.new_edges), vertices }
}

/** The feature an element is attributed to: the last modifier when the element is new, else the creator. */
export function elementCreator(isNew: boolean, createdBy: string, modifiedBy: readonly string[] | undefined): string {
  return isNew && modifiedBy && modifiedBy.length > 0 ? modifiedBy[modifiedBy.length - 1] : createdBy
}
