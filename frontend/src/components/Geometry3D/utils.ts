/** Euler rotations (XYZ) for each built-in sketch plane. */
const BUILTIN_PLANE_ROTATIONS: Record<string, [number, number, number]> = {
  'builtin_plane_front': [0, 0, 0],
  'builtin_plane_top':   [-Math.PI / 2, 0, 0],
  'builtin_plane_right': [0, Math.PI / 2, 0],
}

/** Returns the selection ID for a builtin plane or origin by display name. */
export function builtinSelectionId(name: string): string {
  if (name === 'Origin') return '@builtin_origin'
  return `@builtin_plane_${name.toLowerCase()}`
}

/** Returns a human-readable label for a plane query string. */
export function planeLabel(query: string | undefined): string {
  if (!query) return 'None'
  if (query === '@builtin_plane_front') return 'Front'
  if (query === '@builtin_plane_top') return 'Top'
  if (query === '@builtin_plane_right') return 'Right'
  return 'Derived face'
}

/** Returns the selection ID for a topology surface face. */
export function surfaceSelectionId(featureId: string, query: string): string {
  return `face:${featureId}:${query}`
}

export function planeRotation(planeQuery: string | undefined): [number, number, number] {
  if (!planeQuery) return [0, 0, 0]
  const id = planeQuery.startsWith('@') ? planeQuery.slice(1) : planeQuery
  return BUILTIN_PLANE_ROTATIONS[id] ?? [0, 0, 0]
}
