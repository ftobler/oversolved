import { useSketchEditorStore } from '@/stores/sketchEditorStore'

/**
 * Adapter for the `planeFace` ID layer. Maps (layer, entityKey) hits
 * to the same store mutations that ReferencePlane and UserDefinedPlane
 * perform via R3F handlers.
 */
export const planeAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredPlane(entityKey)
  },
  onClick(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    if (s.planeSelectionFeatureId) {
      s.commitPlaneSelection(entityKey)
    } else {
      s.toggleNormalSelection(entityKey)
    }
  },
}

/** Clear plane hover state. */
export function clearPlaneHover(): void {
  const s = useSketchEditorStore.getState()
  s.setHoveredPlane(null)
}
