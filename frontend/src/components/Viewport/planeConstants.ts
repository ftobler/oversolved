import { planeRotation } from '@/components/Geometry3D/utils'

// Re-exported so the viewport's existing imports keep their home; the value is
// single-sourced in utils/builtinPlanes alongside the builtin rotations.
export { DEFAULT_PLANE_SIZE } from '@/utils/builtinPlanes'

// Euler rotation for a builtin sketch plane query, or null when the query does
// not name a builtin plane (a face or user-plane query must not be drawn at the
// identity rotation). The triples themselves live in utils/builtinPlanes.
export function builtinPlaneRotation(planeQuery: string): [number, number, number] | null {
  const match = planeQuery.match(/@([^/]+)/)
  if (!match || !match[1].startsWith('builtin_plane_')) return null
  return planeRotation(planeQuery)
}
