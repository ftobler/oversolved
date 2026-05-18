import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import {
  findBodyForFaceQuery,
  findBodyForEdgeQuery,
  findBodyForVertexQuery,
  clearAllBodyHover,
} from './bodyDispatchCallbacks'

/**
 * Hover & click adapters for the three B-rep ID layers. These translate
 * `(layer, entityKey)` resolver hits into the same store mutations the
 * pre-267.4 R3F handlers performed:
 *
 * | layer  | hover writes                                   | click writes                                  |
 * |--------|------------------------------------------------|-----------------------------------------------|
 * | face   | hovered3DSurfaceId, hoveredBodyId, face geom   | toggleNormalSelection (+ plane)              |
 * | edge   | per-body local hoveredEdgeIndex, hoveredBodyId | toggleNormalSelection                        |
 * | vertex | per-body local hoveredVertexIndex, hoveredBodyId | toggleNormalSelection                      |
 *
 * "Per-body" writes go through the bodyDispatchCallbacks registry
 * because each Body3D keeps the matching highlight state locally.
 */

const _bodyHovered = new Set<string>()

function setBodyId(bodyIds: string[]): void {
  // Clear body id hover on any previously-hovered bodies not in the new set.
  for (const id of _bodyHovered) {
    if (!bodyIds.includes(id)) {
      const s = useSketchEditorStore.getState()
      if (s.hoveredBodyId === id) s.setHoveredBodyId(null)
    }
  }
  _bodyHovered.clear()
  for (const id of bodyIds) _bodyHovered.add(id)
}

export const brepFaceAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    const found = findBodyForFaceQuery(entityKey)
    if (!found) {
      clearAllBodyHover()
      s.setHovered3DSurface(null)
      return
    }
    clearAllBodyHover()
    s.setHovered3DSurface(entityKey)
    s.setHoveredBodyId(found.body.featureId)
    setBodyId([found.body.featureId])
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
    const found = findBodyForEdgeQuery(entityKey)
    if (!found) {
      clearAllBodyHover()
      return
    }
    clearAllBodyHover()
    found.body.setHoveredEdgeIndex(found.index)
    s.setHoveredBodyId(found.body.featureId)
    setBodyId([found.body.featureId])
  },
  onClick(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.toggleNormalSelection(entityKey)
  },
}

export const brepVertexAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    const found = findBodyForVertexQuery(entityKey)
    if (!found) {
      clearAllBodyHover()
      return
    }
    clearAllBodyHover()
    found.body.setHoveredVertexIndex(found.index)
    s.setHoveredBodyId(found.body.featureId)
    setBodyId([found.body.featureId])
  },
  onClick(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.toggleNormalSelection(entityKey)
  },
}

/**
 * Called when the cursor leaves every consumed B-rep layer (or hits
 * empty space). Mirrors the union of the old onPointerOut writes.
 */
export function clearBrepHover(): void {
  const s = useSketchEditorStore.getState()
  s.setHovered3DSurface(null)
  s.setHoveredBodyId(null)
  s.setHoveredFaceGeometry(null, null)
  _bodyHovered.clear()
  clearAllBodyHover()
}
