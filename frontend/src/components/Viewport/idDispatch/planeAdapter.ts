import { useSketchEditorStore } from '@/stores/sketchEditorStore'

export const planeAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId(entityKey)
  },
}
