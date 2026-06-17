// STEP read/write adapter for the import_step leaf (phase 2f/3). Import writes
// the STEP bytes to the emscripten in-memory FS, reads them with
// STEPControl_Reader, and applies an optional uniform scale. Export writes a
// shape to the FS with STEPControl_Writer and reads the resulting bytes back.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { makeScaleTrsf, transformCopy } from './transforms'
import { readShapeFaces, assembleMesh } from './tessellation'

// A fixed short scratch path in the emscripten MEMFS. Two quirks of this OCC.js
// build forced both choices: STEPControl_Reader fails (RetError) on a long
// basename OR any path containing the substring "import", so the name is short
// and neutral. The kernel is single-threaded and each call writes -> reads ->
// unlinks synchronously, so reusing one path across calls is safe.
const SCRATCH_PATH = '/s.step'

/** Decode a base64 string to bytes (portable across Node + browser/Worker). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Read STEP bytes into a shape, optionally scaled about the origin (mirrors
 * `step_file_to_shape`). The returned shape lives in `scope`; the caller owns it.
 */
export function stepBytesToShape(
  oc: OccModule,
  scope: DisposeScope,
  bytes: Uint8Array,
  scale = 1.0,
): OccShape {
  const path = SCRATCH_PATH
  oc.FS.writeFile(path, bytes)
  try {
    const reader = scope.track(new oc.STEPControl_Reader_1())
    const status = reader.ReadFile(path)
    // ReadFile may return a raw enum number or an embind enum object (.value).
    const enumVal = (e: unknown): number => (typeof e === 'number' ? e : (e as { value: number }).value)
    const statusVal = enumVal(status)
    const doneVal = enumVal(oc.IFSelect_ReturnStatus.IFSelect_RetDone)
    if (statusVal !== doneVal) {
      throw new Error(`import_step: STEP read failed (status ${statusVal})`)
    }
    reader.TransferRoots()
    const shape = reader.OneShape()
    if (scale !== 1.0) {
      return transformCopy(oc, scope, shape, makeScaleTrsf(oc, scope, [0, 0, 0], scale))
    }
    return shape
  } finally {
    try {
      oc.FS.unlink(path)
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Serialise a shape to STEP bytes (mirrors Python `_serialise_step`).
 * Uses the emscripten MEMFS: writes to a scratch path, then reads it back.
 * The caller owns the scope; the returned bytes are a standalone copy.
 */
export function stepShapeToBytes(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): Uint8Array {
  const path = SCRATCH_PATH
  const writer = scope.track(new oc.STEPControl_Writer_1())
  const wStatus = writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true)
  if ((wStatus as { value: number }).value !== 1) {
    throw new Error('STEP export: Transfer failed')
  }
  const wrote = writer.Write(path)
  if ((wrote as { value: number }).value !== 1) {
    throw new Error('STEP export: Write failed')
  }
  const text = oc.FS.readFile(path, { encoding: 'utf8' })
  try {
    oc.FS.unlink(path)
  } catch {
    // best-effort cleanup
  }
  const enc = new TextEncoder()
  return enc.encode(text)
}

/**
 * Serialise a shape to binary STL bytes directly from its tessellation.
 * Binary STL format: 80-byte header + 4-byte triangle count (uint32 LE) +
 * 50 bytes per triangle (12B normal + 12B v1 + 12B v2 + 12B v3 + 2B attr).
 *
 * This avoids StlAPI_Writer which does not integrate with the emscripten
 * MEMFS in this OCC.js build.
 */
export function shapeToStlBytes(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  deflection = 0.1,
  angularDeflection = 0.1,
): Uint8Array {
  scope.track(new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, angularDeflection, false))
  const raw = readShapeFaces(oc, scope, shape, deflection, angularDeflection)
  const mesh = assembleMesh(raw)

  const { vertices, faces } = mesh
  const triCount = faces.length
  // 80B header + 4B count + 50B per triangle
  const buf = new ArrayBuffer(84 + triCount * 50)
  const view = new DataView(buf)
  // 80-byte header (all zeros is fine)
  view.setUint32(80, triCount, true) // little-endian triangle count

  let offset = 84
  for (const face of faces) {
    if (face.length < 3) continue
    const v0 = vertices[face[0]]
    const v1 = vertices[face[1]]
    const v2 = vertices[face[2]]
    // Compute face normal via cross product
    const ux = v1[0] - v0[0], uy = v1[1] - v0[1], uz = v1[2] - v0[2]
    const vx = v2[0] - v0[0], vy = v2[1] - v0[1], vz = v2[2] - v0[2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    view.setFloat32(offset, nx / len, true)
    view.setFloat32(offset + 4, ny / len, true)
    view.setFloat32(offset + 8, nz / len, true)
    // v1
    view.setFloat32(offset + 12, v0[0], true)
    view.setFloat32(offset + 16, v0[1], true)
    view.setFloat32(offset + 20, v0[2], true)
    // v2
    view.setFloat32(offset + 24, v1[0], true)
    view.setFloat32(offset + 28, v1[1], true)
    view.setFloat32(offset + 32, v1[2], true)
    // v3
    view.setFloat32(offset + 36, v2[0], true)
    view.setFloat32(offset + 40, v2[1], true)
    view.setFloat32(offset + 44, v2[2], true)
    // attribute byte count (0)
    view.setUint16(offset + 48, 0, true)
    offset += 50
  }
  return new Uint8Array(buf)
}
