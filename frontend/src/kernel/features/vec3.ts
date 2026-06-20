// Shared 3D vector primitives for the feature solvers. Only the helpers that are
// byte-for-byte identical across leaves live here; sign/zero-handling variants
// (normalize) stay local to the file that needs its specific behaviour.

export type Vec3 = [number, number, number]

export function sub(a: number[], b: number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function cross(a: number[], b: number[]): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}
