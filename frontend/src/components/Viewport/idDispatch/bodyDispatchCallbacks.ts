/**
 * Per-Body3D callbacks consumed by the id-buffer pointer dispatcher
 * (267.4 cutover). Each Body3D registers its featureId, the ID-buffer
 * query lists for its faces/edges/vertices, plus the local-state setters
 * the dispatcher needs to drive (hovered edge/vertex index, face geometry).
 *
 * Click + hover writes that don't need per-body context (toggling
 * normalSelection, hovered3DSurfaceId, hoveredBodyId) are issued directly
 * by the dispatcher against the store.
 */

import type { Mesh3D } from '@/types/cad'

export interface BodyDispatchCallbacks {
  featureId: string
  bodyId: string
  mesh: Mesh3D
  edgeQueries: readonly string[] | undefined
  vertexQueries: readonly string[] | undefined
  setHoveredEdgeIndex: (idx: number | null) => void
  setHoveredVertexIndex: (idx: number | null) => void
  updateFaceGeometryForQuery: (faceQuery: string) => void
  clearFaceGeometry: () => void
}

const byBodyKey = new Map<string, BodyDispatchCallbacks>()

export function registerBodyCallbacks(bodyKey: string, cb: BodyDispatchCallbacks): () => void {
  byBodyKey.set(bodyKey, cb)
  return () => { if (byBodyKey.get(bodyKey) === cb) byBodyKey.delete(bodyKey) }
}

export function findBodyForFaceQuery(q: string): { body: BodyDispatchCallbacks; index: number } | null {
  for (const body of byBodyKey.values()) {
    const idx = body.mesh.face_queries?.indexOf(q) ?? -1
    if (idx >= 0) return { body, index: idx }
  }
  return null
}

export function findBodyForEdgeQuery(q: string): { body: BodyDispatchCallbacks; index: number } | null {
  for (const body of byBodyKey.values()) {
    const idx = body.edgeQueries?.indexOf(q) ?? -1
    if (idx >= 0) return { body, index: idx }
  }
  return null
}

export function findBodyForVertexQuery(q: string): { body: BodyDispatchCallbacks; index: number } | null {
  for (const body of byBodyKey.values()) {
    const idx = body.vertexQueries?.indexOf(q) ?? -1
    if (idx >= 0) return { body, index: idx }
  }
  return null
}

/** Clear hover index on every registered body. Used when the cursor leaves all geometry. */
export function clearAllBodyHover(): void {
  for (const body of byBodyKey.values()) {
    body.setHoveredEdgeIndex(null)
    body.setHoveredVertexIndex(null)
    body.clearFaceGeometry()
  }
}

/** Test helper. */
export function resetBodyCallbacksForTest(): void {
  byBodyKey.clear()
}
