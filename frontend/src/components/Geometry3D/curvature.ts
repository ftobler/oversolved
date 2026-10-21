// Discrete curvature for the Curvature row, computed on the tessellation itself.
//
// The kernel binding for `BRepLProp_SLProps` / `GeomLProp_SLProps` is not in the
// pinned opencascade.js build, so this is the mesh fallback the plan allows. It
// is a main-thread derivation, not solve wire: nothing here runs unless the row
// is on, and a normal solve never carries curvature data.
//
// Mean curvature is the cotangent Laplacian: delta(p) = (1 / 2A) sum w_ij
// (p_j - p_i), and the signed normal component is the mean curvature normal.
// Gaussian curvature is the angle defect over the mixed area. Both use Meyer's
// mixed Voronoi areas so a vertex on a triangle split does not report a
// different value from its neighbour.
//
// Faces do not share vertices across a B-rep boundary, so a value is only
// meaningful within one face. That is acceptable for the fallback and is why
// the shader paints per vertex rather than trying to smooth across a crease.
import type { Mesh3D } from '@/types/cad'
import type { CurvatureKind } from '@/adapters/preferences'
import { buildBodyGeometry } from '@/components/Geometry3D/bodyGeometry'

export interface CurvatureField {
  // Interleaved (mean, gaussian), two floats per vertex, matching the mesh's
  // indexed vertex order.
  values: Float32Array
  mean: Float32Array
  gaussian: Float32Array
}

interface EdgeRecord {
  a: number
  b: number
  // The two opposite vertices of a manifold interior edge. A boundary edge has
  // only c1; a non-manifold extra triangle is ignored for the same reason.
  c1: number
  c2: number
}

function addEdge(edges: Map<number, EdgeRecord>, count: number, i: number, j: number, opposite: number): void {
  const key = i < j ? i * count + j : j * count + i
  const record = edges.get(key)
  if (!record) {
    edges.set(key, { a: i, b: j, c1: opposite, c2: -1 })
  } else if (record.c2 < 0 && record.c1 !== opposite) {
    record.c2 = opposite
  }
}

/** The cotangent at the corner `o` of the triangle (a, b, o), with a and b as
 *  byte-free float offsets into `positions`. */
function cornerCotangent(positions: ArrayLike<number>, a: number, b: number, o: number): number {
  return cotangent(
    positions[a] - positions[o], positions[a + 1] - positions[o + 1], positions[a + 2] - positions[o + 2],
    positions[b] - positions[o], positions[b + 1] - positions[o + 1], positions[b + 2] - positions[o + 2],
  )
}

function cotangent(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dot = ax * bx + ay * by + az * bz
  const cx = ay * bz - az * by
  const cy = az * bx - ax * bz
  const cz = ax * by - ay * bx
  const cross = Math.hypot(cx, cy, cz)
  if (cross < 1e-12) return 0
  return dot / cross
}

/**
 * The mixed Voronoi area of one corner, from Meyer et al. `angleAt[i]` is the
 * corner's angle; an obtuse triangle splits the area by the obtuse corner
 * instead of the Voronoi cell.
 */
function addMixedAreas(
  areas: Float32Array,
  i: number,
  j: number, k: number,
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
  rx: number, ry: number, rz: number,
  cotI: number, cotJ: number, cotK: number,
): void {
  const area = 0.5 * Math.hypot(
    (qy - py) * (rz - pz) - (qz - pz) * (ry - py),
    (qz - pz) * (rx - px) - (qx - px) * (rz - pz),
    (qx - px) * (ry - py) - (qy - py) * (rx - px),
  )
  if (cotI >= 0 && cotJ >= 0 && cotK >= 0) {
    const ij = (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2
    const ik = (rx - px) ** 2 + (ry - py) ** 2 + (rz - pz) ** 2
    areas[i] += (ij * cotK + ik * cotJ) / 8
    const ji = ij
    const jk = (rx - qx) ** 2 + (ry - qy) ** 2 + (rz - qz) ** 2
    areas[j] += (ji * cotK + jk * cotI) / 8
    const ki = ik
    const kj = jk
    areas[k] += (ki * cotJ + kj * cotI) / 8
  } else if (cotI < 0) {
    // Obtuse at i: half the triangle belongs to i, a quarter to each other.
    areas[i] += area / 2
    areas[j] += area / 4
    areas[k] += area / 4
  } else if (cotJ < 0) {
    areas[j] += area / 2
    areas[i] += area / 4
    areas[k] += area / 4
  } else {
    areas[k] += area / 2
    areas[i] += area / 4
    areas[j] += area / 4
  }
}

/** Area-weighted vertex normals, used when the caller has no normals. */
function vertexNormals(positions: ArrayLike<number>, indices: ArrayLike<number>, count: number): Float32Array {
  const normals = new Float32Array(count * 3)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3
    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    normals[a] += nx
    normals[a + 1] += ny
    normals[a + 2] += nz
    normals[b] += nx
    normals[b + 1] += ny
    normals[b + 2] += nz
    normals[c] += nx
    normals[c + 1] += ny
    normals[c + 2] += nz
  }
  for (let i = 0; i < count; i++) {
    const x = normals[i * 3]
    const y = normals[i * 3 + 1]
    const z = normals[i * 3 + 2]
    const len = Math.hypot(x, y, z)
    if (len > 1e-12) {
      normals[i * 3] = x / len
      normals[i * 3 + 1] = y / len
      normals[i * 3 + 2] = z / len
    }
  }
  return normals
}

/**
 * Compute the per-vertex mean and Gaussian curvature. `normals` only fixes the
 * sign of the mean value; it is computed from the triangles when absent.
 */
export function computeCurvature(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  normals?: ArrayLike<number>,
): CurvatureField {
  const count = positions.length / 3
  const normal = normals ?? vertexNormals(positions, indices, count)
  const laplacian = new Float32Array(count * 3)
  const areas = new Float32Array(count)
  const angleSum = new Float32Array(count)
  const edges = new Map<number, EdgeRecord>()

  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]
    const ib = indices[t + 1]
    const ic = indices[t + 2]
    const a = ia * 3
    const b = ib * 3
    const c = ic * 3

    const abx = positions[b] - positions[a]
    const aby = positions[b + 1] - positions[a + 1]
    const abz = positions[b + 2] - positions[a + 2]
    const acx = positions[c] - positions[a]
    const acy = positions[c + 1] - positions[a + 1]
    const acz = positions[c + 2] - positions[a + 2]
    const bcx = positions[c] - positions[b]
    const bcy = positions[c + 1] - positions[b + 1]
    const bcz = positions[c + 2] - positions[b + 2]

    // The cotangent at a corner is the cotangent of the angle AT that corner,
    // i.e. between the two edges leaving it.
    const cotA = cotangent(abx, aby, abz, acx, acy, acz)
    const cotB = cotangent(-abx, -aby, -abz, bcx, bcy, bcz)
    const cotC = cotangent(-acx, -acy, -acz, -bcx, -bcy, -bcz)

    addMixedAreas(areas, ia, ib, ic,
      positions[a], positions[a + 1], positions[a + 2],
      positions[b], positions[b + 1], positions[b + 2],
      positions[c], positions[c + 1], positions[c + 2],
      cotA, cotB, cotC)

    addAngle(angleSum, ia, abx, aby, abz, acx, acy, acz)
    addAngle(angleSum, ib, -abx, -aby, -abz, bcx, bcy, bcz)
    addAngle(angleSum, ic, -acx, -acy, -acz, -bcx, -bcy, -bcz)

    addEdge(edges, count, ia, ib, ic)
    addEdge(edges, count, ib, ic, ia)
    addEdge(edges, count, ic, ia, ib)
  }

  // Boundary vertices use pi instead of 2pi in the angle defect. An edge with a
  // single adjacent triangle (or a non-manifold excess) is the same test.
  const boundary = new Uint8Array(count)
  for (const record of edges.values()) {
    if (record.c2 < 0) {
      boundary[record.a] = 1
      boundary[record.b] = 1
    }
  }

  for (const record of edges.values()) {
    const ia = record.a
    const ib = record.b
    const pa = ia * 3
    const pb = ib * 3
    let weight = cornerCotangent(positions, pa, pb, record.c1 * 3)
    if (record.c2 >= 0) weight += cornerCotangent(positions, pa, pb, record.c2 * 3)
    if (weight === 0) continue
    const dx = positions[pb] - positions[pa]
    const dy = positions[pb + 1] - positions[pa + 1]
    const dz = positions[pb + 2] - positions[pa + 2]
    laplacian[pa] += weight * dx
    laplacian[pa + 1] += weight * dy
    laplacian[pa + 2] += weight * dz
    laplacian[pb] -= weight * dx
    laplacian[pb + 1] -= weight * dy
    laplacian[pb + 2] -= weight * dz
  }

  const values = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const area = areas[i]
    if (!(area > 1e-12)) continue
    const p = i * 3
    // The Laplace-Beltrami of position is 2 H n with n outward; the discrete
    // delta points inward on a convex patch, so the sign is flipped back.
    const mean = -0.5 * (laplacian[p] * normal[p] + laplacian[p + 1] * normal[p + 1] + laplacian[p + 2] * normal[p + 2]) / (2 * area)
    const fullTurn = boundary[i] ? Math.PI : Math.PI * 2
    const gaussian = (fullTurn - angleSum[i]) / area
    values[i * 2] = mean
    values[i * 2 + 1] = gaussian
  }

  return splitField(values)
}

function addAngle(sum: Float32Array, vertex: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  const la = Math.hypot(ax, ay, az)
  const lb = Math.hypot(bx, by, bz)
  if (la < 1e-12 || lb < 1e-12) return
  const cosine = Math.min(1, Math.max(-1, (ax * bx + ay * by + az * bz) / (la * lb)))
  sum[vertex] += Math.acos(cosine)
}

function splitField(values: Float32Array): CurvatureField {
  const count = values.length / 2
  const mean = new Float32Array(count)
  const gaussian = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    mean[i] = values[i * 2]
    gaussian[i] = values[i * 2 + 1]
  }
  return { values, mean, gaussian }
}

// One field per mesh. A solve hands in a fresh Mesh3D, so the old entry falls
// out of the weak map with it; re-toggling the row on the same body is free.
const meshFields = new WeakMap<Mesh3D, CurvatureField>()

/** The field for one body, cached. Only call this while curvature is on. */
export function curvatureForMesh(mesh: Mesh3D): CurvatureField {
  const cached = meshFields.get(mesh)
  if (cached) return cached
  const { positions, indices } = buildBodyGeometry(mesh)
  const field = computeCurvature(positions, indices)
  meshFields.set(mesh, field)
  return field
}

/** A scalar view of one curvature kind, for range and legend use. */
export function curvatureSamples(values: Float32Array, kind: CurvatureKind): Float32Array {
  const offset = kind === 'mean' ? 0 : 1
  const out = new Float32Array(values.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = values[i * 2 + offset]
  return out
}

/** Percentile of |values|, so the two curvature sides share one symmetric
 *  range and zero lands on the neutral middle of the ramp. */
function percentileMagnitude(samples: ArrayLike<number>, percentile: number): number {
  const magnitudes: number[] = []
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]
    if (Number.isFinite(value)) magnitudes.push(Math.abs(value))
  }
  if (magnitudes.length === 0) return 0
  magnitudes.sort((a, b) => a - b)
  const index = Math.min(magnitudes.length - 1, Math.max(0, Math.floor(percentile * (magnitudes.length - 1))))
  return magnitudes[index]
}

/**
 * The automatic range from a scalar sample. The 98th percentile of the
 * magnitude keeps a single bad vertex from washing the whole body out, and the
 * range is symmetric so a flat face stays neutral.
 */
export function autoRange(samples: ArrayLike<number>): [number, number] | null {
  if (samples.length === 0) return null
  const magnitude = percentileMagnitude(samples, 0.98)
  if (!Number.isFinite(magnitude) || magnitude <= 0) return [0, 0]
  return [-magnitude, magnitude]
}

/**
 * The auto range across the visible bodies. Samples are strided down to a
 * bounded count so an assembly of tessellated parts does not allocate the
 * whole curvature field again just for the legend.
 */
export function autoRangeFromMeshes(meshes: Mesh3D[], kind: CurvatureKind, maxSamplesPerMesh = 20000): [number, number] | null {
  const samples: number[] = []
  for (const mesh of meshes) {
    const values = curvatureForMesh(mesh).values
    const count = values.length / 2
    if (count === 0) continue
    const stride = Math.max(1, Math.ceil(count / maxSamplesPerMesh))
    for (let i = 0; i < count; i += stride) samples.push(values[i * 2 + (kind === 'mean' ? 0 : 1)])
  }
  if (samples.length === 0) return null
  return autoRange(samples)
}

/** The range the shader should paint with: the manual one wins, else auto. */
export function effectiveCurvatureRange(
  manual: [number, number] | null,
  auto: [number, number] | null,
): [number, number] {
  if (manual) return manual
  if (auto && auto[1] > auto[0]) return auto
  return [-1, 1]
}
