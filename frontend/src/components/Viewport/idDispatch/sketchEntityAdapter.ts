import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { dispatchSketchClick, dispatchDragInitiation } from './dispatchSketchClick'

/**
 * Parse a sketch entity key like `entity:feat1:line1`
 * into { featureId, entityId }.
 */
function parseEntityKey(entityKey: string): { featureId: string; entityId: string } | null {
  if (!entityKey.startsWith('entity:')) return null
  const parts = entityKey.slice(7).split(':')
  if (parts.length < 2) return null
  return { featureId: parts[0], entityId: parts.slice(1).join(':') }
}

/**
 * Adapter for the `sketchEntity` ID layer.
 */
export const sketchEntityAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId(entityKey)
  },
  onClick(entityKey: string, clientX: number, clientY: number): void {
    const entityKind = useSketchEditorStore.getState().entityKindMap[entityKey]
    dispatchSketchClick(entityKey, entityKind, clientX, clientY)
  },
  onPointerDown(entityKey: string, clientX: number, clientY: number): void {
    const parsed = parseEntityKey(entityKey)
    if (!parsed) return
    dispatchDragInitiation(entityKey, parsed.featureId, parsed.entityId, 'edge', clientX, clientY)
  },
}
