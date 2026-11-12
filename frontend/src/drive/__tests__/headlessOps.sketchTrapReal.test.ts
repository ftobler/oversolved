// @vitest-environment node
//
// D2 of bug-headless-sketch-trap-reload: a headless host used to INJECT the
// sketch solver bytes (`setSketchSolver(loadSolver())`), so trap recovery had
// nothing to reload from and every later call answered "the sketch solver could
// not be reloaded after a trap" until the process restarted. The host now
// installs a LOADER that produces a fresh module, and recovery re-runs it.
//
// The trap is injected: the real trapping input (a negative arc radius) was
// fixed in bug-fillet-corners-stale-dims, so a fixture that traps today no
// longer exists. The recovery path is still the contract and stays covered.
//
// Skips when OCC.js or the pkg-node sketch solver is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolverFresh } from '@/wasm-kernel/loadSolver'
import { kernelReloadRequired, setSolveLocalsForTest } from '@/kernel/solveLocally'
import { resetSketchSolver, setSketchSolverLoader } from '@/kernel/features/sketch'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import type { PartDoc } from '@/types/cad'
import type { SketchSolverBundle, SolveBytes } from '@/wasm-kernel/wasmTypes'

const oc = await loadOcc()
const firstLoad = loadSolverFresh()

/** A module that throws the trap on every solve: the deterministic trapping
 *  input, which no longer exists in the real solver. */
function trappingBundle(): SketchSolverBundle | null {
  const real = loadSolverFresh()
  if (real === null) return null
  return {
    solve: (() => {
      throw new WebAssembly.RuntimeError('unreachable')
    }) as unknown as SolveBytes,
    topology: real.topology,
  }
}

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!

describe.skipIf(!oc || !firstLoad)('a headless sketch trap (real OCC + pkg-node loader)', () => {
  beforeAll(() => {
    setSolveLocalsForTest(async () => oc)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    setSketchSolverLoader(null)
    resetSketchSolver()
  })

  it('reloads the sketch module and builds the next run in the same process', async () => {
    let trap = true
    let loads = 0
    setSketchSolverLoader(() => {
      const fresh = loadSolverFresh()
      if (fresh === null) return null
      loads++
      return {
        solve: (input: Uint8Array) => {
          if (trap) throw new WebAssembly.RuntimeError('unreachable')
          return fresh.solve(input)
        },
        topology: fresh.topology,
      }
    })
    // featureDeltas 'all' skips the baseline measurement, so every solve in
    // this run is the session's own and every one of them hits the trap.
    const failed = await runHeadless({ doc: emptyDoc(), steps: box.steps, featureDeltas: 'all' })
    expect(failed.ok).toBe(false)
    expect(failed.solved).toBe(true)
    expect(failed.solve.lastError).toMatch(/kernel fault/)
    expect(failed.solve.lastError).toContain('unreachable')
    // Recovery reloaded the module, so this is not the wedged state.
    expect(failed.solve.lastError).not.toContain('could not be reloaded')
    // One install plus one reload per trapped attempt, all through the loader.
    expect(loads).toBe(3)

    // Same process, same loader, no trap: the fresh module builds normally.
    trap = false
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    expect(built.solve.lastError).toBeNull()
    expect(built.features).toEqual([])
    const measured = await measureHeadless(built.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.volume).toBeCloseTo(12000, 3)
  }, 180_000)

  it('does not claim a reload when the loader cannot replace the module', async () => {
    let loads = 0
    setSketchSolverLoader(() => {
      loads++
      // The first install works; the reload after the trap finds nothing, the
      // realistic form of a module that cannot be re-instantiated.
      return loads === 1 ? trappingBundle() : null
    })
    const failed = await runHeadless({ doc: emptyDoc(), steps: box.steps, featureDeltas: 'all' })
    expect(failed.ok).toBe(false)
    expect(failed.solve.lastError).toContain('could not be reloaded')
    // The reply must not claim a recovery that did not happen; the MCP host
    // answers this fault by dropping the worker (kernelHost.ts).
    expect(failed.solve.lastError).not.toContain('the kernel was reloaded')
    // A run carries its fault on lastError rather than throwing, so this is the
    // state the worker reports beside the reply for the host to act on.
    expect(kernelReloadRequired()).toBe(true)

    // A loader that can produce a module again clears the reload latch: the
    // host is never wedged once a replacement is available.
    setSketchSolverLoader(loadSolverFresh)
    const recovered = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(recovered.ok).toBe(true)
    expect(recovered.solve.lastError).toBeNull()
    expect(kernelReloadRequired()).toBe(false)
  }, 180_000)
})
