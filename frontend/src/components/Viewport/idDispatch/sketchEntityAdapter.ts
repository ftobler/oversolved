import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { dispatchSketchClick } from './dispatchSketchClick'

/**
 * Adapter for the `sketchEntity` ID layer. On hover sets the store's
 * sketch-entity hover fields. On click routes through the tool registry
 * (mirroring the pre-267.5 EntityItem.onClick path).
 *
 * Entity key shape: `entity:<featureId>:<entityId>`
 */
export const sketchEntityAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setInternalHoverSelection(entityKey)
    s.setHoveredEntity(entityKey)
  },
  onClick(entityKey: string, clientX: number, clientY: number): void {
    dispatchSketchClick(entityKey, undefined, clientX, clientY)
  },
}

/** Clear sketch-entity hover state. */
export function clearSketchEntityHover(): void {
  const s = useSketchEditorStore.getState()
  s.setInternalHoverSelection(null)
  s.setHoveredEntity(null)
}
