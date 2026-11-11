/**
 * Browser-kernel readiness store. A small external store (read via
 * `useSyncExternalStore`) that reports whether the OCC + Rust solver workers
 * have finished loading. The splash screen gates the whole app on it.
 *
 * `started` stays false until a warm call happens. While it is false the app
 * is considered ready, so a direct `App` mount in tests (and any environment
 * that never warms) does not hang on a splash that can never resolve.
 */

import { useSyncExternalStore } from 'react'

interface State {
  started: boolean
  solverReady: boolean
  anchorReady: boolean
}

let state: State = { started: false, solverReady: false, anchorReady: false }
const listeners = new Set<() => void>()

let fallbackMs = 15000
let fallbackTimer: ReturnType<typeof setTimeout> | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function isReady(): boolean {
  return !state.started || (state.solverReady && state.anchorReady)
}

function clearFallback(): void {
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer)
    fallbackTimer = null
  }
}

function armFallback(): void {
  if (!state.started) return
  if (fallbackTimer !== null) return
  if (isReady()) return
  fallbackTimer = setTimeout(() => {
    state = { ...state, solverReady: true, anchorReady: true }
    fallbackTimer = null
    emit()
  }, fallbackMs)
  // Keep the timer from keeping a Node process alive in tests.
  const t = fallbackTimer as { unref?: () => void } | null
  if (t !== null && typeof t.unref === 'function') t.unref()
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}

function getSnapshot(): boolean {
  return isReady()
}

export function useKernelReady(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function getKernelReady(): boolean {
  return isReady()
}

export function markSolverStarted(): void {
  const wasStarted = state.started
  state = { ...state, started: true }
  if (!wasStarted) armFallback()
  emit()
}

export function markSolverReady(): void {
  state = { ...state, solverReady: true }
  if (isReady()) clearFallback()
  emit()
}

export function markAnchorStarted(): void {
  const wasStarted = state.started
  state = { ...state, started: true }
  if (!wasStarted) armFallback()
  emit()
}

export function markAnchorReady(): void {
  state = { ...state, anchorReady: true }
  if (isReady()) clearFallback()
  emit()
}

export function resetKernelReady(): void {
  clearFallback()
  state = { started: false, solverReady: false, anchorReady: false }
  emit()
}

export function setKernelReadyFallbackForTest(ms: number): void {
  fallbackMs = ms
}
