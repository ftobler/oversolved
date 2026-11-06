// @vitest-environment node
//
// The seeded fuzz ratchet for the session/history engine: random mutation and
// undo/redo sequences over the frozen mutation registry, replayed headlessly
// through DocSession with the real mutation handlers. The invariants after
// every step, the undo-all/redo-all round trip at the end, and the PRNG, the
// sequence generator and the start document live in fuzzHarness.ts; this file
// only sizes the runs and pins the regression seeds.
//
// The fake-scheduler half: FUZZ_FAKE_SEEDS and FUZZ_FAKE_STEPS size its long
// run, and it covers the history mechanics on an unprovisioned checkout.
// fuzzRealShard.ts drives the real-kernel ratchet, sized by FUZZ_SEEDS and
// FUZZ_STEPS and split over FUZZ_SHARDS shard files (`just fuzz-session`
// carries all three, and the main gate's `just fuzz` runs it at 200 x 40).
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { stringify } from 'yaml'
import { loadPartDocText } from '@/persistence/docSchema'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import {
  generateSequence,
  runFuzzSequence,
  type FuzzStep,
  type FuzzSolver,
} from './fuzzHarness'
import { minimizeSequence } from './fuzzMinimizer'
import { reportFailureDocs } from './fuzzFailureDocs'
import { envInt } from '@/testing/__tests__/envInt'

// The bounded defaults keep the PR gate fast; `just fuzz-session` widens them.
const FAKE_SEEDS = envInt('FUZZ_FAKE_SEEDS', 24)
const FAKE_STEPS = envInt('FUZZ_FAKE_STEPS', 16)

// The real suite loops its seeds inside one test, so its timeout scales with
// the sweep instead of sitting at a fixed wall: 250 ms per (seed, step) over a
// 60 s floor, capped at 30 minutes. The bounded default (4 x 6) allows 66 s
// for a run measured in about a second; a manual sweep grows its own budget.
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

// The known failing seed: R04 is a designed refusal (dispatching set_rollback
// without pre-syncing the editor store aborts with a rollback-unsynced fault),
// and a seed whose sequence contains that step fails against the real session
// driver when the pre-sync is withheld. The seed is found, not hard-coded: the
// generator draws by index into the registry, so every new mutation type
// reshuffles which seed draws set_rollback (a pinned 15 went stale when
// move/delete face landed). The length is fixed, not the env-sized FAKE_STEPS:
// the minimiser and the repro checks are about the mechanism, and the sequence
// must not change under a long-run override.
const ROLLBACK_FAULT_STEPS = 16
const ROLLBACK_SEED_SEARCH = 200

function hasRollback(steps: readonly FuzzStep[]): boolean {
  return steps.some(step => step.kind === 'mutation' && step.type === 'set_rollback')
}

function rollbackFaultSeed(): number {
  for (let seed = 0; seed < ROLLBACK_SEED_SEARCH; seed++) {
    if (hasRollback(generateSequence(seed, ROLLBACK_FAULT_STEPS))) return seed
  }
  return -1
}

describe('the seeded fuzz ratchet (fake scheduler)', () => {
  it.each(seeds(FAKE_SEEDS))('seed %i replays without a violation', async (seed) => {
    const result = await runFake(seed, FAKE_STEPS)
    reportFailureDocs(seed, result)
    expect(result.violations).toEqual([])
    expect(result.landedSteps).toBeGreaterThan(0)
  })

  // Document isolation is proven inside every run: undo-all lands on the undo
  // stack floor (the start doc when the run never dropped an entry) and
  // redo-all on the newest snapshot, both by deep equality, so no history
  // entry can alias a doc that a later step mutated. This test covers the
  // other direction: a run leaves no state behind for the next one. Minted
  // ids (randomId) differ per run, so docs cannot be compared across runs; a
  // leaked session or history global would move the landed/move counts.
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
// the minimiser's known fault seed and a long mixed sequence. They pin replay
// stability, not the cap: the dedicated cap case below is what proves entries
// are dropped, and seed 8 was measured to reach the cap without ever dropping
// one. A fuzz run that finds a genuine failure adds its seed here (with the
// failing message in the note) before the fix, so the fix has a regression
// test.
const REGRESSION_SEEDS: readonly { seed: number; steps: number; note: string }[] = [
  {
    seed: 15,
    steps: 16,
    note: 'first sequence reaching set_rollback; the minimiser reduces it to that step',
  },
  {
    seed: 8,
    steps: 100,
    note: 'long mixed sequence; measured to reach the 50-entry cap without dropping an entry',
  },
]

describe('the pinned fuzz regressions (fake scheduler)', () => {
  it.each(REGRESSION_SEEDS)('seed $seed ($note) stays fixed', async ({ seed, steps }) => {
    const result = await runFake(seed, steps)
    reportFailureDocs(seed, result)
    expect(result.violations).toEqual([])
  })
})

// The cap itself has to bite: sixty always-landing pushes with no undo between
// them overflow a fifty-entry stack by ten. Asserting the drop directly (the
// stack at the cap, ten entries dropped, undo-all landing short of the start
// doc) means removing pushCapped's slice fails here as well as in the per-step
// "undo stack exceeds the cap" guard. The random sweep cannot pin this: with
// undos mixed in, its stack can reach the cap and then shrink without ever
// pushing onto a full stack.
describe('the history cap', () => {
  it('drops the oldest entries once a run pushes past the cap', async () => {
    // delete_feature is the deliberately unguarded no-op (N04): the first step
    // removes ex1 from the union doc, every later step changes nothing and
    // still pushes an entry.
    const steps: FuzzStep[] = Array.from({ length: MAX_UNDO_DEPTH + 10 }, () =>
      ({ kind: 'mutation', type: 'delete_feature' }) as const)

    const result = await runFuzzSequence(steps, fakeSolver())

    expect(result.violations).toEqual([])
    expect(result.landedSteps).toBe(MAX_UNDO_DEPTH + 10)
    expect(result.maxUndoDepth).toBe(MAX_UNDO_DEPTH)
    expect(result.droppedEntries).toBe(10)
    expect(result.undoAllReachedStart).toBe(false)
  })
})

describe('the fuzz failure document', () => {
  it('captures the failing step as a document the app loader accepts', async () => {
    const seed = rollbackFaultSeed()
    const result = await runFake(seed, ROLLBACK_FAULT_STEPS, { presyncRollback: false })
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.failureDocs.length).toBeGreaterThan(0)
    const loaded = loadPartDocText(stringify(result.failureDocs[0].doc))
    expect(loaded.ok, loaded.ok ? '' : `${loaded.error.field}: ${loaded.error.message}`).toBe(true)
  })
})

describe('the fuzz minimiser', () => {
  it('finds a seed whose sequence draws the rollback fault', () => {
    expect(rollbackFaultSeed()).toBeGreaterThanOrEqual(0)
  })

  it('reduces the failing seed to the one step that faults', async () => {
    const steps = generateSequence(rollbackFaultSeed(), ROLLBACK_FAULT_STEPS)
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
