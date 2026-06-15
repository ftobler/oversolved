import { useSketchEditorStore } from '@/stores/sketchEditorStore'

export const originAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId(entityKey)
    s.setHoveredVertex(entityKey, [0, 0], 'vertex')
  },
}


