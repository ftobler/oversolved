// @vitest-environment node
//
// The real fuzz scheduler must surface a recovered kernel trap. solveLocally
// retries a trap on a fresh module and the retry usually passes, so before
// `trapCount` the fuzz could only see a trap when it repeated, and with a
// working reload seed 33 would have gone green while trapping on every other
// incremental solve.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc, resetOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { createRealSolveScheduler } from './realSolveScheduler'
import { initialFuzzDoc } from './fuzzHarness'

const oc = await loadOcc()
const solveBytes = loadSolver()

describe.skipIf(!oc || !solveBytes)('the real fuzz scheduler reports recovered traps', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('a solve during which the trap count moved is an error outcome', async () => {
    setSolveLocalsForTest(loadOcc, resetOcc)
    let reads = 0
    // Each read is one later than the last: the count "moves" across the solve.
    const scheduler = createRealSolveScheduler({ trapCount: () => reads++ })
    const outcome = await scheduler.request(initialFuzzDoc())
    expect(outcome.status).toBe('error')
    expect(scheduler.state().lastError).toMatch(/kernel trap recovered/)
  })

  it('a solve with a steady trap count is applied', async () => {
    setSolveLocalsForTest(loadOcc, resetOcc)
    const scheduler = createRealSolveScheduler({ trapCount: () => 0 })
    const outcome = await scheduler.request(initialFuzzDoc())
    expect(outcome.status).toBe('applied')
    expect(scheduler.state().lastError).toBeNull()
  })
})
