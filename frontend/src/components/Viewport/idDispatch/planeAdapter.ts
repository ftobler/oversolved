import { useSketchEditorStore } from '@/stores/sketchEditorStore'

export const planeAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId(entityKey)
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
