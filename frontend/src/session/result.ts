// The session's result types. An illegal state is an error Result with a
// recorded diagnostic rather than a thrown exception, so a headless driver can
// observe it; the UI adapter owns the loud voice and translates the codes into
// the pinned failLoud messages, keeping this layer framework- and
// environment-free.
export type SessionErrorCode =
  | 'no-document'
  | 'unknown-mutation'
  | 'rollback-unsynced'
  | 'preview-already-open'
  | 'preview-over-session'
  | 'edit-already-open'
  | 'gesture-already-open'
  | 'unknown-transaction'

export interface SessionFailure {
  ok: false
  code: SessionErrorCode
  message: string
}

export interface SessionSuccess {
  ok: true
  createdIds: string[]
}

export interface OpenedSuccess {
  ok: true
  id: string
}

export type Result = SessionSuccess | SessionFailure

export type OpenedResult = OpenedSuccess | SessionFailure

export function okResult(createdIds: string[] = []): SessionSuccess {
  return { ok: true, createdIds }
}

export function openedResult(id: string): OpenedSuccess {
  return { ok: true, id }
}

export function errorResult(code: SessionErrorCode, message: string): SessionFailure {
  return { ok: false, code, message }
}
