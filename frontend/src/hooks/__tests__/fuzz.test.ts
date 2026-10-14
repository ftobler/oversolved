// @vitest-environment node
//
// The seeded fuzz ratchet for the session/history engine: random mutation and
// undo/redo sequences over the frozen mutation registry, replayed headlessly
// through DocSession with the real mutation handlers. The invariants after
// every step, the undo-all/redo-all round trip at the end, and the PRNG, the
// sequence generator and the start document live in fuzzHarness.ts; this file
// only sizes the runs and pins the regression seeds.
//
// The default suite is bounded (a handful of seeds); FUZZ_SEEDS and FUZZ_STEPS
// size the long run the `just fuzz` recipe and the nightly carry. The real
// kernel runs where installed, exactly like the other Real suites; the fake
// scheduler covers the history mechanics everywhere.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { createRealSolveScheduler } from './realSolveScheduler'
import {
  generateSequence,
  runFuzzSequence,
  type FuzzStep,
  type FuzzSolver,
} from './fuzzHarness'
import { minimizeSequence } from './fuzzMinimizer'

const oc = await loadOcc()
const solveBytes = loadSolver()

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// The bounded defaults keep the PR gate fast; `just fuzz` widens them.
const FUZZ_SEEDS = envInt('FUZZ_SEEDS', 4)
const FUZZ_STEPS = envInt('FUZZ_STEPS', 6)
const FAKE_SEEDS = envInt('FUZZ_FAKE_SEEDS', 24)
const FAKE_STEPS = envInt('FUZZ_FAKE_STEPS', 16)

function seeds(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i)
}

function fakeSolver(): FuzzSolver {
  const scheduler = createFakeSolveScheduler<PartDoc>()
  return { scheduler, settle: () => scheduler.flush() }
}

async function runFake(seed: number, steps: number, options?: Parameters<typeof runFuzzSequence>[2]) {
  return runFuzzSequence(generateSequence(seed, steps), fakeSolver(), options)
}

describe('the seeded fuzz ratchet (fake scheduler)', () => {
  it.each(seeds(FAKE_SEEDS))('seed %i replays without a violation', async (seed) => {
    const result = await runFake(seed, FAKE_STEPS)
    expect(result.violations).toEqual([])
    expect(result.landedSteps).toBeGreaterThan(0)
  })

  // Document isolation is proven inside every run: undo-all lands on the
  // start doc and redo-all on the newest snapshot, both by deep equality, so
  // no history entry can alias a doc that a later step mutated. This test
  // covers the other direction: a run leaves no state behind for the next one.
  // Minted ids (randomId) differ per run, so docs cannot be compared across
  // runs; a leaked session or history global would move the landed/move counts.
  it('a repeated run lands the same steps and moves on a fresh session', async () => {
    const steps = generateSequence(7, FAKE_STEPS)
    const first = await runFuzzSequence(steps, fakeSolver())
    const second = await runFuzzSequence(steps, fakeSolver())
    expect(first.violations).toEqual([])
    expect(second.violations).toEqual([])
    expect(second.landedSteps).toBe(first.landedSteps)
    expect(second.undoMoves).toBe(first.undoMoves)
    expect(second.redoMoves).toBe(first.redoMoves)
  })
})

// Seeds the ratchet keeps pinned under the PR gate, each to its exact length:
// the minimiser's known fault seed and a sequence long enough to cross the
// 50-entry cap, so the dropped-prefix floor stays exercised by default. A
// fuzz run that finds a genuine failure adds its seed here (with the failing
// message in the note) before the fix, so the fix has a regression test.
const REGRESSION_SEEDS: readonly { seed: number; steps: number; note: string }[] = [
  {
    seed: 15,
    steps: 16,
    note: 'first sequence reaching set_rollback; the minimiser reduces it to that step',
  },
  {
    seed: 8,
    steps: 100,
    note: 'crosses the 50-entry cap, so undo-all lands on the dropped-prefix boundary',
  },
]

describe('the pinned fuzz regressions (fake scheduler)', () => {
  it.each(REGRESSION_SEEDS)('seed $seed ($note) stays fixed', async ({ seed, steps }) => {
    const result = await runFake(seed, steps)
    expect(result.violations).toEqual([])
  })
})

describe.skipIf(!oc || !solveBytes)('the seeded fuzz ratchet (real kernel)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  beforeEach(() => {
    // Each seed gets a fresh cross-solve cache and loader, so no checkpoint
    // from a prior seed can be reused under a doc that merely looks similar.
    setSolveLocalsForTest(async () => oc)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('replays the bounded seeds through solveLocally', { timeout: 300_000 }, async () => {
    for (const seed of seeds(FUZZ_SEEDS)) {
      const result = await runFuzzSequence(generateSequence(seed, FUZZ_STEPS), {
        scheduler: createRealSolveScheduler(),
        settle: () => undefined,
      })
      expect(result.violations, `seed ${seed}`).toEqual([])
    }
  })
})

describe('the fuzz minimiser', () => {
  // The known failing seed: R04 is a designed refusal (dispatching
  // set_rollback without pre-syncing the editor store aborts with a
  // rollback-unsynced fault), and a seed whose sequence contains that step
  // fails against the real session driver when the pre-sync is withheld. The
  // minimiser has to find exactly that step. The length is fixed, not the
  // env-sized FAKE_STEPS: the minimiser test is about the mechanism, and the
  // pinned sequence must not change under a long-run override.
  const ROLLBACK_FAULT_SEED = 15
  const ROLLBACK_FAULT_STEPS = 16

  function hasRollback(steps: readonly FuzzStep[]): boolean {
    return steps.some(step => step.kind === 'mutation' && step.type === 'set_rollback')
  }

  it('pins a known failing seed for the rollback fault', () => {
    const steps = generateSequence(ROLLBACK_FAULT_SEED, ROLLBACK_FAULT_STEPS)
    expect(hasRollback(steps)).toBe(true)
  })

  it('reduces the pinned failing seed to the one step that faults', async () => {
    const steps = generateSequence(ROLLBACK_FAULT_SEED, ROLLBACK_FAULT_STEPS)
    const fails = async (candidate: readonly FuzzStep[]): Promise<boolean> => {
      const result = await runFuzzSequence(candidate, fakeSolver(), { presyncRollback: false })
      return result.violations.length > 0
    }
    expect(await fails(steps)).toBe(true)

    const minimal = await minimizeSequence(steps, fails)

    expect(minimal).toEqual([{ kind: 'mutation', type: 'set_rollback' }])
  })

  it('keeps the order and both steps when the failure needs an undo then a redo', async () => {
    const steps: FuzzStep[] = [
      { kind: 'undo' },
      { kind: 'mutation', type: 'add_sketch' },
      { kind: 'redo' },
    ]
    const fails = (candidate: readonly FuzzStep[]): boolean =>
      candidate.some(step => step.kind === 'undo') && candidate.some(step => step.kind === 'redo')

    expect(await minimizeSequence(steps, fails)).toEqual([{ kind: 'undo' }, { kind: 'redo' }])
  })

  it('returns the sequence unchanged when it does not fail', async () => {
    const steps: FuzzStep[] = [{ kind: 'undo' }, { kind: 'redo' }]
    expect(await minimizeSequence(steps, () => false)).toEqual(steps)
  })
})
