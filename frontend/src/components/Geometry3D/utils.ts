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

export function planeRotation(planeQuery: string | undefined): [number, number, number] {
  if (!planeQuery) return [0, 0, 0]
  const id = planeQuery.startsWith('@') ? planeQuery.slice(1) : planeQuery
  return BUILTIN_PLANE_ROTATIONS[id] ?? [0, 0, 0]
}
