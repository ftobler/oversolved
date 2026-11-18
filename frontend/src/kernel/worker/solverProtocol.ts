/**
 * Wire types for the solver Worker. Kept dependency-free so the main-thread
 * client can import them without pulling the Worker engine (OCC.js, builder)
 * into the main bundle.
 *
 * The Worker hosts the solve engine and its un-serializable state (OCC module,
 * HandleTable, last BuildState). Only plain, structured-cloneable data crosses
 * `postMessage`: the request payload in, and the BuildResponse *minus*
 * `_build_state` out. `_build_state` holds OCC handle indices that mean nothing
 * on the main thread; it stays Worker-side as the cross-solve checkpoint cache.
 */

import type { RebuildValidation } from '../builder'
import type { PartBundle } from '../partBundle'
import type { TessellationPreset } from '../tessellationPresets'
import type { Transform3D, MateAnchorDescriptor } from '../../types/cad'
import type { Vec3 } from '../../utils/vec3'
import type { MateSpec, AssemblySolveStatus, MeshPayload, AnchorPose } from '../solveAssembly'
import type { OccLoadProgress } from '../occ/loadProgress'

/**
 * Import file bytes by registry id. The main thread resolves ids to bytes; the
 * Worker copies them (they are not transferred) into a per-generation cache and
 * hands them to the kernel. Never carried through the anchor solver worker:
 * that worker holds references only, and the main thread resolves at the point
 * it relays a bundle build to the OCC worker.
 */
export type FileBytes = Record<string, Uint8Array>

/** Solve options that survive a structured clone (the OCC-free subset). */
export interface SolveRequestOptions {
  pickBoundary?: number | null
  rollbackPosition?: number | null
  validate?: boolean
  bypassCache?: boolean
}

export interface SolveRequest {
  id: number
  kind?: 'solve'
  spec: Record<string, unknown>
  options: SolveRequestOptions
  files?: FileBytes
}

/**
 * Error reported for a solve request that a newer solve flushed out of the
 * Worker queue before it ever ran. Not a document failure: its result was
 * already obsolete, so the UI drops it silently instead of showing it.
 */
export const SUPERSEDED_ERROR = 'solve superseded'

/** Build a PartBundle from a PartDoc spec Worker-side. */
export interface BundleRequest {
  id: number
  kind: 'buildBundle'
  spec: Record<string, unknown>
  doc_id: string
  content_hash: string
  files?: FileBytes
}

/** Export options that survive a structured clone. */
export interface ExportRequestOptions {
  format: 'step' | 'stl'
  // Export this one body; null/omitted exports the whole document.
  bodyId?: string | null
  // Export a chosen subset of bodies (the document's selected parts). A
  // non-empty list takes precedence over `bodyId`, and the bodies are
  // compounded into one file so a consolidated export still holds them all.
  bodyIds?: string[] | null
  // STL only: the mesh quality the dialog chose. The worker resolves the name
  // through tessellationPresets; STEP ignores it.
  tessellation?: TessellationPreset
}

/** Build a document Worker-side and serialise it to STEP/STL bytes. */
export interface ExportRequest {
  id: number
  kind: 'export'
  spec: Record<string, unknown>
  options: ExportRequestOptions
  files?: FileBytes
}

/** One part instance of an assembly export: its PartDoc spec + solved placement. */
export interface AssemblyExportPartSpec {
  spec: Record<string, unknown>
  transform: Transform3D
}

/**
 * Build every part of an assembly Worker-side, place it, and serialise the
 * union. Routed to the OCC bundle-builder worker because the anchor solver holds
 * meshes only and cannot rehydrate B-rep. The body filters are meaningless here
 * and ignored: each request carries only the instances it should export.
 */
export interface ExportAssemblyRequest {
  id: number
  kind: 'exportAssembly'
  parts: AssemblyExportPartSpec[]
  options: ExportRequestOptions
  // Shared across every part: one file referenced by N instances crosses once.
  files?: FileBytes
}

/** Either request the Worker can receive; discriminated by `kind`. */
export type WorkerRequest = SolveRequest | ExportRequest | BundleRequest | ExportAssemblyRequest | MeasureRequest

// ─── measurement (measure-auto-readout's kernel cells) ───
// A readout is view state, not a document write: the request names the solve
// generation it was asked against, so a reply can never describe geometry the
// pick was not made on.

/** One pick a measure request names: a body element by its render index, or a
 *  whole body. The id keys the body store of the set the request names. */
export type MeasurePickRef =
  | { bodyId: string; kind: 'face' | 'edge' | 'vertex'; index: number }
  | { bodyId: string; kind: 'body' }

export type MeasureOp = 'length' | 'distance' | 'clearance' | 'area' | 'volume'

/** One secondary readout a kernel reply carries beside its primary value: a
 *  body volume's surface area. Same shape the analytic extras use, so the HUD
 *  formats both through one function. */
export interface MeasureExtra {
  kind: 'length' | 'distance' | 'angle' | 'diameter' | 'radius' | 'area' | 'volume'
  value: number
  label: string
}

/** Which body set of the solve a pick was made against: the final bodies, or
 *  the pick-boundary checkpoint an open feature edit renders. */
export type MeasureSet = 'final' | 'pick'

export interface MeasureRequest {
  id: number
  kind: 'measure'
  // The solve that produced the picks (`<bootId>:<n>`), refused when it is not
  // the generation the Worker still holds.
  generation: string
  set: MeasureSet
  op: MeasureOp
  // One pick for `length`, two otherwise.
  picks: MeasurePickRef[]
}

export interface MeasureOkResponse {
  id: number
  ok: true
  // Document units, the same units the shapes are in.
  value: number
  // Secondary readouts, in the order the caller should render them.
  extra?: MeasureExtra[]
  // The witness points for a distance or a clearance, in world coordinates.
  points?: [Vec3, Vec3]
  // Why a clearance reads 0: the bodies overlap, or they share a face.
  note?: 'overlapping' | 'touching'
}

export type MeasureResponse = MeasureOkResponse | WorkerErrResponse

/** A measure a newer measure or a new solve flushed out of the queue. */
export const MEASURE_SUPERSEDED = 'measure superseded'
/** The named generation is not the one the Worker holds any more. */
export const MEASURE_STALE = 'measure stale'
/** The body or the element index does not resolve in the named set. */
export const MEASURE_UNRESOLVED = 'measure unresolved'

/** Shared error arm for every Worker response (solve and export alike). */
export interface WorkerErrResponse {
  id: number
  ok: false
  error: string
}

export interface ExportOkResponse {
  id: number
  ok: true
  // `null` mirrors exportLocally returning null (OCC.js absent / no body).
  bytes: Uint8Array | null
}

export type ExportResponse = ExportOkResponse | WorkerErrResponse

/** Bundle response carries the mesh + edge payloads. Anchors are populated
 *  deterministically from entity descriptor tokens; the dict is empty only when
 *  no entity carries a token. */
export interface BundleOkResponse {
  id: number
  ok: true
  payload: PartBundle
}

export type BundleResponse = BundleOkResponse | WorkerErrResponse

/** A BuildResponse with the Worker-only `_build_state` removed. */
export interface SolvePayload {
  solve_ms: number
  result: Record<string, unknown>
  bodies: Record<string, unknown>
  pick_bodies?: Record<string, unknown>
  _validation?: RebuildValidation
  /** The Worker's solve generation (`<bootId>:<n>`): the token a measure
   *  request names. Optional only so a payload from before the field existed
   *  still types; the Worker always stamps it. */
  generation?: string
}

export interface SolveOkResponse {
  id: number
  ok: true
  // `null` mirrors solveLocally returning null (OCC.js unavailable).
  payload: SolvePayload | null
}

export type SolveResponse = SolveOkResponse | WorkerErrResponse

/**
 * An OCC load progress update from the Worker. Carries no request id: it is
 * not a reply, it is a state broadcast, and the main thread applies it to the
 * same [[OccLoadProgress]] store the loaders write.
 */
export interface OccProgressMessage {
  kind: 'occProgress'
  progress: OccLoadProgress
}

/**
 * The running build is about to solve `featureId` (featureProgress.ts). Like
 * OccProgressMessage it is a broadcast, not a reply: the Actor runs one job at
 * a time, so a mark always belongs to the job in flight, and the client keeps
 * the last one to name the feature if it has to give up on the solve.
 */
export interface FeatureProgressMessage {
  kind: 'featureProgress'
  featureId: string
}

/**
 * Broadcast once the solver worker has finished preloading its wasm (OCC + the
 * sketch solver). Carries no request id: it is a state broadcast, not a reply.
 */
export interface KernelReadyMessage {
  kind: 'kernelReady'
}

/** Every message the solver Worker sends to the main thread. */
export type SolverWorkerMessage =
  | SolveResponse | ExportResponse | BundleResponse | MeasureResponse
  | OccProgressMessage | FeatureProgressMessage | KernelReadyMessage

// ─── assembly protocol ───
// Messages between the main thread and the Rust-only anchor solver worker.
// The anchor solver sees no OCC, no solveLocally, no HandleTable; it solves
// over anchors extracted from PartBundles. The main thread relays bundle
// build requests to the OCC bundle-builder worker and fetches PartDoc
// content from the document store.

/** A single part reference in a solveAssembly request. */
export interface PartInputSpec {
  handle: string
  doc_id: string
  transform: Transform3D
  /** The instance-level fixed flag, not a fixed mate: the transform is pinned
   *  and excluded from the LM state. */
  fixed?: boolean
}

/** Sent from the main thread to the anchor solver worker to solve an assembly. */
export interface SolveAssemblyRequest {
  id: number
  kind: 'solveAssembly'
  assemblyId: string
  parts: PartInputSpec[]
  /** Per part doc_id, the content hash the bundle cache keys on. A missing
   *  entry bypasses the cache for that part. */
  hashes: Record<string, string>
  mates: MateSpec[]
  /** True for a live drag tick. The worker routes it to the live WASM entry
   *  point, which skips the dense rank/dof SVD the drag path discards. */
  live?: boolean
}

/** Successful assembly solve response from the anchor solver worker. */
export interface AssemblySolveOkResponse {
  id: number
  kind: 'solveAssembly'
  ok: true
  payload: {
    transforms: Record<string, Transform3D>
    /** Handles whose pose the solve moved from its seed. Optional only so
     *  test doubles and older reply shapes can omit it; the current worker
     *  always sets it. */
    movedParts?: string[]
    bodies: Record<string, MeshPayload[]>
    anchors: Record<string, Record<string, AnchorPose>>
    /** Authoring-only: part handle -> anchor id -> the raw descriptor that id
     *  was minted from, so a pick can stamp a durable MateRef.anchor_descriptor.
     *  Optional only so test doubles and older reply shapes can omit it. */
    anchorDescriptors?: Record<string, Record<string, MateAnchorDescriptor>>
    /** The whole solve verdict: overall status plus per-mate and per-part marks.
     *  Optional only so test doubles and older reply shapes can omit it; the
     *  current worker always sets it. */
    status?: AssemblySolveStatus
  }
}

export interface AssemblySolveErrResponse {
  id: number
  kind: 'solveAssembly'
  ok: false
  error: string
}

export type AssemblySolveResponse = AssemblySolveOkResponse | AssemblySolveErrResponse

/**
 * The service the anchor solver worker uses to reach the main thread's document
 * store and the OCC bundle-builder worker. Defined here beside the relay wire
 * types rather than in the worker entry, so the kernel's `solveAssembly` can
 * name the relay without importing the module that hosts the WASM engine.
 */
export interface RelayService {
  requestPartDoc(doc_id: string): Promise<Record<string, unknown>>
  requestBuildBundle(doc_id: string, content_hash: string, spec: Record<string, unknown>): Promise<unknown>
}

/** The anchor solver worker requests a relayed service from the main thread. */
export interface AnchorRelayRequest {
  kind: 'asr_relay'
  requestId: number
  subKind: 'partDocContent' | 'buildBundle'
  doc_id: string
  content_hash?: string
  spec?: Record<string, unknown>
}

/** The main thread's relay response back to the anchor solver worker. */
export interface AnchorRelayOkResponse {
  kind: 'asr_relayRes'
  requestId: number
  ok: true
  payload: unknown
}

export interface AnchorRelayErrResponse {
  kind: 'asr_relayRes'
  requestId: number
  ok: false
  error: string
}

export type AnchorRelayResponse = AnchorRelayOkResponse | AnchorRelayErrResponse

/** Every message the anchor solver worker receives from the main thread. */
export type AssemblyWorkerRequest = SolveAssemblyRequest | AnchorRelayOkResponse | AnchorRelayErrResponse

/**
 * Broadcast once the anchor worker has finished `initAnchorSolver` (success or
 * failure). Carries no request id: it is a state broadcast, not a reply.
 */
export interface AnchorReadyMessage {
  kind: 'anchorReady'
}

/** Every message the anchor solver worker sends to the main thread. */
export type AssemblyWorkerResponse = AssemblySolveResponse | AnchorRelayRequest | AnchorReadyMessage
