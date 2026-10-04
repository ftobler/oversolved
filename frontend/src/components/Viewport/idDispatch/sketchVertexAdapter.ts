import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { dispatchSketchClick, dispatchDragInitiation } from './dispatchSketchClick'

/**
 * Parse a sketch vertex entity key like `vertex:feat1:line1:start`
 * into { featureId, entityId, vertexKey }.
 */
function parseVertexKey(entityKey: string): { featureId: string; entityId: string; vertexKey: string } | null {
  if (!entityKey.startsWith('vertex:')) return null
  const parts = entityKey.slice(7).split(':')
  if (parts.length < 3) return null
  const vertexKey = parts[parts.length - 1]
  const featureId = parts[0]
  const entityId = parts.slice(1, -1).join(':')
  return { featureId, entityId, vertexKey }
}

/**
 * Adapter for the `sketchVertex` ID layer. On hover sets the store's
 * sketch-vertex hover fields. On click routes through the tool registry.
 *
 * Entity key shape: `vertex:<featureId>:<entityId>:<vertexKey>`
 */
export const sketchVertexAdapter = {
  onHover(entityKey: string): void {
    // Set hovered vertex state without requiring a known world position.
    // The vertex position (x,y) is not encoded in the entity key; it was
    // set by the per-vertex ID registration. The store's hoveredVertexId
    // is sufficient for selection / highlight.
    const s = useSketchEditorStore.getState()
    s.setHoveredVertex(entityKey, null, 'vertex')
  },
  onClick(entityKey: string, clientX: number, clientY: number): void {
    dispatchSketchClick(entityKey, undefined, clientX, clientY)
  },
  onPointerDown(entityKey: string, clientX: number, clientY: number): void {
    const parsed = parseVertexKey(entityKey)
    if (!parsed) return
    dispatchDragInitiation(
      entityKey, parsed.featureId, parsed.entityId, parsed.vertexKey,
      clientX, clientY,
    )
  },
}
