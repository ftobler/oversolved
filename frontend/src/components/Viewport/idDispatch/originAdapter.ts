import { useSketchEditorStore } from '@/stores/sketchEditorStore'

/**
 * Adapter for the `originMarker` ID layer. The origin marker has click
 * + hover behavior identical to the pre-267.5 R3F handlers: on hover
 * it sets the hovered entity/vertex; on click it toggles selection
 * through the tool dispatch.
 */
export const originAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredEntity(entityKey)
    s.setHoveredVertex(entityKey, [0, 0], 'vertex')
  },
  onClick(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.toggleNormalSelection(entityKey)
    if (s.pendingPickField) s.commitFieldPick()
  },
}

/** Clear origin marker hover state. */
export function clearOriginHover(): void {
  const s = useSketchEditorStore.getState()
  s.setHoveredEntity(null)
  s.setHoveredVertex(null, null, null)
}
