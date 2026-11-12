// @vitest-environment node
//
// The headless sketch loader must hand back a NEW module every call. The
// wasm-pack nodejs glue instantiates its wasm at require time and Node caches
// the JS module, so a plain second require returns the instance whose heap the
// trap already invalidated. That is what wedged the MCP server: its trap
// recovery had no loader to re-run (bug-headless-sketch-trap-reload).
//
// Skips when the pkg-node build is absent (a fresh checkout).

import { describe, it, expect } from 'vitest'
import { loadSolver, loadSolverFresh } from '../loadSolver'

describe.skipIf(loadSolverFresh() === null)('loadSolverFresh', () => {
  it('gives every load a new module instance', () => {
    const a = loadSolverFresh()
    const b = loadSolverFresh()
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    // A distinct closure per export means require re-evaluated the package and
    // its top-level `new WebAssembly.Instance` ran again. A cached module hands
    // back the same function objects, which is exactly the trapped-instance bug.
    expect(a!.topology).not.toBeNull()
    expect(a!.solve).not.toBe(b!.solve)
    expect(a!.topology).not.toBe(b!.topology)
  })

  it('replaces the module the plain loader had cached', () => {
    const plain = loadSolver()
    expect(plain).not.toBeNull()
    const next = loadSolverFresh()
    expect(next).not.toBeNull()
    expect(next!.solve).not.toBe(plain)
  })
})
