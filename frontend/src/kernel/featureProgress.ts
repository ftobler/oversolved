/**
 * Feature progress marks: `build()` announces each feature before it solves
 * it, so a host that has to give up on a stuck solve can say where it stuck.
 *
 * The solve itself is one synchronous WASM-backed call and cannot report
 * anything once a kernel operation spins, so the mark is sent BEFORE the
 * feature runs: the last mark a host received names the feature that never
 * finished. A feature that runs several long kernel operations (a many-copy
 * pattern's boolean, clean and BRepCheck) also re-emits its own mark between
 * them (`markFeatureProgress`), which keeps the stall budget reading the one
 * operation it was meant to catch rather than their sum. The solver Web Worker
 * and the MCP kernel worker forward each mark to their host as a message; with
 * no listener the mark costs one Set walk.
 */

export type FeatureProgressListener = (featureId: string) => void

const listeners = new Set<FeatureProgressListener>()

/** Subscribe to feature starts; returns the unsubscribe. */
export function onFeatureStart(listener: FeatureProgressListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// The feature `build()` is solving. A heartbeat re-emits it; a host re-arms its
// stall timer on any progress message, so the silence between two marks is what
// the budget measures.
let current: string | null = null

/** Called by `build()` right before it solves feature `featureId`. */
export function markFeatureStart(featureId: string): void {
  current = featureId
  for (const listener of listeners) listener(featureId)
}

/**
 * Re-emit the running feature's mark at a phase boundary inside one feature.
 *
 * A long feature (a many-copy pattern) runs several kernel operations whose
 * sum dwarfs any one of them: the batch boolean, the clean, the whole-shape
 * BRepCheck, the history compose. The host's stall budget is meant to catch ONE
 * operation that spins, so marking between them keeps a healthy feature from
 * reading as a stall without weakening that rule -- a mark is never placed
 * inside a kernel call, so a spinning UnifySameDomain or BRepCheck still trips
 * exactly as it did. A no-op when no build is running (direct kernel calls in
 * tests and tools have no host to re-arm).
 */
export function markFeatureProgress(): void {
  if (current === null) return
  for (const listener of listeners) listener(current)
}

/** Called by `build()` when it finishes: after that, no heartbeat may name a
 *  feature the build no longer runs. */
export function clearFeatureProgress(): void {
  current = null
}

/**
 * The one wording every host uses when it gives up on a solve, so the browser
 * banner and the MCP tool error read alike: `solve timed out after 30 s in
 * feature ex2`. `featureId` is the last mark received, null when the solve
 * stuck before reaching any feature (the kernel load, a sketch-only replay).
 */
export function solveTimeoutMessage(
  budgetMs: number,
  featureId: string | null,
  partId: string | null = null,
): string {
  // An assembly bundle build marks `part <doc_id>` before the part's own
  // features, so a stall inside a part names both the part and the feature it
  // reached. A part build (the common case) has no partId and reads as before.
  const where = partId !== null
    ? ` in ${partId}${featureId === null ? '' : ` (feature ${featureId})`}`
    : featureId === null ? '' : ` in feature ${featureId}`
  return `solve timed out after ${budgetMs / 1000} s${where}`
}
