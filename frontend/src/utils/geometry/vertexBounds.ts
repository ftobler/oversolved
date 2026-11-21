// Min/max accumulation over body vertex lists. Pure and free of any camera or
// scene dependency, so zoom-to-fit, the plane sizing helpers and the section
// outline all measure a body the same way.
export interface VertexBounds {
  min: [number, number, number]
  max: [number, number, number]
}

// Accepts either the flat Float32Array the kernel hands over or a tuple array
// from tests and adapters. Non-finite triples are skipped; returns null when no
// finite vertex was seen so callers can tell "empty" from "origin at zero".
export function computeVertexBounds(
  vertices: Float32Array | readonly [number, number, number][],
): VertexBounds | null {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity

  const visit = (x: number, y: number, z: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }

  if (vertices instanceof Float32Array) {
    for (let i = 0; i < vertices.length; i += 3) visit(vertices[i], vertices[i + 1], vertices[i + 2])
  } else {
    for (const [x, y, z] of vertices) visit(x, y, z)
  }

  if (!Number.isFinite(minX)) return null
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
}

/** The extent that contains both boxes; null is the empty box, so either side
 *  may be missing and the union still measures what is there. */
export function unionVertexBounds(a: VertexBounds | null, b: VertexBounds | null): VertexBounds | null {
  if (!a) return b
  if (!b) return a
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  }
}
