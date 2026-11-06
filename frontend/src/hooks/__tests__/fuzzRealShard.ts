// The session fuzz's real-kernel driver: the same seeded mutation and undo/redo
// sequences as fuzz.test.ts, replayed through solveLocally. Split from the fake
// half so that half still runs on an unprovisioned checkout, and shared by the
// shard files (fuzzShards.ts) so `just fuzz-session` can spread the seeds over
// several forks, each with its own kernel.
//
// `just fuzz-session` sets FUZZ_REQUIRE_REAL, which turns a missing kernel from
// a skip into a failure: without it the long run could pass in seconds on the
// fake side alone while reporting green.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc, resetOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSolveLocalsForTest, persistentTableForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { generateSequence, runFuzzSequence } from './fuzzHarness'
import { createRealSolveScheduler } from './realSolveScheduler'
import { reportFailureDocs } from './fuzzFailureDocs'
import { shardCount, shardSeeds } from './fuzzShards'
import { envInt } from '@/testing/__tests__/envInt'
import { yieldToEventLoop } from '@/testing/yieldToEventLoop'

// The real suite loops its seeds inside one test, so its timeout scales with
// the shard's slice instead of sitting at a fixed wall: 350 ms per (seed, step)
// over a 60 s floor, capped at 30 minutes. The bounded default (4 x 6) allows
// 68 s for a run measured in about a second; a manual sweep grows its own
// budget. The figure is above the unsharded 250 ms because the shards share
// the host's cores and a heavy seed lands in one slice: at 200 x 40 over 4
// shards the slowest took 165 s of its 760 s on a 12-core box, the ~4.5x
// margin the single file had.
const REAL_STEP_BUDGET_MS = 350

/**
 * Register shard `shard`'s real-kernel suite. Call it with top-level await
 * from the shard's test file: the kernel loads only for an active shard, so the
 * PR gate's unused shards cost a skipped test, not a kernel.
 */
export async function describeRealFuzzShard(shard: number): Promise<void> {
  const count = shardCount()
  const fuzzSeeds = envInt('FUZZ_SEEDS', 4)
  const fuzzSteps = envInt('FUZZ_STEPS', 6)
  const label = `shard ${shard + 1}/${count}`

  if (shard >= count) {
    // A test file with no test fails the run, so the idle shard reports one skip.
    describe.skip(`the seeded fuzz ratchet (real kernel, shard ${shard + 1} unused at FUZZ_SHARDS=${count})`, () => {
      it('replays no seeds', () => {})
    })
    return
  }

  const oc = await loadOcc()
  const solveBytes = loadSolver()
  const seeds = shardSeeds(fuzzSeeds, shard, count)
  const timeoutMs = Math.min(30 * 60_000, 60_000 + seeds.length * fuzzSteps * REAL_STEP_BUDGET_MS)

  // The real suite below skips where the kernel is not provisioned, which keeps
  // the PR gate runnable on a fresh checkout but let `just fuzz-session` pass in
  // 3 s on the fake side alone while reporting green. The recipe sets
  // FUZZ_REQUIRE_REAL so the long run refuses to count without the real kernel.
  describe.runIf(process.env.FUZZ_REQUIRE_REAL === '1')(`the fuzz real-kernel requirement (${label})`, () => {
    it('has opencascade.js and the solver build loaded', () => {
      expect(oc, 'opencascade.js missing: run `just install-occ`').not.toBeNull()
      expect(solveBytes, 'solver pkg-node missing: run `just wasm`').not.toBeNull()
    })
  })

  describe.skipIf(!oc || !solveBytes)(`the seeded fuzz ratchet (real kernel, ${label})`, () => {
    beforeAll(() => {
      resetSketchSolver()
      setSketchSolver(solveBytes)
    })

    afterAll(() => {
      setSolveLocalsForTest(null)
      resetSketchSolver()
    })

    it(`replays ${seeds.length} of ${fuzzSeeds} seeds through solveLocally`, { timeout: timeoutMs }, async () => {
      let previousTable: ReturnType<typeof persistentTableForTest> = null
      // Trap recovery calls the loader's reset and nothing else does, so its
      // call count is the number of traps. The real reset matters too: a loader
      // that handed back the trapped instance (the old `async () => oc`) ran
      // every later step on the corrupt heap and turned one trap into one
      // violation per remaining step (seed 33).
      let traps = 0
      const resetAfterTrap = (): void => {
        traps++
        resetOcc()
      }
      for (const seed of seeds) {
        // solveLocally's own doc-switch reset is inert here (a fuzz doc carries
        // no id, so every seed is the same cache key), so the fresh cache per
        // seed has to come from this explicit reset. The two assertions are its
        // teeth: drop the reset and the second seed starts on the first seed's
        // live table instead of a null one, and then reuses its object.
        setSolveLocalsForTest(loadOcc, resetAfterTrap)
        expect(persistentTableForTest(), `seed ${seed} cache not reset`).toBeNull()
        // The solves chain through microtasks only, so a long sweep never hands
        // the loop a macrotask turn and vitest's worker RPC replies sit unread
        // until the RPC timer fails the run ("Timeout calling onTaskUpdate").
        await new Promise(resolve => setImmediate(resolve))

        const result = await runFuzzSequence(generateSequence(seed, fuzzSteps), {
          scheduler: createRealSolveScheduler({ trapCount: () => traps }),
          // One macrotask per step: a 40-step seed of synchronous solves held
          // the loop past the 30 s stall limit under load.
          settle: yieldToEventLoop,
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
}
