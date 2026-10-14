import type { SketchData } from '@/types/cad'

// The solve work the session asks for, mirroring the reSolve options the hook
// plumbing already takes. The scheduler is the only place supersession is
// decided: a request whose result is no longer the newest is dropped inside
// the scheduler and reported as 'superseded', never written anywhere.
export interface SolveOptions {
  validate?: boolean
  bypassCache?: boolean
  dragAnchor?: { featureId: string; entityId: string }
  // The first solve of a session owns the camera fit and the thumbnail; an
  // edit's re-solve suppresses it. Load-bearing for the adapter: the flag
  // rides every edit request, exactly as handleMutation passes it today.
  _suppressFirstSolve?: boolean
  _restoreSolveResults?: Record<string, SketchData>
}

export type SolveOutcome =
  // This request's result is the newest one and was adopted.
  | { generation: number; status: 'applied' }
  // A newer request was issued before this one settled; the result was dropped.
  | { generation: number; status: 'superseded' }
  | { generation: number; status: 'error'; error: string }

export interface SolveSchedulerState {
  // Monotonic per request; the UI's staleness checks key on it.
  generation: number
  // A request has been issued and has not settled.
  pending: boolean
  // The scheduler is executing a solve right now (a subset of pending; a
  // single-worker adapter has at most one running request).
  running: boolean
  lastError: string | null
}

export interface SolveScheduler<Doc> {
  // Settles with the outcome, never rejects: a solve failure is an outcome.
  request(doc: Doc, opts?: SolveOptions): Promise<SolveOutcome>
  // Resolves when no request is pending or running.
  idle(): Promise<void>
  state(): SolveSchedulerState
}
