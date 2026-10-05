// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Mutation } from '@/types/cad'
import type { VertexOrEdgeDrag } from '@/stores/sketchEditorStore'
import type { SnapTarget, SnapCandidate, EntityCandidate } from '@/components/Geometry3D/snapDetection'
import type { CircleDragMode } from '@/components/Geometry3D/circleDragMode'
import { findSnapTarget, collectVertexTargetsFlat, collectEntityCandidatesFlat } from '@/components/Geometry3D/snapDetection'
import { isPureClick, CLICK_THRESHOLD_PX } from '@/components/Geometry3D/pointerAbstraction'
import { DRAG_SNAP_VERTEX_RADIUS_PX, DRAG_SNAP_ENTITY_RADIUS_PX } from '@/components/Geometry3D/constants'
import { BODY_SNAP_FEAT_PREFIX } from '@/components/Geometry3D/bodySnapProjection'

export interface DragMoveResult {
  snapTarget: SnapTarget | null
  // Effective position for this frame (snap > raw cursor).
  effectivePosition: [number, number]
}

const COINCIDENT_VERTEX_KEYS = ['start', 'end', 'center', 'xy', 'major1', 'major2', 'minor1', 'minor2', 'c1', 'c2'] as const

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
  const composite = (e: string, k: string) => `vertex:${featureId}:${e}:${k}`
  const result = new Set<string>([composite(entityId, vertexKey)])
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
      result.add(composite(partner.entityId, partner.vertexKey))
      queue.push(partner)
    }
  }
  return result
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
  const composite = (e: string, k: string) => `vertex:${featureId}:${e}:${k}`
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
    union(composite(pa.entityId, pa.vertexKey), composite(pb.entityId, pb.vertexKey))
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

/** Compute snap target and effective position for the current drag.
 *  pixelsPerUnit = p2w(camera) -- the caller extracts this from Three.js and passes it in as
 *  a plain number so this function has zero Three.js dependencies.
 *
 *  vertexCandidates and entityCandidates are the pre-built flat arrays from the adapter layer.
 *  skipIds identifies entities to exclude from snapping (e.g., the dragged entity). */
export function computeDragMove(
  localPoint: readonly [number, number],
  vertexCandidates: SnapCandidate[],
  entityCandidates: EntityCandidate[],
  skipIds: ReadonlySet<string>,
  drag: VertexOrEdgeDrag,
  pixelsPerUnit: number,
): DragMoveResult {
  const [x, y] = localPoint

  if (drag.type !== 'vertex') {
    // Edge drag: no snap
    return {
      snapTarget: null,
      effectivePosition: [x, y],
    }
  }

  // Snap detection
  const filteredVertices = collectVertexTargetsFlat(vertexCandidates, skipIds)
  const filteredEntities = collectEntityCandidatesFlat(entityCandidates, skipIds)
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
    // Body snap targets encode the body featureId with BODY_SNAP_FEAT_PREFIX; no constraint is
    // created because the projected 3D position is a positional reference only.
    const isBodySnap = snapTarget.vertexId?.startsWith(`vertex:${BODY_SNAP_FEAT_PREFIX}`)
    if (isBodySnap) {
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
    // Body edge snap: position only, no constraint.
    const isBodyEntitySnap = snapTarget.entityRef?.startsWith(`entity:${BODY_SNAP_FEAT_PREFIX}`)
    if (isBodyEntitySnap) {
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
