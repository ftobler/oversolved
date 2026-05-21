// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Mutation } from '@/types/cad'
import type { VertexOrEdgeDrag } from '@/stores/sketchEditorStore'
import type { SnapTarget, SnapCandidate, EntityCandidate } from '@/components/Geometry3D/snapDetection'
import { findSnapTarget, collectVertexTargetsFlat, collectEntityCandidatesFlat } from '@/components/Geometry3D/snapDetection'
import { isPureClick, CLICK_THRESHOLD_PX } from '@/components/Geometry3D/pointerAbstraction'
import { DRAG_SNAP_VERTEX_RADIUS_PX, DRAG_SNAP_ENTITY_RADIUS_PX } from '@/components/Geometry3D/constants'
import { BODY_SNAP_FEAT_PREFIX } from '@/components/Geometry3D/bodySnapProjection'

export interface DragMoveResult {
  snapTarget: SnapTarget | null
  /** Effective position for this frame (snap > raw cursor). */
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
 *  (handled separately by the caller). */
export function computeDragMutation(
  endClient: readonly [number, number],
  drag: VertexOrEdgeDrag,
  snapTarget: SnapTarget | null,
  _alignmentSnap: { point: [number, number]; kind: string; vertexId: string } | null,
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


