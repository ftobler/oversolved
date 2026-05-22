import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import {
  findBodyForFaceQuery,
  clearAllBodyHover,
} from './bodyDispatchCallbacks'

/**
 * Hover & click adapters for the three B-rep ID layers.
 *
 * Hover writes a single `hoveredSelectionId` plus per-body face-geometry.
 * The caller (applyHoverHit) clears all hover state first, so each adapter
 * only sets the fields it cares about.
 *
 * Click always toggles normalSelection (or commits a plane pick when
 * planeSelectionFeatureId is active).
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
  onClick(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    if (s.planeSelectionFeatureId) {
      s.commitPlaneSelection(entityKey)
      return
    }
    s.toggleNormalSelection(entityKey)
  },
}

export const brepEdgeAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId(entityKey)
  },
  onClick(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.toggleNormalSelection(entityKey)
  },
}

export const brepVertexAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId(entityKey)
  },
  onClick(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.toggleNormalSelection(entityKey)
  },
}

/**
 * Clear ALL hover state from every domain (B-rep, sketch, plane, origin).
 * Single teardown function used by the dispatcher's applyHoverHit.
 */
export function clearAllHover(): void {
  const s = useSketchEditorStore.getState()
  s.setHoveredSelectionId(null)
  s.setHoveredVertex(null, null, null)
  s.setHoveredFaceGeometry(null, null)
  clearAllBodyHover()
}
