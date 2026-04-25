// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Sketch, Mutation } from '../../types/cad'
import type { VertexOrEdgeDrag } from '../../stores/sketchEditorStore'
import type { SnapTarget } from './snapDetection'
import { findSnapTarget, collectVertexTargets, collectEntityCandidates } from './snapDetection'
import { detectAlignmentSnap } from '../../registry'
import { isPureClick, CLICK_THRESHOLD_PX } from './pointerAbstraction'
import { DRAG_SNAP_VERTEX_RADIUS_PX, DRAG_SNAP_ENTITY_RADIUS_PX } from './constants'
import { BODY_SNAP_FEAT_PREFIX } from './bodySnapProjection'

export interface DragMoveResult {
  snapTarget: SnapTarget | null
  alignmentSnap: { point: [number, number]; kind: 'kinda_horizontal' | 'kinda_vertical'; vertexId: string } | null
  /** Vertex IDs that entered proximity range this frame (for dynamic selection toggle). */
  newProximityIds: Set<string>
  /** Full set of vertex IDs currently in proximity range (for diffing on next frame). */
  allProximityIds: Set<string>
  /** Effective position for this frame (alignment snap > regular snap > raw cursor). */
  effectivePosition: [number, number]
}

/** Determine whether a pending drag should transition to active drag.
 *  Returns true when pixel movement equals or exceeds CLICK_THRESHOLD_PX. */
export function shouldActivateDrag(
  startClient: readonly [number, number],
  currentClient: readonly [number, number],
): boolean {
  return Math.hypot(currentClient[0] - startClient[0], currentClient[1] - startClient[1]) >= CLICK_THRESHOLD_PX
}

/** Simulate a single updateDynamicSelection toggle.
 *  Mirrors the store's updateDynamicSelection logic without any store dependency. */
function simulateDynamicToggle(
  current: ReadonlySet<string>,
  normalSelection: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(current)
  const inNormal = normalSelection.has(id)
  const inDynamic = next.has(id)
  if (inNormal) {
    if (inDynamic) next.delete(id)
  } else {
    if (!inDynamic) next.add(id)
  }
  return next
}

/** Compute snap target, alignment snap, and proximity changes for the current drag position.
 *  pixelsPerUnit = p2w(camera) -- the caller extracts this from Three.js and passes it in as
 *  a plain number so this function has zero Three.js dependencies.
 *
 *  currentDynamicSelection and normalSelection are needed to simulate the store toggle so
 *  alignment snap can be detected on the post-update dynamic selection in the same frame. */
export function computeDragMove(
  localPoint: readonly [number, number],
  sketch: Sketch,
  featureId: string,
  drag: VertexOrEdgeDrag,
  currentDynamicSelection: ReadonlySet<string>,
  normalSelection: ReadonlySet<string>,
  dynamicSelectionPositions: ReadonlyMap<string, [number, number]>,
  prevProximityIds: ReadonlySet<string>,
  pixelsPerUnit: number,
  otherSketches?: Record<string, Sketch>,
): DragMoveResult {
  const [x, y] = localPoint

  if (drag.type !== 'vertex') {
    // Edge drag: no snap, no proximity scan
    return {
      snapTarget: null,
      alignmentSnap: null,
      newProximityIds: new Set(),
      allProximityIds: new Set(),
      effectivePosition: [x, y],
    }
  }

  // Snap detection
  const vertexCandidates = collectVertexTargets(sketch, featureId, drag.entityId, otherSketches)
  const entityCandidates = collectEntityCandidates(sketch, featureId, drag.entityId, otherSketches)
  const snapTarget = findSnapTarget(
    vertexCandidates,
    entityCandidates,
    'vertex',
    x, y,
    DRAG_SNAP_VERTEX_RADIUS_PX * pixelsPerUnit,
    DRAG_SNAP_ENTITY_RADIUS_PX * pixelsPerUnit,
  )
  let snapPosition: [number, number] | null = snapTarget?.position ?? null

  // Proximity scan for dynamic selection accumulation (alignment snap reference points).
  // Use 3x the vertex snap radius so alignment references accumulate well before snap fires.
  const scanRadius = DRAG_SNAP_VERTEX_RADIUS_PX * pixelsPerUnit * 3
  const nearbyTargets = vertexCandidates
    .filter(t => Math.hypot(t.position[0] - x, t.position[1] - y) <= scanRadius)
  const allProximityIds = new Set(nearbyTargets.map(t => t.id))
  const newProximityIds = new Set([...allProximityIds].filter(id => !prevProximityIds.has(id)))

  // Simulate dynamic selection update to detect alignment snap in the same frame.
  let simulatedDynamic: Set<string> = new Set(currentDynamicSelection)
  for (const id of newProximityIds) {
    simulatedDynamic = simulateDynamicToggle(simulatedDynamic, normalSelection, id)
  }

  // Build a complete positions map: existing dynamic positions + newly-discovered proximity positions
  const allPositions = new Map(dynamicSelectionPositions)
  for (const t of nearbyTargets) {
    if (!allPositions.has(t.id)) {
      allPositions.set(t.id, t.position)
    }
  }

  // Alignment snap detection
  let alignmentSnap: DragMoveResult['alignmentSnap'] = null
  if (simulatedDynamic.size > 0) {
    const alignment = detectAlignmentSnap(simulatedDynamic, snapPosition ?? [x, y], allPositions)
    if (alignment) {
      alignmentSnap = { point: alignment.point, kind: alignment.kind, vertexId: alignment.vertexId }
      snapPosition = alignment.point
    }
  }

  return {
    snapTarget,
    alignmentSnap,
    newProximityIds,
    allProximityIds,
    effectivePosition: snapPosition ?? [x, y],
  }
}

/** Determine the final mutation to emit on pointer-up.
 *  Returns null for a pure click (movement below CLICK_THRESHOLD_PX) or for dim_label drags
 *  (handled separately by the caller). */
export function computeDragMutation(
  endClient: readonly [number, number],
  drag: VertexOrEdgeDrag,
  snapTarget: SnapTarget | null,
  alignmentSnap: { point: [number, number]; kind: string; vertexId: string } | null,
): Mutation | null {
  // Click-vs-drag: pixel distance from pointer-down to pointer-up
  if (isPureClick(drag.startClient, endClient)) return null

  if (drag.type === 'edge') {
    const delta: [number, number] = [
      drag.currentWorld[0] - drag.startWorld[0],
      drag.currentWorld[1] - drag.startWorld[1],
    ]
    return { type: 'move_entity', featureId: drag.featureId, entityId: drag.entityId, delta }
  }

  // Vertex drag: check alignment snap first, then regular snap, then raw move
  if (alignmentSnap?.kind && alignmentSnap.point && alignmentSnap.vertexId) {
    const constraintKind = alignmentSnap.kind === 'kinda_horizontal' ? 'horizontal' : 'vertical'
    return {
      type: 'move_vertex_with_constraint',
      featureId: drag.featureId,
      entityId: drag.entityId,
      vertexKey: drag.vertexKey,
      to: alignmentSnap.point,
      constraintKind,
      snapVertexId: alignmentSnap.vertexId,
    }
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
    }
  }

  return {
    type: 'move_vertex',
    featureId: drag.featureId,
    entityId: drag.entityId,
    vertexKey: drag.vertexKey,
    to: drag.currentWorld,
  }
}
