// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Mutation } from '@/types/cad'
import type { VertexOrEdgeDrag } from '@/types/drag'
import type { SnapTarget, SnapCandidate, EntityCandidate } from '@/utils/geometry/snapDetection'
import type { CircleDragMode } from '@/kernel/features/circleDragMode'
import { findSnapTarget, collectEntityCandidatesFlat } from '@/utils/geometry/snapDetection'
import { isPureClick, CLICK_THRESHOLD_PX } from '@/utils/pointerAbstraction'
import { PART_SNAP_FEAT_PREFIX } from '@/utils/geometry/partSnapProjection'
import { VERTEX_POINT_KEY_SUFFIXES } from '@/types/vertexKeys'

// Drag snap radii in screen pixels. The vertex pull zone is deliberately larger
// than the entity body's: dragging near an endpoint must always catch the
// vertex, never the curve under it. Both are plain pixel sizes, computed here
// because the snap math is the only consumer.
export const DRAG_SNAP_VERTEX_RADIUS_PX = 20
export const DRAG_SNAP_ENTITY_RADIUS_PX = 8

export interface DragMoveResult {
  snapTarget: SnapTarget | null
  // Effective position for this frame (snap > raw cursor).
  effectivePosition: [number, number]
}

/** The snap candidates one drag must ignore. A vertex drag's bonded cluster
 *  moves with the dragged vertex. An entity that owns one of those points passes
 *  through the dragged point by construction (its partner coincides with it), so
 *  a snap onto that body pulls the point back onto a line it already lies on and
 *  only authors a rank-redundant point-on-line row (the twist-state bug). The
 *  same holds for an entity a constraint already pins the dragged point to. */
export interface DragSnapSkips {
  // Composite vertex ids that move with the dragged vertex (exact match).
  vertexIds: Set<string>
  // `featureId:entityId` values for the entity candidates.
  entityIds: Set<string>
}

/** The constraint fields the skip scan reads: the pair refs and the midpoint's
 *  semantic line/point pair. */
type SnapConstraintRow = {
  kind?: string
  a?: unknown
  b?: unknown
  line?: unknown
  point?: unknown
}

const COINCIDENT_VERTEX_KEYS = VERTEX_POINT_KEY_SUFFIXES

const compositeVertexId = (featureId: string, entityId: string, vertexKey: string) =>
  `vertex:${featureId}:${entityId}:${vertexKey}`

/** Parse a local vertex ref like "$<entityId>start" into its parts.
 *  Returns null for non-local refs (e.g. "@builtin_origin"). */
function parseLocalVertexRef(ref: unknown): { entityId: string; vertexKey: string } | null {
  if (typeof ref !== 'string' || !ref.startsWith('$')) return null
  const bare = ref.slice(1)
  for (const key of COINCIDENT_VERTEX_KEYS) {
    if (bare.endsWith(key)) {
      const entityId = bare.slice(0, bare.length - key.length)
      if (entityId.length > 0) return { entityId, vertexKey: key }
    }
  }
  return null
}

/** Composite vertex ids that are coincident-bonded (transitively) to the given
 *  vertex, including the vertex itself. These move together with the dragged
 *  vertex, so they must be excluded from drag-time snap targets -- otherwise the
 *  snap indicator locks onto a partner sitting on top of the dragged vertex. */
export function collectCoincidentVertexIds(
  constraints: ReadonlyArray<{ kind?: string; a?: unknown; b?: unknown }>,
  featureId: string,
  entityId: string,
  vertexKey: string,
): Set<string> {
  const result = new Set<string>([compositeVertexId(featureId, entityId, vertexKey)])
  // \u0000 is a collision-proof separator (never appears in ids). Keep it as an
  // escape sequence: a literal NUL byte makes git treat the file as binary.
  const visited = new Set<string>([`${entityId}\u0000${vertexKey}`])
  const queue: Array<{ entityId: string; vertexKey: string }> = [{ entityId, vertexKey }]
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]
    const vref = `$${v.entityId}${v.vertexKey}`
    for (const c of constraints) {
      if (c.kind !== 'coincident') continue
      const a = typeof c.a === 'string' ? c.a : null
      const b = typeof c.b === 'string' ? c.b : null
      const partnerRef = a === vref ? b : b === vref ? a : null
      const partner = parseLocalVertexRef(partnerRef)
      if (!partner) continue
      const visitKey = `${partner.entityId}\u0000${partner.vertexKey}`
      if (visited.has(visitKey)) continue
      visited.add(visitKey)
      result.add(compositeVertexId(featureId, partner.entityId, partner.vertexKey))
      queue.push(partner)
    }
  }
  return result
}

/** A constraint ref as the local entity and optional vertex key it names. The
 *  stored form is `$eid` or `$eid<key>`; the qualified spellings are tolerated
 *  for a live pick. A ref to another sketch or to a builtin names no local
 *  entity and yields null. */
function localEntityRef(
  ref: unknown,
  featureId: string,
): { entityId: string; vertexKey?: string } | null {
  if (typeof ref !== 'string') return null
  if (ref.startsWith('$')) {
    const vertex = parseLocalVertexRef(ref)
    if (vertex) return vertex
    return ref.length > 1 ? { entityId: ref.slice(1) } : null
  }
  const parts = ref.split(':')
  if (parts[1] !== featureId) return null
  if (parts[0] === 'vertex' && parts[2] !== undefined && parts[3] !== undefined) {
    return { entityId: parts[2], vertexKey: parts[3] }
  }
  if (parts[0] === 'entity' && parts[2] !== undefined) return { entityId: parts[2] }
  return null
}

/** What a vertex drag must exclude from snapping. The dragged entity is always
 *  out; so is every entity owning a vertex bonded to the dragged one, because
 *  that line passes through the dragged point and the snap would author a row
 *  already implied by the bond. */
export function dragSnapSkips(
  constraints: ReadonlyArray<SnapConstraintRow> | undefined,
  featureId: string,
  drag: VertexOrEdgeDrag,
): DragSnapSkips {
  const vertexIds = new Set<string>()
  const entityIds = new Set<string>()
  // Edge drags never snap, so they have nothing to exclude.
  if (drag.type !== 'vertex') return { vertexIds, entityIds }
  entityIds.add(`${featureId}:${drag.entityId}`)
  const bonded = collectCoincidentVertexIds(constraints ?? [], featureId, drag.entityId, drag.vertexKey)
  for (const id of bonded) {
    vertexIds.add(id)
    // The composite id is `vertex:<featureId>:<entityId>:<key>`; entity ids are
    // colon-free, so the slice recovers the owner.
    const parts = id.split(':')
    const entityId = parts.slice(2, -1).join(':')
    if (entityId.length > 0) entityIds.add(`${featureId}:${entityId}`)
  }
  // A row that pins one point onto a whole entity means the dragged point is
  // already on that body, so snapping there adds nothing. `coincident` and
  // `colinear` (point + line) lower to the same point-on-line row; a midpoint's
  // line/point form pins the line's midpoint to the point, so the point is on
  // that line too. A line-on-line colinear names no point and is ignored.
  const holdLineOf = (pointRef: unknown, lineRef: unknown) => {
    const point = localEntityRef(pointRef, featureId)
    const line = localEntityRef(lineRef, featureId)
    if (point?.vertexKey === undefined || line === null || line.vertexKey !== undefined) return
    if (!bonded.has(compositeVertexId(featureId, point.entityId, point.vertexKey))) return
    entityIds.add(`${featureId}:${line.entityId}`)
  }
  for (const c of constraints ?? []) {
    if (c.kind === 'coincident' || c.kind === 'colinear') {
      holdLineOf(c.a, c.b)
      holdLineOf(c.b, c.a)
    } else if (c.kind === 'midpoint') {
      holdLineOf(c.point, c.line)
    }
  }
  return { vertexIds, entityIds }
}

/** Vertex composite ids that should NOT be drawn or registered for picking
 *  because another vertex in the same coincident-bonded cluster already stands
 *  in for that point. The leader (the kept vertex) is the lexicographically
 *  smallest composite id in the cluster, chosen deterministically so the render
 *  layer and the pick layer always agree on which one survives.
 *
 *  The merge is constraint-backed only: two points are collapsed solely because
 *  a `coincident` constraint (transitively) bonds them, never because they
 *  happen to overlap in space. Drop the constraint and both points come back as
 *  separate handles. Refs to non-local points (e.g. `@builtin_origin`) are
 *  ignored, so a point pinned to the origin keeps its own dot. */
export function suppressedCoincidentVertexIds(
  constraints: ReadonlyArray<{ kind?: string; a?: unknown; b?: unknown }>,
  featureId: string,
): Set<string> {
  // Union-find over composite ids; the root is kept as the smallest id so the
  // leader is stable regardless of constraint order.
  const parent = new Map<string, string>()
  const ensure = (x: string) => { if (!parent.has(x)) parent.set(x, x) }
  const find = (x: string): string => {
    let r = x
    let next = parent.get(r)
    while (next !== r) {
      r = next as string
      next = parent.get(r)
    }
    return r
  }
  const union = (a: string, b: string) => {
    ensure(a); ensure(b)
    const ra = find(a), rb = find(b)
    if (ra === rb) return
    if (ra < rb) parent.set(rb, ra)
    else parent.set(ra, rb)
  }
  for (const c of constraints) {
    if (c.kind !== 'coincident') continue
    const pa = parseLocalVertexRef(typeof c.a === 'string' ? c.a : null)
    const pb = parseLocalVertexRef(typeof c.b === 'string' ? c.b : null)
    if (!pa || !pb) continue
    union(
      compositeVertexId(featureId, pa.entityId, pa.vertexKey),
      compositeVertexId(featureId, pb.entityId, pb.vertexKey),
    )
  }
  const suppressed = new Set<string>()
  for (const id of parent.keys()) {
    if (find(id) !== id) suppressed.add(id)
  }
  return suppressed
}

/** Determine whether a pending drag should transition to active drag.
 *  Returns true when pixel movement equals or exceeds CLICK_THRESHOLD_PX. */
export function shouldActivateDrag(
  startClient: readonly [number, number],
  currentClient: readonly [number, number],
): boolean {
  return Math.hypot(currentClient[0] - startClient[0], currentClient[1] - startClient[1]) >= CLICK_THRESHOLD_PX
}

/** True when the document holds every element the drag would move: an edge drag
 *  on a held entity, or a group whose every member is held. The preview stays
 *  frozen then (the fallback and the WASM solve both hold the entity), so the
 *  release must commit nothing rather than record a dead translate. A mixed
 *  group is not held: its free members still move. A vertex drag is never
 *  dropped: a fixed point can still be pivoted about by the live solver, and
 *  its preview is that solve, not the whole-entity translation. */
export function dragIsHeld(drag: VertexOrEdgeDrag, held: ReadonlySet<string>): boolean {
  if (drag.group && drag.group.length > 1) {
    return drag.group.every(member => held.has(member.entityId))
  }
  return drag.type === 'edge' && held.has(drag.entityId)
}

/** Compute snap target and effective position for the current drag.
 *  pixelsPerUnit = p2w(camera) -- the caller extracts this from Three.js and passes it in as
 *  a plain number so this function has zero Three.js dependencies.
 *
 *  vertexCandidates and entityCandidates are the pre-built flat arrays from the adapter layer.
 *  `skips` is dragSnapSkips' verdict: the bonded vertices and the entity bodies the drag
 *  must not latch onto. The dragged entity's own vertices stay out too, so a drag cannot
 *  snap onto the other end of the line it is moving. */
export function computeDragMove(
  localPoint: readonly [number, number],
  vertexCandidates: SnapCandidate[],
  entityCandidates: EntityCandidate[],
  skips: DragSnapSkips,
  drag: VertexOrEdgeDrag,
  pixelsPerUnit: number,
): DragMoveResult {
  const [x, y] = localPoint

  if (drag.type !== 'vertex' || drag.group) {
    // Edge drag and any group drag: no snap. A group is a translation of
    // several members, and snapping one vertex of it to a point is a different
    // gesture (the plain vertex drag) that would also author a constraint the
    // rest of the group does not share.
    return {
      snapTarget: null,
      effectivePosition: [x, y],
    }
  }

  // Snap detection
  const ownEntity = `:${drag.featureId}:${drag.entityId}:`
  const filteredVertices = vertexCandidates.filter(t =>
    !skips.vertexIds.has(t.id) && !t.id.includes(ownEntity))
  const filteredEntities = collectEntityCandidatesFlat(entityCandidates, skips.entityIds)
  const snapTarget = findSnapTarget(
    filteredVertices,
    filteredEntities,
    'vertex',
    x, y,
    DRAG_SNAP_VERTEX_RADIUS_PX * pixelsPerUnit,
    DRAG_SNAP_ENTITY_RADIUS_PX * pixelsPerUnit,
  )
  const snapPosition: [number, number] | null = snapTarget?.position ?? null

  return {
    snapTarget,
    effectivePosition: snapPosition ?? [x, y],
  }
}

/** Determine the final mutation to emit on pointer-up.
 *  Returns null for a pure click (movement below CLICK_THRESHOLD_PX) or for dim_label drags
 *  (handled separately by the caller).
 *
 *  `lastDragSolve` is the last WASM drag-frame solve (from dragSolveRegistry,
 *  passed in to keep this module pure). When it belongs to this drag's
 *  feature, the per-entity solved params ride along on the vertex mutation so
 *  the commit hard solve seeds from the on-screen state, without it the
 *  solve seeds from pre-drag geometry + one teleported vertex and can land in
 *  a different solution basin (visible snap on release). */
export function computeDragMutation(
  endClient: readonly [number, number],
  drag: VertexOrEdgeDrag,
  snapTarget: SnapTarget | null,
  lastDragSolve?: { featureId: string; geometry?: Record<string, number[]>; mode?: CircleDragMode } | null,
): Mutation | null {
  // Click-vs-drag: pixel distance from pointer-down to pointer-up
  if (isPureClick(drag.startClient, endClient)) return null

  const solvedGeometry =
    lastDragSolve && lastDragSolve.featureId === drag.featureId
      ? lastDragSolve.geometry
      : undefined

  // A drag that started on a selected element moves the whole selection by the
  // cursor delta. This comes before the snap branches on purpose: a group drag
  // authors no constraint, and one group is one undo entry. A latched locked
  // group (every member fixed or projected) commits nothing, exactly as a locked
  // circle does, so no junk undo entry is recorded.
  if (drag.group && drag.group.length > 1) {
    const lastForFeature =
      lastDragSolve && lastDragSolve.featureId === drag.featureId ? lastDragSolve : undefined
    if (lastForFeature?.mode === 'locked') return null
    const delta: [number, number] = [
      drag.currentWorld[0] - drag.startWorld[0],
      drag.currentWorld[1] - drag.startWorld[1],
    ]
    return { type: 'move_sketch_group', featureId: drag.featureId, members: drag.group, delta, solvedGeometry }
  }

  if (drag.type === 'edge') {
    // The mode is resolved once at drag activation and latched for the gesture;
    // it rides along on the last drag-solve entry published by the rAF loop.
    // A mode published for a different feature (stale registry) is ignored, as
    // the absent-mode case below is -- the guard is the featureId match.
    const lastForFeature =
      lastDragSolve && lastDragSolve.featureId === drag.featureId ? lastDragSolve : undefined

    // Locked: neither the centre nor the radius can move. Emit nothing, so no
    // mutation commits and no undo entry is recorded (closes the junk-undo bug
    // for a fully constrained circle drag).
    if (lastForFeature?.mode === 'locked') return null

    // Radius (centre pinned): resize the circle to the solved radius. The radius
    // is read from the last drag frame's solved geometry, which already reflects
    // the rim-follows-cursor solve.
    if (lastForFeature?.mode === 'radius') {
      const radius = solvedGeometry ? solvedGeometry[drag.entityId]?.[2] : undefined
      if (radius === undefined) return null
      return { type: 'resize_circle', featureId: drag.featureId, entityId: drag.entityId, radius, solvedGeometry }
    }

    // Translate (mode 'translate' or absent, the default for every other kind):
    // translate the whole entity by the cursor delta.
    const delta: [number, number] = [
      drag.currentWorld[0] - drag.startWorld[0],
      drag.currentWorld[1] - drag.startWorld[1],
    ]
    return { type: 'move_entity', featureId: drag.featureId, entityId: drag.entityId, delta, solvedGeometry }
  }

  if (snapTarget?.kind === 'vertex') {
    // Part snap targets encode the body featureId with BODY_SNAP_FEAT_PREFIX; no constraint is
    // created because the projected 3D position is a positional reference only.
    const isPartSnap = snapTarget.vertexId?.startsWith(`vertex:${PART_SNAP_FEAT_PREFIX}`)
    if (isPartSnap) {
      return {
        type: 'move_vertex',
        featureId: drag.featureId,
        entityId: drag.entityId,
        vertexKey: drag.vertexKey,
        to: snapTarget.position,
        solvedGeometry,
      }
    }
    return {
      type: 'move_vertex_with_constraint',
      featureId: drag.featureId,
      entityId: drag.entityId,
      vertexKey: drag.vertexKey,
      to: snapTarget.position,
      constraintKind: snapTarget.constraintKind,
      snapVertexId: snapTarget.vertexId,
      solvedGeometry,
    }
  }

  if (snapTarget?.kind === 'entity') {
    // Part edge snap: position only, no constraint.
    const isPartEntitySnap = snapTarget.entityRef?.startsWith(`entity:${PART_SNAP_FEAT_PREFIX}`)
    if (isPartEntitySnap) {
      return {
        type: 'move_vertex',
        featureId: drag.featureId,
        entityId: drag.entityId,
        vertexKey: drag.vertexKey,
        to: snapTarget.position,
        solvedGeometry,
      }
    }
    return {
      type: 'move_vertex_with_constraint',
      featureId: drag.featureId,
      entityId: drag.entityId,
      vertexKey: drag.vertexKey,
      to: snapTarget.position,
      constraintKind: snapTarget.constraintKind,
      snapEntityRef: snapTarget.entityRef,
      solvedGeometry,
    }
  }

  return {
    type: 'move_vertex',
    featureId: drag.featureId,
    entityId: drag.entityId,
    vertexKey: drag.vertexKey,
    to: drag.currentWorld,
    solvedGeometry,
  }
}
