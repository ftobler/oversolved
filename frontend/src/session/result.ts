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
  | 'unknown-transaction'

export interface SessionFailure {
  ok: false
  code: SessionErrorCode
  message: string
}

export interface SessionSuccess {
  ok: true
  createdIds: string[]
  // Present only when createdIds leaves the constraints out: how many the
  // mutation minted (the rect/n-gon helpers and the mirror/pattern/fillet
  // sketch copy sugar).
  constraints?: number
  // Present only on an add_three_point_arc step: which stored arc vertex key
  // holds the given start and end points, so the next step can name the vertex
  // without guessing the CCW storage orientation.
  vertexKeys?: { start: 'start' | 'end'; end: 'start' | 'end' }
}

export interface OpenedSuccess {
  ok: true
  id: string
}

export type Result = SessionSuccess | SessionFailure

export type OpenedResult = OpenedSuccess | SessionFailure

export function okResult(
  createdIds: string[] = [],
  constraints?: number,
  vertexKeys?: SessionSuccess['vertexKeys'],
): SessionSuccess {
  return {
    ok: true,
    createdIds,
    ...(constraints === undefined ? {} : { constraints }),
    ...(vertexKeys === undefined ? {} : { vertexKeys }),
  }
}

export function openedResult(id: string): OpenedSuccess {
  return { ok: true, id }
}

export function errorResult(code: SessionErrorCode, message: string): SessionFailure {
  return { ok: false, code, message }
}
