// Which feature a face, edge or vertex of a modified body is attributed to.
//
// A modifier (cut, fillet, hole, boolean, ...) records the sub-shapes it
// created in the body's `brep_diff`. Those are attributed to the modifier, the
// rest to the body's creator. Membership is by sub-shape identity (IsSame): the
// producers hand the diff over in the space of the body's own shape, so no
// geometry is compared. The diff's sub-shapes die with the build, so right
// after each feature solve the builder has them turned into canonical indices
// (`Body.brep_new`), which a checkpoint restore carries along with the shape
// copy. Every consumer reads the indices, so a full build and an incremental
// one attribute alike.

import { DisposeScope } from './disposeScope'
import type { HandleTable, OccHandle } from './handleTable'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import type { Body, BrepDiff, NewElements } from '../types3d'
import { canonicalEdges, canonicalFaces, canonicalVertices } from './bodyNames'
import { SubShapeDedup } from './subshapeIdentity'

/** The sub-shapes `diff` records as created, as identity sets. */
function newSubShapes(oc: OccModule, scope: DisposeScope, diff: BrepDiff): {
  faces: SubShapeDedup
  edges: SubShapeDedup
  vertices: SubShapeDedup
} {
  const set = (items: unknown[] | undefined): SubShapeDedup => {
    const s = new SubShapeDedup()
    for (const item of items ?? []) s.add(item as OccSubShape)
    return s
  }
  // Vertices only new edges reach: an endpoint an inherited edge also has is
  // an old corner the modifier merely touched.
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

/** The canonical indices of `shape`'s elements that `diff` records as created. */
export function newElementIndices(
  oc: OccModule,
  scope: DisposeScope,
  handle: OccHandle,
  shape: OccShape,
  diff: BrepDiff,
): NewElements {
  const created = newSubShapes(oc, scope, diff)
  const indicesIn = (subs: OccSubShape[], set: SubShapeDedup): number[] =>
    subs.flatMap((s, i) => (set.has(s) ? [i] : []))
  return {
    shape: handle,
    faces: indicesIn(canonicalFaces(oc, scope, shape), created.faces),
    edges: indicesIn(canonicalEdges(oc, scope, shape), created.edges),
    vertices: indicesIn(canonicalVertices(oc, scope, shape), created.vertices),
  }
}

// The diff each body's indices were last computed from, with the shape they
// index: a body nobody touched keeps its diff object, so it is not re-walked
// after every feature.
const indexedFrom = new WeakMap<BrepDiff, OccHandle>()

/**
 * Bring every body's `brep_new` up to date with its `brep_diff`. Run after each
 * feature solve, while the diff's sub-shapes are alive. A body whose shape
 * changed with no diff (a restore copy is not such a change: the snapshot moves
 * the indices onto the copy) loses its indices, as it would have lost the
 * diff's identity matches.
 */
export function indexModifierDiffs(oc: OccModule, table: HandleTable, bodyStore: Record<string, Body>): void {
  const scope = new DisposeScope()
  try {
    for (const body of Object.values(bodyStore)) {
      if (body.shape == null) {
        body.brep_new = null
      } else if (body.brep_diff) {
        if (body.brep_new?.shape === body.shape && indexedFrom.get(body.brep_diff) === body.shape) continue
        body.brep_new = newElementIndices(oc, scope, body.shape, table.get<OccShape>(body.shape), body.brep_diff)
        indexedFrom.set(body.brep_diff, body.shape)
      } else if (body.brep_new && body.brep_new.shape !== body.shape) {
        body.brep_new = null
      }
    }
  } finally {
    scope.dispose()
  }
}

/** Canonical indices of the elements a modifier created, as sets. */
export interface NewIndexSets {
  faces: ReadonlySet<number>
  edges: ReadonlySet<number>
  vertices: ReadonlySet<number>
}

/** The index sets of `newElements` when they belong to `shape`, else null. */
export function newIndexSets(newElements: NewElements | null | undefined, shape: OccHandle | null): NewIndexSets | null {
  if (!newElements || shape == null || newElements.shape !== shape) return null
  return { faces: new Set(newElements.faces), edges: new Set(newElements.edges), vertices: new Set(newElements.vertices) }
}

/** The feature an element is attributed to: the last modifier when the element is new, else the creator. */
export function elementCreator(isNew: boolean, createdBy: string, modifiedBy: readonly string[] | undefined): string {
  return isNew && modifiedBy && modifiedBy.length > 0 ? modifiedBy[modifiedBy.length - 1] : createdBy
}
