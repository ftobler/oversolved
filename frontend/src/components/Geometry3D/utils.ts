import * as THREE from 'three'

// Euler rotations (XYZ) for each built-in sketch plane.
const BUILTIN_PLANE_ROTATIONS: Record<string, [number, number, number]> = {
  'builtin_plane_front': [0, 0, 0],
  'builtin_plane_top':   [-Math.PI / 2, 0, 0],
  'builtin_plane_right': [0, Math.PI / 2, 0],
}

// Returns the selection ID for a builtin plane or origin by display name.
export function builtinSelectionId(name: string): string {
  if (name === 'Origin') return '@builtin_origin'
  return `@builtin_plane_${name.toLowerCase()}`
}

export function planeRotation(planeQuery: string | undefined): [number, number, number] {
  if (!planeQuery) return [0, 0, 0]
  const id = planeQuery.startsWith('@') ? planeQuery.slice(1) : planeQuery
  return BUILTIN_PLANE_ROTATIONS[id] ?? [0, 0, 0]
}

// Convert a solver plane_transform (axes as rows: [x_axis, y_axis, normal]) to Three.js Euler XYZ angles.
// The rotation array is [x0, x1, x2, y0, y1, y2, n0, n1, n2] where each triplet is an axis.
// For a proper rotation matrix, axes must be columns, so we transpose when setting the Matrix4.
export function planeRotationFromTransform(t: { rotation: number[]; origin: number[] }): [number, number, number] {
  const [x0, x1, x2, y0, y1, y2, n0, n1, n2] = t.rotation
  const m = new THREE.Matrix4()
  // Set with transposed layout so axes become columns
  m.set(
    x0, y0, n0, 0,
    x1, y1, n1, 0,
    x2, y2, n2, 0,
    0,  0,  0,  1
  )
  const euler = new THREE.Euler()
  euler.setFromRotationMatrix(m, 'XYZ')
  return [euler.x, euler.y, euler.z]
}
