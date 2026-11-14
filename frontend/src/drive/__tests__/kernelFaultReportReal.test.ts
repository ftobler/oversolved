// @vitest-environment node
//
// A trap must be reported by the run it happened in, whichever solve reached
// it. The baseline measurement runs before the script (it is the delta/frame
// comparison's starting state) and used to swallow a KernelFault whole: the run
// then answered ok:true with no lastError, and only the next call on the same
// document met the dead kernel. A `run` whose baseline solve trapped now keeps
// that fault on its reply. The second half pins the other direction: a trap in
// the run's own solve is reported, and a following measure re-answers the fault
// rather than replaying a cached verdict.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { resetSketchSolver, setSketchSolver } from '@/kernel/features/sketch'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
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

const BOX = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!.steps

describe.skipIf(!oc || !solveBytes)('a trapped solve is reported by its run (real OCC + Rust solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
  })

  it('reports a trap in the baseline measurement instead of answering ok:true', async () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    // A real document to measure: the baseline solve builds this one and is the
    // only solve that meets the trap.
    setSolveLocalsForTest(async () => oc)
    const built = await runHeadless({ doc: emptyDoc(), steps: BOX, docId: 'trap-baseline' })
    expect(built.ok).toBe(true)

    // The first module load faults its build; solveLocally retries once (the
    // second load faults too), and the third load is healthy. So the baseline
    // solve traps and everything after it would succeed, which is exactly the
    // state that used to read as a clean run.
    let loads = 0
    setSolveLocalsForTest(async () => (++loads <= 2 ? trappingModule() : oc))
    const trapped = await runHeadless({ doc: built.doc!, steps: [], docId: 'trap-baseline' })
    expect(trapped.ok).toBe(false)
    expect(trapped.solve.lastError).toMatch(/^kernel fault/)
    expect(trapped.solve.lastError).toContain('memory access out of bounds')
  }, 180_000)

  it('reports a trap in the run solve, and a measure re-answers it', async () => {
    // Every load traps, so the run's own settle cannot recover; featureDeltas
    // and frames 'all' skip the baseline measurement this case is not about.
    setSolveLocalsForTest(async () => trappingModule())
    const failed = await runHeadless({
      doc: emptyDoc(),
      steps: BOX,
      docId: 'trap-run',
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(failed.ok).toBe(false)
    expect(failed.solved).toBe(true)
    expect(failed.solve.lastError).toMatch(/^kernel fault/)

    // The document the failed run holds is what its docHash names. Measuring it
    // meets the same dead kernel and must say so, not answer a clean build.
    const doc = failed.doc
    expect(doc).not.toBeNull()
    await expect(measureHeadless(doc as PartDoc, { docId: 'trap-run' })).rejects.toMatchObject({
      name: 'KernelFault',
    })
  }, 180_000)
})
