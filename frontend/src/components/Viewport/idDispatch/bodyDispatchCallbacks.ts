/**
 * Per-Body3D callbacks consumed by the id-buffer pointer dispatcher.
 * Only face-geometry computation remains — edge/vertex hover is now
 * handled entirely via the store's `hoveredSelectionId` field (Body3D
 * resolves the index locally from its query arrays).
 */

import type { Mesh3D } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

export interface BodyDispatchCallbacks {
  featureId: string
  bodyId: string
  mesh: Mesh3D
  edgeQueries: readonly string[] | undefined
  /** Curve kind ('line' | 'circle' | 'arc' | 'spline') parallel to edgeQueries. */
  edgeKinds?: readonly string[]
  vertexQueries: readonly string[] | undefined
  updateFaceGeometryForQuery: (faceQuery: string) => void
  clearFaceGeometry: () => void
}

const byBodyKey = new Map<string, BodyDispatchCallbacks>()

export function registerBodyCallbacks(bodyKey: string, cb: BodyDispatchCallbacks): () => void {
  byBodyKey.set(bodyKey, cb)
  return () => {
    if (byBodyKey.get(bodyKey) !== cb) return
    byBodyKey.delete(bodyKey)
    // If this body owns the current hover, clear stale hover state
    const s = useSketchEditorStore.getState()
    const hovered = s.hoveredSelectionId
    if (hovered !== null) {
      const isMyQuery = cb.mesh.face_queries?.includes(hovered)
        ?? cb.edgeQueries?.includes(hovered)
        ?? cb.vertexQueries?.includes(hovered)
        ?? false
      if (isMyQuery) {
        s.setHoveredSelectionId(null)
        s.setHoveredFaceGeometry(null, null)
      }
    }
  }
}

/**
 * Resolve a body edge query to its curve kind ('line' | 'circle' | 'arc' |
 * 'spline'), so the project tool can create the matching projected entity.
 * Returns undefined when the query is not a registered body edge.
 */
export function findEdgeKindForQuery(q: string): string | undefined {
  for (const body of byBodyKey.values()) {
    const idx = body.edgeQueries?.indexOf(q) ?? -1
    if (idx >= 0) return body.edgeKinds?.[idx]
  }
  return undefined
}

export function findBodyForFaceQuery(q: string): { body: BodyDispatchCallbacks; index: number } | null {
  for (const body of byBodyKey.values()) {
    const idx = body.mesh.face_queries?.indexOf(q) ?? -1
    if (idx >= 0) return { body, index: idx }
  }
  return null
}

/** Clear face geometry on every registered body. */
export function clearAllBodyHover(): void {
  for (const body of byBodyKey.values()) {
    body.clearFaceGeometry()
  }
}

/** Test helper. */
export function resetBodyCallbacksForTest(): void {
  byBodyKey.clear()
}
