// @vitest-environment node
//
// The session fuzz's real-kernel half: the same seeded mutation and undo/redo
// sequences as fuzz.test.ts, replayed through solveLocally. Split out so the
// fake scheduler half still runs on an unprovisioned checkout, and so the
// naming convention marks the file that needs OCC.js and the WASM builds.
//
// `just fuzz-session` sets FUZZ_REQUIRE_REAL, which turns a missing kernel from
// a skip into a failure: without it the long run could pass in seconds on the
// fake side alone while reporting green.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSolveLocalsForTest, persistentTableForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { generateSequence, runFuzzSequence } from './fuzzHarness'
import { createRealSolveScheduler } from './realSolveScheduler'
import { reportFailureDocs } from './fuzzFailureDocs'

const oc = await loadOcc()
const solveBytes = loadSolver()

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const FUZZ_SEEDS = envInt('FUZZ_SEEDS', 4)
const FUZZ_STEPS = envInt('FUZZ_STEPS', 6)

// The real suite loops its seeds inside one test, so its timeout scales with
// the sweep instead of sitting at a fixed wall: 250 ms per (seed, step) over a
// 60 s floor, capped at 30 minutes. The bounded default (4 x 6) allows 66 s
// for a run measured in about a second; a manual sweep grows its own budget.
const REAL_STEP_BUDGET_MS = 250
const REAL_TIMEOUT_MS = Math.min(30 * 60_000, 60_000 + FUZZ_SEEDS * FUZZ_STEPS * REAL_STEP_BUDGET_MS)

function seeds(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i)
}

// The real suite below skips where the kernel is not provisioned, which keeps the
// PR gate runnable on a fresh checkout but let `just fuzz-session` pass in 3 s
// on the fake side alone while reporting green. The recipe sets FUZZ_REQUIRE_REAL
// so the long run refuses to count without the real kernel.
describe.runIf(process.env.FUZZ_REQUIRE_REAL === '1')('the fuzz real-kernel requirement', () => {
  it('has opencascade.js and the solver build loaded', () => {
    expect(oc, 'opencascade.js missing: run `just install-occ`').not.toBeNull()
    expect(solveBytes, 'solver pkg-node missing: run `just wasm`').not.toBeNull()
  })
})

describe.skipIf(!oc || !solveBytes)('the seeded fuzz ratchet (real kernel)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('replays the bounded seeds through solveLocally', { timeout: REAL_TIMEOUT_MS }, async () => {
    let previousTable: ReturnType<typeof persistentTableForTest> = null
    for (const seed of seeds(FUZZ_SEEDS)) {
      // solveLocally's own doc-switch reset is inert here (a fuzz doc carries
      // no id, so every seed is the same cache key), so the fresh cache per
      // seed has to come from this explicit reset. The two assertions are its
      // teeth: drop the reset and the second seed starts on the first seed's
      // live table instead of a null one, and then reuses its object.
      setSolveLocalsForTest(async () => oc)
      expect(persistentTableForTest(), `seed ${seed} cache not reset`).toBeNull()
      // The solves chain through microtasks only, so a long sweep never hands
      // the loop a macrotask turn and vitest's worker RPC replies sit unread
      // until the RPC timer fails the run ("Timeout calling onTaskUpdate").
      await new Promise(resolve => setImmediate(resolve))

      const result = await runFuzzSequence(generateSequence(seed, FUZZ_STEPS), {
        scheduler: createRealSolveScheduler(),
        settle: () => undefined,
      })
      reportFailureDocs(seed, result)
      expect(result.violations, `seed ${seed}`).toEqual([])

      const table = persistentTableForTest()
      expect(table, `seed ${seed} solved nothing`).not.toBeNull()
      expect(table, `seed ${seed} reused the prior seed's solve table`).not.toBe(previousTable)
      previousTable = table
    }
  })
})
