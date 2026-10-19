import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect } from 'vitest'

// Drive the whole node suite through the Rust/WASM area builder (the same path
// the browser runs), not the TS fallback. Resolves null on a fresh checkout
// (no `just wasm`), in which case solveSketch falls back to TS detectTopology.
//
// Wired in a beforeEach via DYNAMIC import (not a static top-level import) so
// `sketch.ts`/`solverWasm` are evaluated inside each test's mocked module
// context -- a static import here would pre-evaluate them before a test's
// `vi.mock('@/wasm-kernel/solverWasm', ...)` could intercept. It runs after the
// test's own resetSketchSolver (which preserves the topology loader), so the
// Rust path stays wired for the solve.
beforeEach(async () => {
  const [{ setSketchTopology }, { loadTopology }] = await Promise.all([
    import('./kernel/features/sketch'),
    import('./wasm-kernel/loadTopology'),
  ])
  setSketchTopology(loadTopology())
})

// Event-loop starvation watchdog. A test that awaits only settled promises
// (the real kernel is synchronous WASM behind async signatures) never lets the
// fork read its RPC replies, and past the worker RPC timeout the run dies with
// an unattributed `Timeout calling "onTaskUpdate"` although every test passed.
// A ticking interval measures the longest gap per test. Locally a gap past 30 s
// fails the test by name, so starvation is caught on a fast box long before the
// runner's 120 s budget (scripts/vitestRpcTimeout.loader.mjs doubles vitest 3's
// 60 s); under CI, where load stretches every gap, it only warns, naming the
// test the timeout came from.
// The clock and the interval are captured before any test can fake them.
const STALL_LIMIT_MS = 30_000
const realNow = performance.now.bind(performance)
let lastTick = realNow()
let worstGap = 0
setInterval(() => {
  const now = realNow()
  worstGap = Math.max(worstGap, now - lastTick)
  lastTick = now
}, 100).unref()
beforeEach(() => {
  lastTick = realNow()
  worstGap = 0
})
afterEach(() => {
  const gap = Math.round(Math.max(worstGap, realNow() - lastTick))
  if (gap <= STALL_LIMIT_MS) return
  const message = `held the event loop for ${gap} ms without a macrotask (limit ${STALL_LIMIT_MS} ms); `
    + 'await yieldToEventLoop() (src/testing/yieldToEventLoop.ts) between builds'
  if (import.meta.env.CI) console.warn(`[stall] ${expect.getState().currentTestName}: ${message}`)
  else throw new Error(message)
})

if (typeof ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
}
