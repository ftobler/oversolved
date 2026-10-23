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
//
// `brep_new` only ever names the LAST modifier, and canonical indices die with
// the shape they index, so on their own they cannot carry an attribution past
// the next modifier: every earlier modifier's element silently reverted to the
// body's creator. Face and edge identity is a construction UUID, which does
// survive the reshaping (it rides the name transfer), so the attribution is
// recorded against it too (`Body.face_owner` / `edge_owner`). A vertex has no
// stored UUID (it is derived from its adjacent faces at tessellation time), so
// vertices keep the last-modifier rule.

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
function newElementIndices(
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
 * Bring every body's `brep_new` up to date with its `brep_diff`, and record who
 * owns each face/edge identity. Run after each feature solve, while the diff's
 * sub-shapes are alive. A body whose shape changed with no diff (a restore copy
 * is not such a change: the snapshot moves the indices onto the copy) loses its
 * indices, as it would have lost the diff's identity matches.
 *
 * The owner stamp is the one step that survives a later modifier: `brep_new` is
 * recomputed per feature and only names that feature's elements, so an element
 * it no longer lists is attributed from its recorded UUID owner instead of
 * dropping back to the body's creator.
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
      recordElementOwners(body)
    }
  } finally {
    scope.dispose()
  }
}

/**
 * Record `body`'s last modifier as the owner of the UUIDs `brep_new` names, and
 * drop the owners of identities the current shape no longer carries.
 *
 * The stamp is additive: an earlier modifier's UUID is not in the new
 * `brep_new`, so it keeps the owner it was given when it was created. Stale
 * entries are pruned by liveness, not by age, so the maps stay one entry per
 * element the body actually has (a UUID that comes back later names the same
 * element by construction, so a pruned re-stamp is not a loss).
 */
function recordElementOwners(body: Body): void {
  const modifier = body.modified_by.at(-1)
  if (!modifier || !body.brep_new) return
  body.face_owner = nextOwners(body.face_owner, body.face_uuids, body.brep_new.faces, modifier)
  body.edge_owner = nextOwners(body.edge_owner, body.edge_uuids, body.brep_new.edges, modifier)
}

/** The owner map with the `newIndices` UUIDs stamped with `modifier`, keeping the
 *  recorded owner of every UUID the current `uuids` array still carries. */
function nextOwners(
  previous: Record<string, string> | undefined,
  uuids: readonly (string | null)[] | undefined,
  newIndices: readonly number[],
  modifier: string,
): Record<string, string> {
  const live = new Set<string>()
  for (const uuid of uuids ?? []) if (uuid) live.add(uuid)
  const next: Record<string, string> = {}
  for (const [uuid, owner] of Object.entries(previous ?? {})) {
    if (live.has(uuid)) next[uuid] = owner
  }
  for (const idx of newIndices) {
    const uuid = uuids?.[idx]
    if (uuid) next[uuid] = modifier
  }
  return next
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

/**
 * The feature a NAMED face or edge is attributed to: the feature that minted its
 * construction UUID when that is recorded, else the last-modifier rule. A UUID
 * without a stamp (the body's first modifier, where everything it did not make
 * already belongs to the creator) falls through to `elementCreator`, which is
 * also the whole rule for an unnamed element.
 */
export function namedElementCreator(
  uuid: string | null,
  owner: Record<string, string> | null | undefined,
  isNew: boolean,
  createdBy: string,
  modifiedBy: readonly string[] | undefined,
): string {
  const recorded = uuid ? owner?.[uuid] : undefined
  return recorded ?? elementCreator(isNew, createdBy, modifiedBy)
}
