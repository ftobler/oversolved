// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
//
// Dimensioning against B-rep geometry. A dimension constraint can only name
// sketch elements, so a body edge / vertex the user picks with the dimension
// tool is first materialised as a projected entity in the active sketch (the
// same `add_projected_entity` the project tool emits); the pick then targets
// that projection. Picking the same body element twice reuses the projection
// already in the sketch instead of stacking duplicates.
import type { DimensionPick } from '@/registry'
import type { Mutation, Sketch } from '@/types/cad'
import { getEntityKind } from '@/types/cad'
import { parseSelectionId } from '@/utils/query/selectionId'

/** Base curve entity kinds a projected body edge can lower to; anything else is
 *  a line. A vertex projects as 'point', which is not a curve and is handled by
 *  its own branch, so it is deliberately absent here. Shared with
 *  projectionMutations so the two lists cannot drift. */
export const PROJECTABLE_CURVE_KINDS: ReadonlySet<string> = new Set(['circle', 'arc', 'ellipse', 'spline'])

/**
 * The entity kind to declare for a projected body edge. The edge's curve kind
 * (when the body reported one) picks the base kind; an unknown kind is a line.
 * A tilted circle still declares 'circle' here -- the projection lowerer
 * promotes it to an ellipse once it sees the sketch plane orientation, and
 * `refreshProjectedPickKinds` picks that up on the next solve.
 */
export function projectedKindForEdge(sourceKind: string | null | undefined): string {
  return sourceKind && PROJECTABLE_CURVE_KINDS.has(sourceKind) ? sourceKind : 'line'
}

interface ProjectionConstraintLike {
  kind?: string
  target?: unknown
  source?: unknown
}

/** Collect projection constraints from a variety of inputs. */
function projectionConstraintsOf(input: unknown): ProjectionConstraintLike[] {
  if (Array.isArray(input)) {
    // Could be an array of constraints or a sketch entry list; treat as
    // constraints only if entries look like constraints.
    if (input.length > 0 && input[0] && typeof input[0] === 'object' && 'kind' in (input[0] as object)) {
      return input as ProjectionConstraintLike[]
    }
    return []
  }
  if (input && typeof input === 'object') {
    const obj = input as { [key: string]: unknown }
    if (Array.isArray(obj.constraints)) return obj.constraints as ProjectionConstraintLike[]
    // Legacy sketch map: synthesise constraints from projected/source entities.
    const out: ProjectionConstraintLike[] = []
    for (const [id, entity] of Object.entries(obj)) {
      const e = entity as { projected?: boolean; source?: string } | null
      if (e && e.projected === true && typeof e.source === 'string') {
        out.push({ kind: 'projection', target: `$${id}`, source: e.source })
      }
    }
    return out
  }
  return []
}

/** Entity id of an existing projection of `source`, else null. */
export function findProjectionOf(input: unknown, source: string): string | null {
  if (input === null || input === undefined) return null
  const constraints = projectionConstraintsOf(input)
  for (const c of constraints) {
    if (c.kind === 'projection' && c.source === source && typeof c.target === 'string') {
      return String(c.target).replace(/^\$/, '')
    }
  }
  // Legacy sketch map fallback (already handled by synthesised constraints
  // above, but keep a direct scan for safety).
  if (!Array.isArray(input) && input && typeof input === 'object' && !Array.isArray((input as { [key: string]: unknown }).constraints)) {
    const obj = input as { [key: string]: unknown }
    for (const [id, entity] of Object.entries(obj)) {
      const e = entity as { projected?: boolean; source?: string } | null
      if (e && e.projected === true && e.source === source) return id
    }
  }
  return null
}

export interface BrepDimensionPlan {
  // Empty when an existing projection of the same source is reused.
  mutations: Mutation[]
  pick: DimensionPick
}

export interface BrepDimensionPlanInput {
  // The B-rep ancestry query under the cursor (an edge or a vertex).
  query: string
  featureId: string
  // The active sketch as last solved, used to find an existing projection.
  sketch: Sketch | null
  /** Picks already made in this dimension gesture. A projection created by an
   *  earlier pick is not in `sketch` until its solve lands, so it is matched
   *  here instead -- otherwise clicking one body edge twice (the same-entity
   *  path to a length dim) would project it twice and read as two lines. */
  picks?: readonly DimensionPick[]
  // True when the query came from the B-rep vertex layer.
  isVertexPick: boolean
  // Curve kind of the picked edge, when the body reported one.
  sourceKind?: string | null
  newEntityId: () => string
}

/** An entity already projected from `query`, from either lookup, else null. */
function findExistingProjection(
  query: string,
  sketch: Sketch | null,
  picks: readonly DimensionPick[],
): { entityId: string; kind: string } | null {
  const solvedId = findProjectionOf(sketch, query)
  // The solved sketch wins: the lowerer may have promoted the kind the pick
  // was made with (a tilted circle projects as an ellipse).
  if (solvedId !== null) return { entityId: solvedId, kind: getEntityKind(sketch![solvedId]) }

  const pending = picks.find(p => p.source === query)
  if (!pending) return null
  const sel = parseSelectionId(pending.target)
  if (sel.kind !== 'entity' && sel.kind !== 'vertex') return null
  return { entityId: sel.eid, kind: pending.isVertex ? 'point' : pending.entityKind ?? 'line' }
}

/**
 * Turn a B-rep pick into the projection to create (if any) plus the dimension
 * pick that targets it. The projected point of a vertex pick is dimensioned
 * through its `xy` vertex, so it pairs with sketch vertices for a distance dim.
 */
export function planBrepDimensionPick(input: BrepDimensionPlanInput): BrepDimensionPlan {
  const { query, featureId, sketch, picks = [], isVertexPick, sourceKind, newEntityId } = input

  const existing = findExistingProjection(query, sketch, picks)
  const kind = existing?.kind
    ?? (isVertexPick ? 'point' : projectedKindForEdge(sourceKind))
  const entityId = existing?.entityId ?? newEntityId()

  const mutations: Mutation[] = existing
    ? []
    : [{ type: 'add_projected_entity', featureId, kind, source: query, entityId }]

  const pick: DimensionPick = kind === 'point'
    ? { isVertex: true, target: `vertex:${featureId}:${entityId}:xy`, entityKind: null, source: query }
    : { isVertex: false, target: `entity:${featureId}:${entityId}`, entityKind: kind, source: query }

  return { mutations, pick }
}

/** Bare entity id of an `entity:<featureId>:<eid>` target of this feature. */
function ownEntityId(target: string, featureId: string): string | null {
  try {
    const sel = parseSelectionId(target)
    return sel.kind === 'entity' && sel.featureId === featureId ? sel.eid : null
  } catch {
    return null
  }
}

/**
 * Re-read the entity kind of picks that target projected entities. A projection
 * is declared with the source curve's kind, but the lowerer may resolve it to
 * another kind (a tilted circle projects as an ellipse). The pick is taken
 * before that solve lands, so its kind can be stale by the time the dimension
 * is resolved. Non-projected picks are left untouched: their kind comes from
 * the hover, which is already authoritative.
 */
export function refreshProjectedPickKinds(
  picks: readonly DimensionPick[],
  sketchOrConstraints: unknown,
  featureId: string,
  constraintsArg?: unknown,
): readonly DimensionPick[] {
  // Resolve the held entity id set.
  const held = new Set<string>()
  const constraints = constraintsArg !== undefined
    ? projectionConstraintsOf(constraintsArg)
    : projectionConstraintsOf(sketchOrConstraints)
  for (const c of constraints) {
    if (c.kind === 'projection' && typeof c.target === 'string') held.add(String(c.target).replace(/^\$/, ''))
  }
  // Legacy fallback: if no constraints provided, treat projected entities as held.
  if (constraints.length === 0 && sketchOrConstraints && typeof sketchOrConstraints === 'object' && !Array.isArray(sketchOrConstraints)) {
    const obj = sketchOrConstraints as { [key: string]: unknown }
    if (!Array.isArray(obj.constraints)) {
      for (const [id, entity] of Object.entries(obj)) {
        const e = entity as { projected?: boolean } | null
        if (e && e.projected === true) held.add(id)
      }
    }
  }

  if (held.size === 0 && !(sketchOrConstraints && typeof sketchOrConstraints === 'object')) return picks

  const sketchMap = (sketchOrConstraints && typeof sketchOrConstraints === 'object' && !Array.isArray(sketchOrConstraints) && !Array.isArray((sketchOrConstraints as { [key: string]: unknown }).constraints))
    ? (sketchOrConstraints as { [key: string]: unknown })
    : null

  return picks.map(pick => {
    if (pick.isVertex) return pick
    const id = ownEntityId(pick.target, featureId)
    if (id === null || !held.has(id)) return pick
    const entity = sketchMap ? (sketchMap[id] as { kind?: string } | undefined) : undefined
    const kind = entity ? getEntityKind(entity as never) : undefined
    if (!kind) return pick
    return kind === pick.entityKind ? pick : { ...pick, entityKind: kind }
  })
}
