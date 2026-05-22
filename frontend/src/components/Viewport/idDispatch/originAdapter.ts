import { useSketchEditorStore } from '@/stores/sketchEditorStore'

export const originAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId(entityKey)
    s.setHoveredVertex(entityKey, [0, 0], 'vertex')
  },
  onClick(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.toggleNormalSelection(entityKey)
  },
}

/** Clear origin marker hover state. */
export function clearOriginHover(): void {
  const s = useSketchEditorStore.getState()
  s.setHoveredSelectionId(null)
  s.setHoveredVertex(null, null, null)
}
