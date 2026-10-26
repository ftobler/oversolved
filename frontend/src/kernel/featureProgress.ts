/**
 * Feature progress marks: `build()` announces each feature before it solves
 * it, so a host that has to give up on a stuck solve can say where it stuck.
 *
 * The solve itself is one synchronous WASM-backed call and cannot report
 * anything once a kernel operation spins, so the mark is sent BEFORE the
 * feature runs: the last mark a host received names the feature that never
 * finished. The solver Web Worker and the MCP kernel worker forward each mark
 * to their host as a message; with no listener the mark costs one Set walk.
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

/** Called by `build()` right before it solves feature `featureId`. */
export function markFeatureStart(featureId: string): void {
  for (const listener of listeners) listener(featureId)
}

/**
 * The one wording every host uses when it gives up on a solve, so the browser
 * banner and the MCP tool error read alike: `solve timed out after 30 s in
 * feature ex2`. `featureId` is the last mark received, null when the solve
 * stuck before reaching any feature (the kernel load, a sketch-only replay).
 */
export function solveTimeoutMessage(budgetMs: number, featureId: string | null): string {
  const where = featureId === null ? '' : ` in feature ${featureId}`
  return `solve timed out after ${budgetMs / 1000} s${where}`
}
