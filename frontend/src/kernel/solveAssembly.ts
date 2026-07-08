// solveAssembly orchestrates the mate solve for an assembly: collects bundles
// per part instance (cache hit or cold rebuild via relay), resolves anchor refs,
// encodes a MateInput byte buffer, calls the Rust mate solver WASM, decodes the
// solved transforms, applies them to the body meshes, and returns the result.
//
// This module runs inside the anchor solver worker (Rust-only, no OCC).
// It is a pure async function over typed-array inputs — no React, no DOM.

import { bundleCacheGet, bundleCachePut } from './bundleCache'
import { migrateAnchors } from './partBundle'
import type { PartBundle, BodyMesh, Anchor } from './partBundle'
import type { Transform3D, MateKind } from '../types/cad'
import type { RelayService } from './worker/anchorSolverWorker'
import {
  ASSEMBLY_HANDLE,
  ASSEMBLY_ORIGIN_ID,
  ASSEMBLY_TOP_ID,
  ASSEMBLY_FRONT_ID,
  ASSEMBLY_RIGHT_ID,
} from '../utils/builtins'

// ─── Assembly built-in anchors (Stage 6c) ────────────────────────────────
// The assembly's own coordinate frame, referencable by a mate as ground via
// MateRef.part === ASSEMBLY_HANDLE. Normals follow the part-editor
// Top/Front/Right convention (Viewport index.tsx:603-605): Front normal +Z,
// Top normal +Y, Right normal +X. The frame is pinned at the world origin and
// is never solved, so geom_hash/created_by are unused here.
export const assemblyAnchors: Record<string, Anchor> = {
  [ASSEMBLY_ORIGIN_ID]: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '', created_by: '' },
  [ASSEMBLY_TOP_ID]:    { kind: 'plane', point: [0, 0, 0], axis: [0, 1, 0], geom_hash: '', created_by: '' },
  [ASSEMBLY_FRONT_ID]:  { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '', created_by: '' },
  [ASSEMBLY_RIGHT_ID]:  { kind: 'plane', point: [0, 0, 0], axis: [1, 0, 0], geom_hash: '', created_by: '' },
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface MateSpec {
  id: string
  kind: MateKind | string
  ref_a: { part: string; anchor: string }
  ref_b: { part: string; anchor: string }
  flip?: boolean
  offset?: number
  ratio?: number
  radius?: number
  angle?: number
}

export interface MateResult {
  stale?: boolean
  staleRefs?: ('ref_a' | 'ref_b')[]
  error?: string
}

export interface AssemblyBuildResponse {
  transforms: Record<string, Transform3D>
  bodies: Record<string, MeshPayload[]>
  mateResults: Record<string, MateResult>
}

export interface MeshPayload {
  vertices: Float32Array
  indices: Uint32Array
  faceIdsPerTriangle: Uint32Array
}

// ─── Anchor kind mapping (TS → Rust u8) ──────────────────────────────────

const ANCHOR_KIND_TO_U8: Record<string, number> = {
  plane: 0,
  cylinder: 1,
  sphere: 2,
  cone: 3,
  line: 4,
  circle: 5,
  point: 6,
  torus: 0,  // no dedicated Rust variant, fall back to plane
}

// ─── Mate kind mapping (TS → Rust u8) ────────────────────────────────────

const MATE_KIND_TO_U8: Record<string, number> = {
  fixed: 0,
  spherical: 1,
  parallel: 2,
  sliding: 3,
  rotating: 4,
  sliding_rotating: 5,
  tangential: 6,
  copy_rotation: 7,
  parallel_plane_distance: 8,
}

const MATE_MAGIC = 0x5331_544D // "MTS1"
const MATE_MAGIC_OUT = 0x5231_544D // "MTR1"
const BPB = 7  // bytes per body (tx,ty,tz,qx,qy,qz,qw) = 7 f32s = 28 bytes

// ─── Quaternion math for transform application ───────────────────────────

function qMul(
  a1: number, a2: number, a3: number, a4: number,
  b1: number, b2: number, b3: number, b4: number,
): [number, number, number, number] {
  return [
    a4 * b1 + a1 * b4 + a2 * b3 - a3 * b2,
    a4 * b2 - a1 * b3 + a2 * b4 + a3 * b1,
    a4 * b3 + a1 * b2 - a2 * b1 + a3 * b4,
    a4 * b4 - a1 * b1 - a2 * b2 - a3 * b3,
  ]
}

function qInv(qx: number, qy: number, qz: number, qw: number): [number, number, number, number] {
  return [-qx, -qy, -qz, qw]
}

function applyTransform(vertices: Float32Array, t: Transform3D): Float32Array {
  const out = new Float32Array(vertices.length)
  const qi = qInv(t.qx, t.qy, t.qz, t.qw)
  for (let i = 0; i < vertices.length; i += 3) {
    const vx = vertices[i]
    const vy = vertices[i + 1]
    const vz = vertices[i + 2]
    // rotated = q * v * q⁻¹
    const [rx, ry, rz] = qMul(
      ...qMul(t.qx, t.qy, t.qz, t.qw, vx, vy, vz, 0),
      qi[0], qi[1], qi[2], qi[3],
    )
    out[i] = rx + t.tx
    out[i + 1] = ry + t.ty
    out[i + 2] = rz + t.tz
  }
  return out
}

// ─── Mate input byte encoding ────────────────────────────────────────────

export interface MateWireRecord {
  kindCode: number
  bodyA: number
  bodyB: number
  anchorKindA: number
  anchorKindB: number
  pointA: [number, number, number]
  axisA: [number, number, number]
  pointB: [number, number, number]
  axisB: [number, number, number]
  flip: boolean
  offset: number
  ratio: number
  radius: number
}

function pinnedMaskBytes(nBodies: number): number {
  return Math.ceil(nBodies / 8)
}

export function encodeMateInput(
  bodyCount: number,
  params: Float32Array,       // 7 * bodyCount
  fixedMask: Uint8Array,       // ceil(bodyCount/8) bytes
  mates: MateWireRecord[],
): Uint8Array {
  const maskLen = pinnedMaskBytes(bodyCount)
  // header: magic(4) + n_bodies(4) + n_params(4) + n_mates(4) + n_fixed(4) = 20
  // bodies: n_bodies * 4
  // params: bodyCount * 7 * 4
  // fixedMask: maskLen
  // mates: n_mates * 72
  const headerSize = 20
  const bodiesSize = bodyCount * 4
  const paramsSize = params.length * 4
  const maskSize = maskLen
  const matesSize = mates.length * 72
  const total = headerSize + bodiesSize + paramsSize + maskSize + matesSize

  const buf = new ArrayBuffer(total)
  const w = new DataView(buf)
  let pos = 0

  w.setUint32(pos, MATE_MAGIC, true); pos += 4
  w.setUint32(pos, bodyCount, true); pos += 4
  w.setUint32(pos, params.length, true); pos += 4
  w.setUint32(pos, mates.length, true); pos += 4
  w.setUint32(pos, 0, true); pos += 4  // n_fixed_bodies (informational)

  for (let i = 0; i < bodyCount; i++) {
    w.setUint32(pos, i, true); pos += 4
  }

  for (let i = 0; i < params.length; i++) {
    w.setFloat32(pos, params[i], true); pos += 4
  }

  for (let i = 0; i < maskLen; i++) {
    w.setUint8(pos, fixedMask[i] || 0); pos += 1
  }

  for (const m of mates) {
    w.setUint8(pos, m.kindCode); pos += 1
    w.setUint32(pos, m.bodyA, true); pos += 4
    w.setUint32(pos, m.bodyB, true); pos += 4
    w.setUint8(pos, m.anchorKindA); pos += 1
    w.setUint8(pos, m.anchorKindB); pos += 1
    w.setFloat32(pos, m.pointA[0], true); pos += 4
    w.setFloat32(pos, m.pointA[1], true); pos += 4
    w.setFloat32(pos, m.pointA[2], true); pos += 4
    w.setFloat32(pos, m.axisA[0], true); pos += 4
    w.setFloat32(pos, m.axisA[1], true); pos += 4
    w.setFloat32(pos, m.axisA[2], true); pos += 4
    w.setFloat32(pos, m.pointB[0], true); pos += 4
    w.setFloat32(pos, m.pointB[1], true); pos += 4
    w.setFloat32(pos, m.pointB[2], true); pos += 4
    w.setFloat32(pos, m.axisB[0], true); pos += 4
    w.setFloat32(pos, m.axisB[1], true); pos += 4
    w.setFloat32(pos, m.axisB[2], true); pos += 4
    const flags = m.flip ? 1 : 0
    w.setUint8(pos, flags); pos += 1
    w.setFloat32(pos, m.offset, true); pos += 4
    w.setFloat32(pos, m.ratio, true); pos += 4
    w.setFloat32(pos, m.radius, true); pos += 4
  }

  return new Uint8Array(buf)
}

interface DecodedMateOutput {
  paramsSolved: Float32Array
  overallStatus: number
  residualNorm: number
  rank: number
  dof: number
  iters: number
  ms: number
}

export function decodeMateOutput(buf: Uint8Array): DecodedMateOutput {
  const r = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 0
  if (r.getUint32(pos, true) !== MATE_MAGIC_OUT) throw new Error('bad mate output magic')
  pos += 4
  const nParams = r.getUint32(pos, true); pos += 4
  const overallStatus = r.getUint8(pos); pos += 1
  const paramsSolved = new Float32Array(nParams)
  for (let i = 0; i < nParams; i++) {
    paramsSolved[i] = r.getFloat32(pos, true); pos += 4
  }
  const residualNorm = r.getFloat64(pos, true); pos += 8
  const rank = r.getUint32(pos, true); pos += 4
  const dof = r.getUint32(pos, true); pos += 4
  const iters = r.getUint32(pos, true); pos += 4
  const ms = r.getFloat64(pos, true); pos += 8
  return { paramsSolved, overallStatus, residualNorm, rank, dof, iters, ms }
}

// ─── Main orchestration ───────────────────────────────────────────────────

export async function solveAssembly(
  parts: { handle: string; doc_id: string; doc_rev: number; transform: Transform3D }[],
  revs: Record<string, number>,
  mates: MateSpec[],
  relay: RelayService,
  solveMateFn: ((input: Uint8Array) => Uint8Array) | null,
): Promise<AssemblyBuildResponse> {
  const partBundles = new Map<string, { bundle: PartBundle; anchors: Record<string, Anchor> }>()
  const bodyMeshes = new Map<string, BodyMesh[]>()  // keyed by part handle
  let handleIndex = 0
  const handleToIndex = new Map<string, number>()

  for (const part of parts) {
    handleToIndex.set(part.handle, handleIndex)
    const currentRev = revs[part.doc_id] ?? part.doc_rev

    // Path 1: cache hit
    let bundle = await bundleCacheGet(part.doc_id, currentRev)
    if (bundle) {
      partBundles.set(part.handle, { bundle, anchors: bundle.anchors })
      bodyMeshes.set(part.handle, bundle.bodies)
      handleIndex++
      continue
    }

    // Path 2: cache miss — request part doc, build bundle, migrate, cache
    const partDoc = await relay.requestPartDoc(part.doc_id)
    const buildResult = await relay.requestBuildBundle(part.doc_id, currentRev, partDoc)
    bundle = buildResult as PartBundle
    if (!bundle || !bundle.anchors) {
      throw new Error(`bundle build failed for ${part.doc_id} rev ${currentRev}`)
    }

    // Migrate anchors against the newest prior cached bundle of the same doc.
    // Walk revs downward; the newest one holds the most recent id lineage.
    let prevBundle: { anchors: Record<string, Anchor> } | undefined
    for (let r = currentRev - 1; r >= 1; r--) {
      prevBundle = await bundleCacheGet(part.doc_id, r)
      if (prevBundle) break
    }
    if (prevBundle) {
      const migrated = migrateAnchors(prevBundle, { anchors: bundle.anchors })
      bundle = { ...bundle, anchors: migrated }
    }

    await bundleCachePut(bundle)
    partBundles.set(part.handle, { bundle, anchors: bundle.anchors })
    bodyMeshes.set(part.handle, bundle.bodies)
    handleIndex++
  }

  // The assembly frame is a synthetic body pinned at identity, allocated only
  // when a mate references it (MateRef.part === ASSEMBLY_HANDLE). It grounds
  // mates that fasten a part to the assembly's own origin/planes; its solved
  // transform is discarded (it never moves and has no mesh).
  const usesAssemblyFrame = mates.some(
    m => m.ref_a.part === ASSEMBLY_HANDLE || m.ref_b.part === ASSEMBLY_HANDLE,
  )
  const assemblyBodyIndex = usesAssemblyFrame ? handleIndex : -1
  if (usesAssemblyFrame) {
    handleToIndex.set(ASSEMBLY_HANDLE, handleIndex)
    handleIndex++
  }

  // ── Resolve mate anchors & build mate records ────────────────────────

  const mateResults: Record<string, MateResult> = {}
  const mateRecords: MateWireRecord[] = []
  const bodyCount = handleIndex  // parts + optional assembly frame

  // Resolve a mate ref to its anchor + solver body index. ASSEMBLY_HANDLE routes
  // to the static assembly-frame anchors; any other handle routes to that part
  // instance's bundle. A missing bundle or missing anchor yields undefined,
  // which the caller flags as a stale ref (fail-safe over fail-wrong).
  const resolveRef = (ref: { part: string; anchor: string }): { anchor: Anchor | undefined; bodyIndex: number } => {
    if (ref.part === ASSEMBLY_HANDLE) {
      return { anchor: assemblyAnchors[ref.anchor], bodyIndex: assemblyBodyIndex }
    }
    const b = partBundles.get(ref.part)
    return { anchor: b?.anchors[ref.anchor], bodyIndex: handleToIndex.get(ref.part) ?? -1 }
  }

  for (const mate of mates) {
    const rA = resolveRef(mate.ref_a)
    const rB = resolveRef(mate.ref_b)
    const staleRefs: ('ref_a' | 'ref_b')[] = []
    if (!rA.anchor) staleRefs.push('ref_a')
    if (!rB.anchor) staleRefs.push('ref_b')
    if (staleRefs.length > 0) {
      mateResults[mate.id] = { stale: true, staleRefs }
      continue
    }

    const offset = typeof mate.offset === 'number' ? mate.offset : 0
    const ratio = typeof mate.ratio === 'number' ? mate.ratio : 1
    const radius = typeof mate.radius === 'number' ? mate.radius : 0

    mateRecords.push({
      kindCode: MATE_KIND_TO_U8[mate.kind] ?? 0,
      bodyA: rA.bodyIndex,
      bodyB: rB.bodyIndex,
      anchorKindA: ANCHOR_KIND_TO_U8[rA.anchor!.kind] ?? 0,
      anchorKindB: ANCHOR_KIND_TO_U8[rB.anchor!.kind] ?? 0,
      pointA: rA.anchor!.point,
      axisA: rA.anchor!.axis,
      pointB: rB.anchor!.point,
      axisB: rB.anchor!.axis,
      flip: !!mate.flip,
      offset,
      ratio,
      radius,
    })
    mateResults[mate.id] = { stale: false }
  }

  // ── Call the Rust mate solver ─────────────────────────────────────────

  const paramCount = bodyCount * BPB
  const paramsInitial = new Float32Array(paramCount)
  const fixedMaskLen = pinnedMaskBytes(bodyCount)
  const fixedMask = new Uint8Array(fixedMaskLen)

  // Read part transforms + fixed mask from parts (not bundles).
  // Use a second pass over the part specs for clarity.
  let pi = 0
  for (const part of parts) {
    const t = part.transform
    paramsInitial[pi * BPB + 0] = t.tx
    paramsInitial[pi * BPB + 1] = t.ty
    paramsInitial[pi * BPB + 2] = t.tz
    paramsInitial[pi * BPB + 3] = t.qx
    paramsInitial[pi * BPB + 4] = t.qy
    paramsInitial[pi * BPB + 5] = t.qz
    paramsInitial[pi * BPB + 6] = t.qw
    // Parts are not flagged as "fixed" at this level; the fixed mask
    // comes from the PartInstance.fixed property in the full AssemblyDoc
    // (not yet wired). For Stage 5b all parts are free.
    pi++
  }

  // The assembly frame sits at identity and is pinned (grounded): its quaternion
  // is the identity (qw = 1; the rest stay zero from Float32Array init) and its
  // fixed-mask bit is set so the solver excludes it from the moving DOF.
  if (usesAssemblyFrame) {
    paramsInitial[assemblyBodyIndex * BPB + 6] = 1
    fixedMask[Math.floor(assemblyBodyIndex / 8)] |= (1 << (assemblyBodyIndex % 8))
  }

  const transforms: Record<string, Transform3D> = {}
  const encoded = encodeMateInput(bodyCount, paramsInitial, fixedMask, mateRecords)

  if (solveMateFn && mateRecords.length > 0) {
    try {
      const outputBytes = solveMateFn(encoded)
      const decoded = decodeMateOutput(outputBytes)

      for (let i = 0; i < parts.length; i++) {
        const handle = parts[i].handle
        transforms[handle] = {
          tx: decoded.paramsSolved[i * BPB + 0],
          ty: decoded.paramsSolved[i * BPB + 1],
          tz: decoded.paramsSolved[i * BPB + 2],
          qx: decoded.paramsSolved[i * BPB + 3],
          qy: decoded.paramsSolved[i * BPB + 4],
          qz: decoded.paramsSolved[i * BPB + 5],
          qw: decoded.paramsSolved[i * BPB + 6],
        }
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      // Fall back to seed transforms on solve failure
      for (const part of parts) {
        transforms[part.handle] = { ...part.transform }
      }
      for (const mate of mates) {
        if (!mateResults[mate.id]) {
          mateResults[mate.id] = { stale: false, error: errMsg }
        }
      }
    }
  } else {
    // No solver or no mates: echo the placed transforms
    for (const part of parts) {
      transforms[part.handle] = { ...part.transform }
    }
  }

  // ── Apply transforms to body meshes ───────────────────────────────────

  const transformedBodies: Record<string, MeshPayload[]> = {}
  for (const part of parts) {
    const meshes = bodyMeshes.get(part.handle)
    if (!meshes) {
      transformedBodies[part.handle] = []
      continue
    }
    const t = transforms[part.handle]
    const transformed: MeshPayload[] = meshes.map((m) => ({
      vertices: applyTransform(m.mesh.vertices, t),
      indices: m.mesh.indices,
      faceIdsPerTriangle: m.mesh.faceIdsPerTriangle,
    }))
    transformedBodies[part.handle] = transformed
  }

  return { transforms, bodies: transformedBodies, mateResults }
}
