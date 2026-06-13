import '@testing-library/jest-dom'
import { beforeEach } from 'vitest'

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

if (typeof ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
}
