// Shared low-level 3D vector primitives: componentwise add/sub/scale plus the
// dot and cross products. Neutral ground between the viewport math in utils and
// the feature solvers in kernel, which is why it lives in utils, the layer both
// sides may import. Only the operations that are byte-for-byte identical across
// call sites are here; the sign/zero-handling variants (normalize) stay local to
// the file whose domain decides whether a degenerate input throws, returns null
// or returns zero.

export type Vec3 = [number, number, number]

export function sub(a: number[], b: number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function add(a: number[], b: number[]): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function scale(v: number[], s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s]
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
