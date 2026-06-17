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

/** Solve options that survive a structured clone (the OCC-free subset). */
export interface SolveRequestOptions {
  pickBoundary?: number | null
  rollbackPosition?: number | null
  validate?: boolean
}

export interface SolveRequest {
  id: number
  kind?: 'solve'
  spec: Record<string, unknown>
  options: SolveRequestOptions
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

/** Either request the Worker can receive; discriminated by `kind`. */
export type WorkerRequest = SolveRequest | ExportRequest

export interface ExportOkResponse {
  id: number
  ok: true
  /** `null` mirrors exportLocally returning null (OCC.js absent / no body). */
  bytes: Uint8Array | null
}

export interface ExportErrResponse {
  id: number
  ok: false
  error: string
}

export type ExportResponse = ExportOkResponse | ExportErrResponse

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

export interface SolveErrResponse {
  id: number
  ok: false
  error: string
}

export type SolveResponse = SolveOkResponse | SolveErrResponse
