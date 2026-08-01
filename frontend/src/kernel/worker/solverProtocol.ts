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
import type { Transform3D } from '../../types/cad'
import type { MateSpec, MateResult, MeshPayload, AnchorPose } from '../solveAssembly'

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
  doc_rev: number
}

/** Export options that survive a structured clone. */
export interface ExportRequestOptions {
  format: 'step' | 'stl'
  bodyId?: string | null
  tessellation?: number
}

/** Build a document Worker-side and serialise it to STEP/STL bytes. */
export interface ExportRequest {
  id: number
  kind: 'export'
  spec: Record<string, unknown>
  options: ExportRequestOptions
}

/** One part instance of an assembly export: its PartDoc spec + solved placement. */
export interface AssemblyExportPartSpec {
  spec: Record<string, unknown>
  transform: Transform3D
}

/**
 * Build every part of an assembly Worker-side, place it, and serialise the
 * union. Routed to the OCC bundle-builder worker because the anchor solver holds
 * meshes only and cannot rehydrate B-rep. `options.bodyId` is meaningless here
 * and ignored: an assembly exports whole.
 */
export interface ExportAssemblyRequest {
  id: number
  kind: 'exportAssembly'
  parts: AssemblyExportPartSpec[]
  options: ExportRequestOptions
}

/** Either request the Worker can receive; discriminated by `kind`. */
export type WorkerRequest = SolveRequest | ExportRequest | BundleRequest | ExportAssemblyRequest

/** Shared error arm for every Worker response (solve and export alike). */
export interface WorkerErrResponse {
  id: number
  ok: false
  error: string
}

export interface ExportOkResponse {
  id: number
  ok: true
  /** `null` mirrors exportLocally returning null (OCC.js absent / no body). */
  bytes: Uint8Array | null
}

export type ExportResponse = ExportOkResponse | WorkerErrResponse

/** Bundle response carries the mesh + edge payloads. Empty anchors dict in Stage 2b. */
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
}

export interface SolveOkResponse {
  id: number
  ok: true
  /** `null` mirrors solveLocally returning null (OCC.js unavailable). */
  payload: SolvePayload | null
}

export type SolveResponse = SolveOkResponse | WorkerErrResponse

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
  doc_rev: number
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
  revs: Record<string, number>
  mates: MateSpec[]
}

/** Successful assembly solve response from the anchor solver worker. */
export interface AssemblySolveOkResponse {
  id: number
  kind: 'solveAssembly'
  ok: true
  payload: {
    transforms: Record<string, Transform3D>
    bodies: Record<string, MeshPayload[]>
    anchors: Record<string, Record<string, AnchorPose>>
    mateResults: Record<string, MateResult>
    /** The mate solve trapped; transforms are the placed seeds. */
    solveError?: string
  }
}

export interface AssemblySolveErrResponse {
  id: number
  kind: 'solveAssembly'
  ok: false
  error: string
}

export type AssemblySolveResponse = AssemblySolveOkResponse | AssemblySolveErrResponse

/** The anchor solver worker requests a relayed service from the main thread. */
export interface AnchorRelayRequest {
  kind: 'asr_relay'
  requestId: number
  subKind: 'partDocContent' | 'buildBundle'
  doc_id: string
  doc_rev?: number
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

/** Every message the anchor solver worker sends to the main thread. */
export type AssemblyWorkerResponse = AssemblySolveResponse | AnchorRelayRequest
