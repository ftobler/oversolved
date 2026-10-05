import { planeRotation } from '@/components/Geometry3D/utils'

// Default edge length, in world units, of a plane quad with no sized geometry
// behind it: builtin reference planes, user-defined planes with no extent, and
// the active sketch-plane display.
export const DEFAULT_PLANE_SIZE = 100

// Euler rotation for a builtin sketch plane query, or null when the query does
// not name a builtin plane (a face or user-plane query must not be drawn at the
// identity rotation). The triples themselves live in Geometry3D/utils.
export function builtinPlaneRotation(planeQuery: string): [number, number, number] | null {
  const match = planeQuery.match(/@([^/]+)/)
  if (!match || !match[1].startsWith('builtin_plane_')) return null
  return planeRotation(planeQuery)
}
