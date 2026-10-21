// Closed and open surfaces with a known curvature, for the curvature tests.
// Each fixture is indexed and wound outward, so the sign of the mean curvature
// is the geometric one: convex positive, saddle negative.
export interface RawSurface {
  positions: Float32Array
  indices: Uint32Array
}

function pack(vertices: number[][], faces: number[][]): RawSurface {
  const positions = new Float32Array(vertices.length * 3)
  vertices.forEach(([x, y, z], i) => {
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
  })
  return { positions, indices: new Uint32Array(faces.flat()) }
}

/**
 * A geodesic sphere from a subdivided icosahedron, projected back onto the
 * radius. Every vertex has the same curvature, which is the cleanest check that
 * the estimator does not drift with the tessellation.
 */
export function icosphere(radius: number, subdivisions = 3): RawSurface {
  const t = (1 + Math.sqrt(5)) / 2
  const vertices: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const length = Math.hypot(x, y, z)
    return [x / length, y / length, z / length]
  })
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]

  for (let level = 0; level < subdivisions; level++) {
    const midpoints = new Map<number, number>()
    // The key base is the vertex count BEFORE this level appends midpoints;
    // reading the live length would mint two midpoints for one edge and crack
    // the surface into non-manifold pieces.
    const base = vertices.length
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * base + b : b * base + a
      const hit = midpoints.get(key)
      if (hit !== undefined) return hit
      const pa = vertices[a]
      const pb = vertices[b]
      const x = (pa[0] + pb[0]) / 2
      const y = (pa[1] + pb[1]) / 2
      const z = (pa[2] + pb[2]) / 2
      const length = Math.hypot(x, y, z)
      vertices.push([x / length, y / length, z / length])
      const index = vertices.length - 1
      midpoints.set(key, index)
      return index
    }
    const next: number[][] = []
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = next
  }

  return pack(vertices.map(([x, y, z]) => [x * radius, y * radius, z * radius]), faces)
}

/** A flat grid in z = 0, shared interior vertices. */
export function plane(size: number, segments: number): RawSurface {
  const vertices: number[][] = []
  for (let y = 0; y <= segments; y++) {
    for (let x = 0; x <= segments; x++) {
      vertices.push([(x / segments - 0.5) * size, (y / segments - 0.5) * size, 0])
    }
  }
  const faces: number[][] = []
  const row = segments + 1
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * row + x
      const b = a + 1
      const c = a + row
      const d = c + 1
      faces.push([a, b, d], [a, d, c])
    }
  }
  return pack(vertices, faces)
}

/** An open cylinder around +Z, no caps: the middle ring is a true interior
 *  vertex, so the boundary correction does not colour the measurement. */
export function openCylinder(radius: number, height: number, radialSegments: number, heightSegments: number): RawSurface {
  const vertices: number[][] = []
  for (let h = 0; h <= heightSegments; h++) {
    for (let i = 0; i < radialSegments; i++) {
      const angle = (i / radialSegments) * Math.PI * 2
      vertices.push([radius * Math.cos(angle), radius * Math.sin(angle), (h / heightSegments) * height])
    }
  }
  const faces: number[][] = []
  for (let h = 0; h < heightSegments; h++) {
    for (let i = 0; i < radialSegments; i++) {
      const b0 = h * radialSegments + i
      const b1 = h * radialSegments + ((i + 1) % radialSegments)
      const t0 = (h + 1) * radialSegments + i
      const t1 = (h + 1) * radialSegments + ((i + 1) % radialSegments)
      faces.push([b0, b1, t1], [b0, t1, t0])
    }
  }
  return pack(vertices, faces)
}

/** A torus around +Z: outer side convex, inner side a saddle. */
export function torus(majorRadius: number, minorRadius: number, majorSegments: number, minorSegments: number): RawSurface {
  const vertices: number[][] = []
  for (let i = 0; i < majorSegments; i++) {
    const u = (i / majorSegments) * Math.PI * 2
    for (let j = 0; j < minorSegments; j++) {
      const v = (j / minorSegments) * Math.PI * 2
      const ring = majorRadius + minorRadius * Math.cos(v)
      vertices.push([ring * Math.cos(u), ring * Math.sin(u), minorRadius * Math.sin(v)])
    }
  }
  const faces: number[][] = []
  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < minorSegments; j++) {
      const a = i * minorSegments + j
      const b = i * minorSegments + ((j + 1) % minorSegments)
      const c = ((i + 1) % majorSegments) * minorSegments + j
      const d = ((i + 1) % majorSegments) * minorSegments + ((j + 1) % minorSegments)
      // Reverse of the (a, b, d) cycle: the tube's outward side is +x at u = 0.
      faces.push([a, d, b], [a, c, d])
    }
  }
  return pack(vertices, faces)
}
