// Binary STL writer. Pure: indexed triangle soup in, bytes out. No OCC, no DOM.
//
// Two callers with very different inputs share it. The part export tessellates a
// TopoDS shape and writes that (`occ/stepIo.ts`). The assembly export writes the
// bundle meshes straight out of the solved response; those are already in world
// pose, so an assembly STL costs no rebuild and never loads OCC at all.
//
// Layout: 80-byte header + uint32 triangle count + 50 bytes per triangle
// (12B normal, 3 x 12B vertex, 2B attribute). The normal is recomputed from the
// winding rather than carried in, because that is the only thing a consumer can
// rely on across writers.

/** One indexed mesh: flat xyz vertices, flat triangle corner indices. */
export interface StlMesh {
  vertices: ArrayLike<number>
  indices: ArrayLike<number>
}

const HEADER_BYTES = 84  // 80B comment header + 4B triangle count
const TRI_BYTES = 50

/** Triangles in `meshes`, ignoring any trailing indices that do not form one. */
export function stlTriangleCount(meshes: StlMesh[]): number {
  let n = 0
  for (const m of meshes) n += Math.floor(m.indices.length / 3)
  return n
}

/** Serialise the meshes as one binary STL solid (STL has no concept of parts). */
export function encodeBinaryStl(meshes: StlMesh[]): Uint8Array {
  const triCount = stlTriangleCount(meshes)
  const buf = new ArrayBuffer(HEADER_BYTES + triCount * TRI_BYTES)
  const view = new DataView(buf)
  view.setUint32(80, triCount, true)  // little-endian, per the format

  let offset = HEADER_BYTES
  for (const mesh of meshes) {
    const { vertices, indices } = mesh
    const corners = Math.floor(indices.length / 3) * 3
    for (let i = 0; i < corners; i += 3) {
      const a = indices[i] * 3
      const b = indices[i + 1] * 3
      const c = indices[i + 2] * 3
      const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2]
      const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2]
      const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2]

      const ux = bx - ax, uy = by - ay, uz = bz - az
      const vx = cx - ax, vy = cy - ay, vz = cz - az
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      // A degenerate triangle has no normal; write a zero-length one rather than
      // NaN, which readers reject outright.
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1

      view.setFloat32(offset, nx / len, true)
      view.setFloat32(offset + 4, ny / len, true)
      view.setFloat32(offset + 8, nz / len, true)
      view.setFloat32(offset + 12, ax, true)
      view.setFloat32(offset + 16, ay, true)
      view.setFloat32(offset + 20, az, true)
      view.setFloat32(offset + 24, bx, true)
      view.setFloat32(offset + 28, by, true)
      view.setFloat32(offset + 32, bz, true)
      view.setFloat32(offset + 36, cx, true)
      view.setFloat32(offset + 40, cy, true)
      view.setFloat32(offset + 44, cz, true)
      view.setUint16(offset + 48, 0, true)  // attribute byte count
      offset += TRI_BYTES
    }
  }
  return new Uint8Array(buf)
}
