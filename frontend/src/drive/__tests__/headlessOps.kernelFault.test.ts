// @vitest-environment node
//
// D1/D2 end to end at the drive boundary: a run whose kernel traps twice has to
// answer ok:false with `solve.lastError` naming the fault, and the next run in
// the same process has to build normally on a fresh module. That second half is
// the regression: before the reload, one trap wedged every later call.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import {
  setSolveLocalsForTest,
} from '@/kernel/solveLocally'
import { resetSketchSolver, setSketchSolver } from '@/kernel/features/sketch'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
import { createHeadlessPart } from '../headlessPart'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import type { PartDoc } from '@/types/cad'
import type { OccModule } from '@/kernel/occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

function trappingModule(): OccModule {
  return new Proxy({}, {
    get(): never {
      throw new WebAssembly.RuntimeError('memory access out of bounds')
    },
  }) as OccModule
}

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

describe.skipIf(!oc || !solveBytes)('headless run after a kernel fault (real OCC + Rust solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('fails the run, names the fault, then builds the box on a fresh module', async () => {
    let trap = true
    setSolveLocalsForTest(async () => (trap ? trappingModule() : oc))
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    // featureDeltas 'all' skips the baseline measurement, so every solve in
    // this run is the session's own and every one of them hits the trap.
    const failed = await runHeadless({
      doc: emptyDoc(),
      steps: box.steps,
      featureDeltas: 'all',
    })
    expect(failed.ok).toBe(false)
    expect(failed.solve.lastError).toMatch(/kernel fault/)
    expect(failed.solve.lastError).toContain('memory access out of bounds')
    // No verdicts survived the failed settles, so every authored feature is
    // named rather than silently absent.
    expect(failed.features.map(problem => problem.status)).toContain('missing')

    // Same process, fresh module: the next document must build normally.
    trap = false
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    expect(built.solve.lastError).toBeNull()
    expect(built.features).toEqual([])
    expect(built.frames!.sk1).toBeDefined()
    const measured = await measureHeadless(built.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.volume).toBeCloseTo(12000, 3)

    // A solve that faults AFTER a good one must not pair the old response's
    // frames with the current document.
    const part = createHeadlessPart({ doc: emptyDoc(), docId: 'fault-after-build' })
    await part.run(box.steps)
    expect(part.featureFrames()!.sk1).toBeDefined()
    setSolveLocalsForTest(async () => null)
    part.session.refreshSolve()
    await part.idle()
    expect(part.solve.state().lastError).toMatch(/solver unavailable/i)
    expect(part.featureFrames()).toBeNull()
  }, 180_000)
})
