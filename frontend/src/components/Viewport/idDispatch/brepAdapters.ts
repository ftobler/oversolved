import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import {
  findBodyForFaceQuery,
  clearAllBodyHover,
} from './bodyDispatchCallbacks'

/**
 * Hover adapters for the three B-rep ID layers.
 *
 * Hover writes a single `hoveredSelectionId` plus per-body face-geometry.
 * The caller (applyHoverHit) clears all hover state first, so each adapter
 * only sets the fields it cares about.
 *
 * Click handling is centralized in the dispatcher: every selectable layer
 * toggles normalSelection. These adapters carry no onClick.
 */

export const brepFaceAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    const found = findBodyForFaceQuery(entityKey)
    if (!found) {
      clearAllBodyHover()
      return
    }
    s.setHoveredSelectionId(entityKey)
    found.body.updateFaceGeometryForQuery(entityKey)
  },
}

export const brepEdgeAdapter = {
  onHover: setSelectionIdOnHover,
}

export const brepVertexAdapter = {
  onHover: setSelectionIdOnHover,
}

/**
 * Shared hover handler for adapters that simply set hoveredSelectionId.
 * Used by brepEdgeAdapter, brepVertexAdapter, planeAdapter, and the
 * sketch-surface inline handler in useIdBufferPointerDispatch.
 *
 * `pickKey` (when present) is the per-primitive identity of the hovered b-rep
 * primitive; it lets the highlight isolate the single primitive under the
 * cursor even when its query string collides with a sibling's.
 */
export function setSelectionIdOnHover(entityKey: string, pickKey?: string): void {
  const s = useSketchEditorStore.getState()
  s.setHoveredSelectionId(entityKey)
  s.setHoveredPickKey(pickKey ?? null)
}

/**
 * Clear ALL hover state from every domain (B-rep, sketch, plane, origin).
 * Single teardown function used by the dispatcher's applyHoverHit.
 */
export function clearAllHover(): void {
  const s = useSketchEditorStore.getState()
  s.setHoveredSelectionId(null)
  s.setHoveredPickKey(null)
  s.setHoveredVertex(null, null, null)
  s.setHoveredFaceGeometry(null, null)
  clearAllBodyHover()
}
