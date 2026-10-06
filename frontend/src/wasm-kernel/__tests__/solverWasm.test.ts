// solverWasm is the browser seam to the two gitignored wasm-pack `--target web`
// packages. Its contract is failure-tolerant: an absent package (or one that
// predates an entry point) resolves to null so the Worker degrades instead of
// throwing. A successful load is memoized per package until reset; a failed one
// is not, so the next call can retry a transient fetch or compile failure. The
// dynamic import is stubbed here so the contract can be exercised without the
// binaries.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  sketchInit: vi.fn(async () => {}),
  mateInit: vi.fn(async () => {}),
  sketchSolve: () => 'sketch-solve',
  detectTopology: () => 'detect-topology',
  mateSolve: () => 'mate-solve',
  mateSolveLive: () => 'mate-solve-live',
}))

vi.mock('/wasm-live/sketch_solver.js', () => ({
  default: h.sketchInit,
  solve_sketch_bytes: h.sketchSolve,
  detect_topology_bytes: h.detectTopology,
}))

vi.mock('/wasm-live/mate_solver.js', () => ({
  default: h.mateInit,
  solve_mate_bytes: h.mateSolve,
  solve_mate_bytes_live: h.mateSolveLive,
}))

// A build predating the live-drag entry point. The export is present-but-
// undefined rather than absent to satisfy the mock proxy; the loader must still
// surface null and not call it.
vi.mock('/wasm-prelive/mate_solver.js', () => ({
  default: h.mateInit,
  solve_mate_bytes: h.mateSolve,
  solve_mate_bytes_live: undefined,
}))

import {
  loadMateWasm,
  loadMateWasmLive,
  loadSolverWasm,
  loadTopologyWasm,
  resetSolverWasm,
} from '../solverWasm'

describe('solverWasm loaders', () => {
  beforeEach(() => {
    resetSolverWasm()
    vi.clearAllMocks()
  })
  afterEach(() => vi.restoreAllMocks())

  it('resolves each entry point from its own package', async () => {
    expect(await loadSolverWasm('/wasm-live/')).toBe(h.sketchSolve)
    expect(await loadTopologyWasm('/wasm-live/')).toBe(h.detectTopology)
    expect(await loadMateWasm('/wasm-live/')).toBe(h.mateSolve)
    expect(await loadMateWasmLive('/wasm-live/')).toBe(h.mateSolveLive)
    // The package's init() must run once with its own wasm path, or the web
    // build never fetches its binary even though the exports resolve.
    expect(h.sketchInit).toHaveBeenCalledWith('/wasm-live/sketch_solver_bg.wasm')
    expect(h.mateInit).toHaveBeenCalledWith('/wasm-live/mate_solver_bg.wasm')
  })

  it('resolves the live entry point to null when the build predates it', async () => {
    expect(await loadMateWasmLive('/wasm-prelive/')).toBeNull()
    // The full solve from the same package is still available.
    expect(await loadMateWasm('/wasm-prelive/')).toBe(h.mateSolve)
  })

  it('resolves null instead of throwing when the package cannot be loaded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await loadSolverWasm('/no-such-wasm-base/')).toBeNull()
    expect(error).toHaveBeenCalled()
  })

  it('does not memoize a failed load, so the next call retries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const attempts = () =>
      error.mock.calls.filter(c => String(c[0]).includes('loading sketch_solver failed')).length

    await loadSolverWasm('/no-such-wasm-base/')
    await loadSolverWasm('/no-such-wasm-base/')
    // The failed entry is dropped, so the import is attempted again rather than
    // pinning the whole session to the degraded null.
    expect(attempts()).toBe(2)

    // A successful load IS memoized: reset is the only way to force a reload.
    await loadSolverWasm('/wasm-live/')
    await loadSolverWasm('/wasm-live/')
    expect(h.sketchInit).toHaveBeenCalledTimes(1)

    resetSolverWasm()
    await loadSolverWasm('/wasm-live/')
    expect(h.sketchInit).toHaveBeenCalledTimes(2)
  })
})
