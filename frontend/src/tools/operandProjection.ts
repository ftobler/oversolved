// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
//
// Constraint and dimension operands against B-rep geometry. A sketch constraint
// can only name sketch elements, so a body edge / vertex (or the document
// origin) the user picks is first materialised as a projected entity in the
// active sketch (the same `add_projected_entity` the project tool emits); the
// constraint or dimension then targets that projection. Picking the same body
// element twice reuses the projection already in the sketch or planned earlier
// in the same act instead of stacking duplicates.
import type { DimensionPick } from '@/registry'
import type { Mutation, Sketch } from '@/types/cad'
import { getEntityKind } from '@/types/cad'
import { parseQuery } from '@/utils/query'
import { parseSelectionId } from '@/utils/query/selectionId'
import { isEdgeRestriction, isVertexRestriction } from '@/kernel/occ/primitives'

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

export interface ProjectionConstraintLike {
  id?: string
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
  mutations: ProjectedEntityMutation[]
  pick: DimensionPick
}

export type ProjectedEntityMutation = Extract<Mutation, { type: 'add_projected_entity' }>

/** One projection already planned earlier in the same act, or a pending
 *  dimension pick. The source is absent on a plain sketch pick, which the
 *  planner never matches. */
export interface PlannedProjection {
  source?: string
  target: string
  isVertex: boolean
  entityKind?: string | null
  // A ProjectedOperandPlan carries the plan kind here; a dimension pick carries
  // entityKind instead.
  kind?: string
}

/** A projection already recorded on the document feature: its source pick, the
 *  held entity and that entity's declared kind. */
export interface RecordedProjection {
  source?: string
  entityId: string
  kind: string | null
}

export interface ProjectedOperandPlanInput {
  query: string
  featureId: string
  // The active sketch as last solved, used to find an existing projection.
  sketch: Sketch | null
  /** The document feature's recorded projections. The solved map carries
   *  geometry only, so this is how a projection whose solve has not landed is
   *  matched, including its declared entity kind. */
  recorded?: readonly RecordedProjection[]
  /** Projections already planned in this act. A projection created by an
   *  earlier operand is not in `sketch` until its solve lands, so it is matched
   *  here instead -- otherwise two operands on one body edge would project it
   *  twice and read as two lines. */
  pending?: readonly PlannedProjection[]
  // True when the query came from the B-rep vertex layer.
  isVertexPick: boolean
  // Curve kind of the picked edge, when the body reported one.
  sourceKind?: string | null
  newEntityId: () => string
}

export interface ProjectedOperandPlan {
  // Empty when an existing projection of the same source is reused.
  mutations: ProjectedEntityMutation[]
  // The operand that was planned, so the caller can feed the plan straight back
  // in as `pending` for the next operand of the same act.
  source: string
  target: string
  // The resolved (or pick-time) projected kind. `point` targets the projection's
  // xy vertex; a curve targets the entity.
  kind: string
  isVertex: boolean
}

export interface BrepDimensionPlanInput extends ProjectedOperandPlanInput {
  // The dimension gesture names its earlier picks here; they are the same
  // shape as a planned projection.
  picks?: readonly DimensionPick[]
}

/** Classify an ancestry B-rep pick as a vertex or edge operand, else null. A
 *  face or plane names no single sketch operand and is deliberately not
 *  projectable here. Only the `?` ancestry form is a viewport B-rep pick; the
 *  topo fallback `@body/kind/index` form is not accepted, matching the project
 *  and dimension paths. */
export function classifyBrepOperand(id: string): { isVertex: boolean } | null {
  if (!id.startsWith('?')) return null
  try {
    const q = parseQuery(id)
    if (q.kind !== 'ancestry') return null
    if (isVertexRestriction(q.typeRestriction)) return { isVertex: true }
    if (isEdgeRestriction(q.typeRestriction)) return { isVertex: false }
  } catch {
    // Not a query shape this planner accepts (a malformed id must not throw a
    // click path); the caller keeps it as a plain operand.
  }
  return null
}

/** An entity already projected from `query`, from either lookup, else null. */
function findExistingProjection(
  query: string,
  sketch: Sketch | null,
  recorded: readonly RecordedProjection[] | undefined,
  pending: readonly PlannedProjection[],
  isVertexPick: boolean,
  sourceKind: string | null | undefined,
): { entityId: string; kind: string } | null {
  const recordedHit = (recorded ?? []).find(p => p.source === query)
  if (recordedHit) {
    const entity = sketch?.[recordedHit.entityId]
    // A projection can be newer than the solved geometry (the user acted again
    // before the solve landed). Prefer the kind the document entity declares;
    // only a document that cannot name it falls back to the pick-time kind.
    const kind = entity
      ? getEntityKind(entity)
      : recordedHit.kind ?? (isVertexPick ? 'point' : projectedKindForEdge(sourceKind))
    return { entityId: recordedHit.entityId, kind }
  }

  // Legacy v5 documents carry `projected: true` + `source` on the entity
  // itself; nothing writes that shape any more. It is read here only so an old
  // document still reuses its projection instead of stacking a duplicate.
  const solvedId = findProjectionOf(sketch, query)
  // The solved sketch wins: the lowerer may have promoted the kind the pick
  // was made with (a tilted circle projects as an ellipse).
  if (solvedId !== null) {
    const entity = sketch?.[solvedId]
    return entity
      ? { entityId: solvedId, kind: getEntityKind(entity) }
      : { entityId: solvedId, kind: isVertexPick ? 'point' : projectedKindForEdge(sourceKind) }
  }

  const earlier = pending.find(p => p.source === query)
  if (!earlier) return null
  const sel = parseSelectionId(earlier.target)
  if (sel.kind !== 'entity' && sel.kind !== 'vertex') return null
  return { entityId: sel.eid, kind: earlier.isVertex ? 'point' : earlier.kind ?? earlier.entityKind ?? 'line' }
}

/**
 * Turn a non-sketch operand (the document origin, a B-rep vertex/edge) into the
 * projection to create (if any) plus the target ref a constraint should name.
 * A projected point is targeted through its `xy` vertex, so it pairs with
 * sketch vertices for a distance or coincident.
 */
export function planProjectedOperand(input: ProjectedOperandPlanInput): ProjectedOperandPlan {
  const { query, featureId, sketch, recorded, pending = [], isVertexPick, sourceKind, newEntityId } = input

  const existing = findExistingProjection(query, sketch, recorded, pending, isVertexPick, sourceKind)
  const kind = existing?.kind
    ?? (isVertexPick ? 'point' : projectedKindForEdge(sourceKind))
  const entityId = existing?.entityId ?? newEntityId()

  const mutations: ProjectedEntityMutation[] = existing
    ? []
    : [{ type: 'add_projected_entity', featureId, kind, source: query, entityId }]

  const isVertex = kind === 'point'
  const target = isVertex
    ? `vertex:${featureId}:${entityId}:xy`
    : `entity:${featureId}:${entityId}`

  return { mutations, source: query, target, kind, isVertex }
}

/**
 * Turn a B-rep pick into the projection to create (if any) plus the dimension
 * pick that targets it. The dimension path wraps the shared planner's answer,
 * so the click path and the constraint command cannot disagree about reuse.
 */
export function planBrepDimensionPick(input: BrepDimensionPlanInput): BrepDimensionPlan {
  const { mutations, target, kind, isVertex } = planProjectedOperand({
    ...input,
    pending: input.picks,
  })
  const pick: DimensionPick = isVertex
    ? { isVertex: true, target, entityKind: null, source: input.query }
    : { isVertex: false, target, entityKind: kind, source: input.query }
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
