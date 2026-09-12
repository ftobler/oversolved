import type { FileBytes } from './solverProtocol'

// File ids whose bytes the live solver worker generation has already absorbed.
// Kept out of solverClient.ts so main-thread callers can ask what still needs
// reading from storage without importing (and defeating the partial mocks of)
// the whole worker client.
//
// An id is only committed once postMessage succeeded (markFilesSent): a throw
// leaves it unmarked so a retry still carries the bytes. A respawned worker
// starts empty, so clearWorkerFileIds runs wherever the worker is dropped.

const workerFileIds = new Set<string>()

// Non-mutating: returns only the entries the live worker does not already hold.
export function fileDelta(files: FileBytes | undefined): FileBytes | undefined {
  if (!files) return undefined
  const out: FileBytes = {}
  let any = false
  for (const [id, bytes] of Object.entries(files)) {
    if (workerFileIds.has(id)) continue
    out[id] = bytes
    any = true
  }
  return any ? out : undefined
}

// Commit the ids of a request whose postMessage succeeded.
export function markFilesSent(files: FileBytes | undefined): void {
  if (!files) return
  for (const id of Object.keys(files)) workerFileIds.add(id)
}

// The subset of `ids` the live worker generation does not yet hold. Callers that
// resolve ids out of storage use this to read each file once per generation
// rather than on every drag-driven re-solve.
export function fileIdsMissingFromWorker(ids: string[]): string[] {
  return ids.filter(id => !workerFileIds.has(id))
}

export function clearWorkerFileIds(): void {
  workerFileIds.clear()
}
