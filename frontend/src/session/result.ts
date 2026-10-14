// The session's result type. An illegal internal state is an error Result with
// a recorded diagnostic, not a thrown exception, so a headless driver can
// observe it; test mode still throws through failLoud so the existing suites
// keep pinning the guards.
export type SessionErrorCode =
  | 'no-document'
  | 'unknown-mutation'

export interface SessionSuccess {
  ok: true
  createdIds: string[]
}

export interface SessionFailure {
  ok: false
  code: SessionErrorCode
  message: string
}

export type Result = SessionSuccess | SessionFailure

export function okResult(createdIds: string[]): SessionSuccess {
  return { ok: true, createdIds }
}

export function errorResult(code: SessionErrorCode, message: string): SessionFailure {
  return { ok: false, code, message }
}
