// solveAssembly orchestrates the mate solve for an assembly: collects bundles
// per part instance (cache hit or cold rebuild via relay), resolves anchor refs,
// encodes a MateInput byte buffer, calls the Rust mate solver WASM, decodes the
// solved transforms, applies them to the body meshes, and returns the result.
//
// This module runs inside the anchor solver worker (Rust-only, no OCC).
// It is a pure async function over typed-array inputs — no React, no DOM.

import { bundleCacheGet, bundleCacheLatestRev, bundleCachePut } from './bundleCache'
import { migrateBundle } from './partBundle'
import type { PartBundle, BodyMesh, Anchor, AnchorPose, EdgeCurve, EntityAnchorIndex } from './partBundle'
import type { Transform3D, MateKind } from '../types/cad'
import type { RelayService } from './worker/anchorSolverWorker'
import { ASSEMBLY_BUILTIN_ANCHORS, ASSEMBLY_HANDLE } from '../utils/assemblyBuiltins'
import { canonicalPerp } from '../utils/mateOrientation'
import { makeTransform, rotateVector, type Vec3 } from '../utils/transform3d'

export type { AnchorPose }

// ─── Assembly built-in anchors (Stage 6c) ────────────────────────────────
// The assembly's own coordinate frame, referencable by a mate as ground via
// MateRef.part === ASSEMBLY_HANDLE. The frame is pinned at the world origin and
// is never solved, so geom_hash/created_by are unused here — the poses come
// from the same constant the viewport draws its built-in gizmos from.
export const assemblyAnchors: Record<string, Anchor> = Object.fromEntries(
  Object.entries(ASSEMBLY_BUILTIN_ANCHORS).map(
    ([id, a]) => [id, { ...a, geom_hash: '', created_by: '' }],
  ),
)

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
  /** Part handle -> anchor id -> its pose. Assembly built-ins are not here: they
   *  are static and the main thread folds them in (utils/anchorGizmos.ts). */
  anchors: Record<string, Record<string, AnchorPose>>
  mateResults: Record<string, MateResult>
  /** The mate solve failed and every transform below is the placed seed, not a
   *  solution. Set so the editor can say so: a silent seed echo is
   *  indistinguishable from a mate that solved to exactly where it started. */
  solveError?: string
}

export interface MeshPayload {
  vertices: Float32Array
  indices: Uint32Array
  faceIdsPerTriangle: Uint32Array
  edges: EdgeCurve[]  // solved-pose analytic curves; the viewport renders them crisp
  // Anchor ids per picked entity (Stage 7). Ids, not geometry, so the solved
  // transform leaves them untouched: the same entity names the same anchor at
  // every pose. Absent for a bundle cached before Stage 7.
  entityAnchors?: EntityAnchorIndex
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
  torus: 7,
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
//
// Delegates to utils/transform3d.ts rather than carrying a private copy: that
// module already gets this right (makeTransform normalizes, quatToAxisAngle
// normalizes and explains why) and is what the STEP export path already goes
// through. The one place normalization must actually happen is the solve
// boundary below (decodeMateOutput's raw floats -> Transform3D via
// makeTransform); every function here inherits a unit quaternion from that
// single call site and never re-normalizes.

type Pt3 = Vec3

/** Rotate a free vector: a direction takes the rotation but not the translation. */
function rotateVec(v: Pt3, t: Transform3D): Pt3 {
  return rotateVector([t.qx, t.qy, t.qz, t.qw], v)
}

function transformPoint(p: Pt3, t: Transform3D): Pt3 {
  const [rx, ry, rz] = rotateVec(p, t)
  return [rx + t.tx, ry + t.ty, rz + t.tz]
}

/** Quaternion to row-major 3x3 rotation matrix (assumes a unit quaternion). */
function quatToMat3(qx: number, qy: number, qz: number, qw: number): number[] {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz
  const xx = qx * x2, xy = qx * y2, xz = qx * z2
  const yy = qy * y2, yz = qy * z2, zz = qz * z2
  const wx = qw * x2, wy = qw * y2, wz = qw * z2
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ]
}

/**
 * Apply a rigid transform to a flat vertex array. Hoists the rotation matrix
 * once per part instead of running the quaternion sandwich product per
 * vertex: a 100k-vertex part is 100k matrix-vector products instead of
 * 200k+ small-array allocations, on the path a drag pointer-up runs.
 */
function applyTransform(vertices: Float32Array, t: Transform3D): Float32Array {
  const out = new Float32Array(vertices.length)
  const m = quatToMat3(t.qx, t.qy, t.qz, t.qw)
  for (let i = 0; i < vertices.length; i += 3) {
    const vx = vertices[i]
    const vy = vertices[i + 1]
    const vz = vertices[i + 2]
    out[i] = m[0] * vx + m[1] * vy + m[2] * vz + t.tx
    out[i + 1] = m[3] * vx + m[4] * vy + m[5] * vz + t.ty
    out[i + 2] = m[6] * vx + m[7] * vy + m[8] * vz + t.tz
  }
  return out
}

/**
 * Carry a curve into the part's solved pose. Radii and sweep angles are
 * rigid-motion invariant, so only points move and only directions rotate —
 * which is exactly why the curves stay analytic instead of being re-fitted.
 */
function transformEdgeCurve(e: EdgeCurve, t: Transform3D): EdgeCurve {
  return {
    ...e,
    point: transformPoint(e.point, t),
    axis: e.axis ? rotateVec(e.axis, t) : undefined,
    x_axis: e.x_axis ? rotateVec(e.x_axis, t) : undefined,
    endpoints: [transformPoint(e.endpoints[0], t), transformPoint(e.endpoints[1], t)],
    points: e.points?.map(p => transformPoint(p, t)),
  }
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
  /** Radians. Fixed/Sliding's absolute roll target between the anchors'
   *  canonical frames; see mate_residuals.rs abs_roll_residual. */
  angle: number
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
  // mates: n_mates * 76
  const headerSize = 20
  const bodiesSize = bodyCount * 4
  const paramsSize = params.length * 4
  const maskSize = maskLen
  const matesSize = mates.length * 76
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
    w.setFloat32(pos, m.angle, true); pos += 4
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

// `expectedParams` (bodyCount * BPB) is the caller's own body count, not
// anything read from the buffer: a WASM-side bug or a stale worker reply
// could return a params array shorter than the bodies the caller is about to
// index into. Without this check a short buffer reads `undefined` past the
// end of the typed array and produces NaN transforms silently instead of an
// error the caller can fall back from (see the seed-echo catch below).
export function decodeMateOutput(buf: Uint8Array, expectedParams: number): DecodedMateOutput {
  const r = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 0
  if (r.getUint32(pos, true) !== MATE_MAGIC_OUT) throw new Error('bad mate output magic')
  pos += 4
  const nParams = r.getUint32(pos, true); pos += 4
  if (nParams !== expectedParams) {
    throw new Error(`mate output has ${nParams} params, expected ${expectedParams}`)
  }
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
  parts: { handle: string; doc_id: string; doc_rev: number; transform: Transform3D; fixed?: boolean }[],
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
    // `bundleCacheLatestRev` is the Stage F index lookup (one IndexedDB get);
    // it replaces a downward scan that used to issue up to `currentRev - 1`
    // separate `bundleCacheGet` transactions.
    let prevBundle: { anchors: Record<string, Anchor> } | undefined
    const latestCachedRev = await bundleCacheLatestRev(part.doc_id)
    if (latestCachedRev !== undefined && latestCachedRev < currentRev) {
      prevBundle = await bundleCacheGet(part.doc_id, latestCachedRev)
    }
    if (prevBundle) bundle = migrateBundle(prevBundle, bundle)

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
    // A mate needs two different parts. The MateEditor refuses this pick at
    // the click (commitAimToMateField), but a hand-edited YAML can still
    // author it, and if it reaches here unguarded, off_a === off_b makes the
    // Jacobian fillers write both bodies' contributions into the same cell
    // (see mate_residuals.rs) -- LM would descend a fabricated gradient
    // instead of failing loudly. Reject before anchors are even resolved.
    if (mate.ref_a.part === mate.ref_b.part) {
      mateResults[mate.id] = { stale: true, error: 'a mate needs two different parts' }
      continue
    }

    const rA = resolveRef(mate.ref_a)
    const rB = resolveRef(mate.ref_b)
    const staleRefs: ('ref_a' | 'ref_b')[] = []
    if (!rA.anchor) staleRefs.push('ref_a')
    if (!rB.anchor) staleRefs.push('ref_b')
    if (staleRefs.length > 0) {
      mateResults[mate.id] = { stale: true, staleRefs }
      continue
    }

    // An unknown mate/anchor kind (a newer-build document, or a typo in a
    // hand-edited YAML) must not silently coerce into `fixed`/`plane` -- that
    // turned a mismatch into a rigid weld or the wrong tangential formula with
    // no sign anything went wrong. Fail the mate loud and red instead.
    const kindCode = MATE_KIND_TO_U8[mate.kind]
    if (kindCode === undefined) {
      mateResults[mate.id] = { stale: true, error: `unsupported mate kind '${mate.kind}'` }
      continue
    }
    const anchorKindA = ANCHOR_KIND_TO_U8[rA.anchor!.kind]
    const anchorKindB = ANCHOR_KIND_TO_U8[rB.anchor!.kind]
    if (anchorKindA === undefined || anchorKindB === undefined) {
      const badKind = anchorKindA === undefined ? rA.anchor!.kind : rB.anchor!.kind
      mateResults[mate.id] = { stale: true, error: `unsupported anchor kind '${badKind}'` }
      continue
    }

    const offset = typeof mate.offset === 'number' ? mate.offset : 0
    const ratio = typeof mate.ratio === 'number' ? mate.ratio : 1
    const radius = typeof mate.radius === 'number' ? mate.radius : 0
    // angle is authored in degrees in [0, 360) (the mate editor's +/-90 buttons
    // and free-angle box); the Rust side measures roll in radians, the units
    // atan2 returns. No wrap is needed on the way out even though the measured
    // roll lands in (-pi, pi]: abs_roll_residual (mate_residuals.rs) closes with
    // `wrap_to_pi(atan2(sin_r, cos_r) - target)`, so a target and that target
    // plus a full turn give the identical residual. offset is millimetres and
    // passes through unconverted -- do not "fix" this into a degrees-to-radians
    // conversion too.
    const angleDeg = typeof mate.angle === 'number' ? mate.angle : 0
    const angle = angleDeg * (Math.PI / 180)

    mateRecords.push({
      kindCode,
      bodyA: rA.bodyIndex,
      bodyB: rB.bodyIndex,
      anchorKindA,
      anchorKindB,
      pointA: rA.anchor!.point,
      axisA: rA.anchor!.axis,
      pointB: rB.anchor!.point,
      axisB: rB.anchor!.axis,
      flip: !!mate.flip,
      offset,
      ratio,
      radius,
      angle,
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
    // A grounded instance (PartInstance.fixed) is the assembly's static
    // reference frame: pin it out of the moving DOF so mates pull the other
    // parts onto it rather than dragging it off its placed pose.
    if (part.fixed) fixedMask[Math.floor(pi / 8)] |= (1 << (pi % 8))
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
  let solveError: string | undefined

  if (solveMateFn && mateRecords.length > 0) {
    try {
      const outputBytes = solveMateFn(encoded)
      const decoded = decodeMateOutput(outputBytes, paramCount)

      // The boundary: the unit-norm constraint on qx..qw is a SOFT residual
      // (mate_residuals.rs), so the solved quaternion is unit only to within
      // LM's tolerance. makeTransform normalizes here, once, so every
      // downstream consumer (posed anchors, transformed meshes, transformed
      // edge curves) inherits a unit quaternion and never has to again.
      for (let i = 0; i < parts.length; i++) {
        const handle = parts[i].handle
        // A grounded part is echoed from its SEED, bit-exact, never from the
        // solver's output. The ground pin is a soft least-squares residual
        // (mate_residuals.rs), not a hard clamp: it can be outvoted, and the
        // grounded body is in fact the cheapest thing in the system to rotate
        // (rotation_damp_scale leaves grounded bodies at 1.0 while every free
        // body's rotation is damped ROT_DAMP_SCALE = 500x). Even when it holds,
        // it holds only to LM tolerance -- and bakeSolvedTransforms would write
        // that error back into the seed, so the drift ratchets solve after
        // solve. Grounded means grounded: position AND orientation.
        if (parts[i].fixed) {
          transforms[handle] = { ...parts[i].transform }
          continue
        }
        transforms[handle] = makeTransform(
          [
            decoded.paramsSolved[i * BPB + 0],
            decoded.paramsSolved[i * BPB + 1],
            decoded.paramsSolved[i * BPB + 2],
          ],
          [
            decoded.paramsSolved[i * BPB + 3],
            decoded.paramsSolved[i * BPB + 4],
            decoded.paramsSolved[i * BPB + 5],
            decoded.paramsSolved[i * BPB + 6],
          ],
        )
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      // Fall back to seed transforms so the scene still draws, but say so. A
      // WASM trap here is a solver bug, not a modelling one, and the guard used
      // to be `if (!mateResults[mate.id])` -- which never fired, because every
      // solvable mate was already recorded above. The failure was invisible.
      solveError = errMsg
      for (const part of parts) {
        transforms[part.handle] = { ...part.transform }
      }
      for (const mate of mates) {
        mateResults[mate.id] = { ...mateResults[mate.id], error: errMsg }
      }
    }
  } else if (!solveMateFn && mateRecords.length > 0) {
    // No solver, but mates exist: warn so the user knows why mates do nothing.
    // The scene still draws at the placed seeds.
    solveError = 'Mate solver not available.'
    for (const part of parts) {
      transforms[part.handle] = { ...part.transform }
    }
  } else {
    // No solver or no mates: echo the placed transforms
    for (const part of parts) {
      transforms[part.handle] = { ...part.transform }
    }
  }

  // ── Apply transforms to body meshes ───────────────────────────────────

  const transformedBodies: Record<string, MeshPayload[]> = {}
  const posedAnchors: Record<string, Record<string, AnchorPose>> = {}
  for (const part of parts) {
    const t = transforms[part.handle]
    // The anchors travel with the mesh: the solve consumed them at the seed
    // pose, but a gizmo drawn at an un-posed anchor would sit where the part
    // used to be.
    const bundleAnchors = partBundles.get(part.handle)?.anchors ?? {}
    const posed: Record<string, AnchorPose> = {}
    for (const [id, a] of Object.entries(bundleAnchors)) {
      posed[id] = {
        kind: a.kind,
        point: transformPoint(a.point, t),
        axis: rotateVec(a.axis, t),
        // The canonical roll frame, derived from the LOCAL axis then rotated:
        // the editor's mate-authoring capture measures the on-screen roll
        // against this, with the same frame rule the solver measures by.
        x_axis: rotateVec(canonicalPerp(a.axis), t),
      }
    }
    posedAnchors[part.handle] = posed

    const meshes = bodyMeshes.get(part.handle)
    if (!meshes) {
      transformedBodies[part.handle] = []
      continue
    }
    const transformed: MeshPayload[] = meshes.map((m) => ({
      vertices: applyTransform(m.mesh.vertices, t),
      indices: m.mesh.indices,
      faceIdsPerTriangle: m.mesh.faceIdsPerTriangle,
      // `?? []`: a bundle cached before edges existed still solves, it just
      // renders without them. Same fail-safe posture as the sampler's chord.
      edges: (m.edges ?? []).map(e => transformEdgeCurve(e, t)),
      entityAnchors: m.entityAnchors,
    }))
    transformedBodies[part.handle] = transformed
  }

  return { transforms, bodies: transformedBodies, anchors: posedAnchors, mateResults, solveError }
}
