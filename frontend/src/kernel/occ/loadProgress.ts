/**
 * The observable state of the OCC artifact load, so the UI can show progress
 * while the ~63 MB wasm downloads and compiles.
 *
 * The load happens in the solver Worker in production, so this module holds two
 * independent instances of the state: the Worker's loader writes its own, the
 * Worker relays each update over postMessage, and the main thread applies the
 * relayed snapshot here ([[applyOccLoadProgress]]). The main-thread loader
 * ([[loadOccWeb]]) writes this instance directly. Nothing here touches the DOM,
 * so the state machine is unit-testable on its own.
 */

export type OccLoadPhase = 'idle' | 'downloading' | 'compiling' | 'ready' | 'failed'

export interface OccLoadProgress {
  phase: OccLoadPhase
  loadedBytes: number
  totalBytes: number
}

export type OccLoadListener = (progress: OccLoadProgress) => void

const IDLE: OccLoadProgress = Object.freeze({ phase: 'idle', loadedBytes: 0, totalBytes: 0 })

let current: OccLoadProgress = IDLE
const listeners = new Set<OccLoadListener>()

function publish(next: OccLoadProgress): void {
  current = next
  for (const listener of [...listeners]) listener(next)
}

export function getOccLoadProgress(): OccLoadProgress {
  return current
}

/** Subscribe to every update; returns the unsubscribe. */
export function subscribeOccLoadProgress(listener: OccLoadListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A load is starting: reset the byte counters so a retry does not show stale progress. */
export function beginOccLoad(): void {
  publish({ phase: 'downloading', loadedBytes: 0, totalBytes: 0 })
}

export function reportOccDownload(loadedBytes: number, totalBytes: number): void {
  publish({ phase: 'downloading', loadedBytes, totalBytes })
}

export function reportOccCompiling(): void {
  publish({ phase: 'compiling', loadedBytes: current.loadedBytes, totalBytes: current.totalBytes })
}

export function reportOccReady(): void {
  publish({ phase: 'ready', loadedBytes: current.loadedBytes, totalBytes: current.totalBytes })
}

export function reportOccFailed(): void {
  publish({ phase: 'failed', loadedBytes: current.loadedBytes, totalBytes: current.totalBytes })
}

/** Apply a snapshot relayed from the Worker; same effect as reporting it here. */
export function applyOccLoadProgress(progress: OccLoadProgress): void {
  publish(progress)
}

export function resetOccLoadProgress(): void {
  publish(IDLE)
}

/**
 * Download percent, or null when the server sent no usable Content-Length.
 * With a precompressed response the header counts wire bytes while the reader
 * counts decoded bytes, so the ratio can pass 100: capped, because the gauge is
 * for a person, not for accounting.
 */
export function occLoadPercent(progress: OccLoadProgress): number | null {
  if (progress.totalBytes <= 0) return null
  return Math.min(100, Math.floor((progress.loadedBytes / progress.totalBytes) * 100))
}
