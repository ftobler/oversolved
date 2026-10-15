// @vitest-environment node
//
// The seeded geometry fuzz against the real kernel: every seed's recipe is
// replayed step by step through the leaf feature solvers, checked after every
// step (see chain.ts for the invariant list), then replayed once more under a
// one-grid-step upstream dimension change to prove every recorded pick still
// resolves. A failing seed is minimised by dropping steps while the violation
// persists, and the minimal recipe is written as a regression fixture.
//
// Every replay runs in a forked child with a wall-clock watchdog (chainTimeout,
// mirroring kernel/solveTimeout): an OCC call can spin forever in synchronous
// WASM and no in-process timer can interrupt it. A killed run is reported with
// the step that hung; KNOWN_HANGS pins the ones already triaged (the browser
// worker's own watchdog handles them in production), and any other hang fails
// the sweep like a violation.
//
// The default sweep is bounded for the PR gate; ROBUSTNESS_FUZZ_SEEDS widens it
// for `just robustness-fuzz` and the nightly. The suite skips where OCC.js is
// not installed, like every *Real suite.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { minimizeSequence } from '@/hooks/__tests__/fuzzMinimizer'
import { generateRecipe, type RecipeStep } from './recipe'
import { runChain } from './chain'
import { disposeChainChild, runChainWithTimeout } from './chainTimeout'
import { writeMinimalRecipe, defaultRegressionsDir } from './regressions'

const oc = await loadOcc()

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// The bounded default keeps the PR gate fast; the recipe and the nightly widen
// it (200 is the plan's acceptance range, 1500 the nightly's). The budget per
// seed covers the base replay, the persistence replay and an amortised share of
// the watchdog kills (a hanging seed costs the full 30 s).
const SEEDS = envInt('ROBUSTNESS_FUZZ_SEEDS', 24)
const BUDGET_MS = 2_500
const TIMEOUT_MS = Math.min(90 * 60_000, 120_000 + SEEDS * BUDGET_MS)
// The watchdog ceiling per replay, the same 30 s the browser worker gives a
// solve; a healthy chain step is well under a second.
const REPLAY_TIMEOUT_MS = 30_000
// Minimisation replays are prefixes of a recipe the sweep already ran, so they
// are cheaper than a full seed; this keeps a hanging candidate from dominating
// the reduction.
const MINIMIZE_TIMEOUT_MS = 10_000

// Known kernel hangs, pinned by seed. A seed here is reported as known; any
// hang NOT on this list fails the sweep with the seed and hung step. All three
// are the same OCC 7.5 hazard: ShapeUpgrade_UnifySameDomain spins inside the
// fuse clean when the welded shapes have exactly coincident faces. The browser
// worker survives a spin by killing the worker (solverClient's watchdog); the
// fuzz child is its test-side equivalent. Triage (2026-10-15):
//   47  the second circular-array instance fuse of a chamfered, ball-cut body.
//   76  mirror-merge of a 270 degree revolve about a plane holding its seam.
//   149 mirror-merge of a 270 degree revolve about the seam's symmetry plane.
const KNOWN_HANGS: readonly { seed: number; step: number; kind: string }[] = [
  { seed: 47, step: 4, kind: 'circular-array' },
  { seed: 76, step: 1, kind: 'mirror' },
  { seed: 149, step: 1, kind: 'mirror' },
]

// Known red picks, pinned by seed and step. The naming check reaches the step
// and the recorded face UUID is dead in the perturbed body, which production's
// resolver would also report as a miss: the sibling faces carry DIFFERENT
// construction UUIDs, and the foreign-uuid exclusion (queryRepository) forbids
// handing one back in place of the named face. Triaged as a real naming
// fragility awaiting its own fix, not silenced: the message stays in the log.
const KNOWN_STALE_PICKS: readonly { seed: number; step: number; note: string }[] = [
  {
    seed: 142,
    step: 4,
    note: 'hole face @sk_s3/p1 re-mints under a +2.5 mm box growth: the base uuid included a two-classifier name, the rebuild a one-classifier sibling, and neither is recoverable from the other',
  },
]

afterAll(() => {
  disposeChainChild()
})

describe.skipIf(!oc)('the seeded geometry fuzz (real kernel)', () => {
  it('replays the bounded seed range: no violation, no stale pick', { timeout: TIMEOUT_MS }, async () => {
    const problems: string[] = []
    const hangs: string[] = []
    const redPicks: string[] = []
    let completed = 0
    let refusals = 0
    let modifierBuilds = 0
    let untrackedBuilds = 0
    let checkedPicks = 0

    for (let seed = 0; seed < SEEDS; seed++) {
      const recipe = generateRecipe(seed)
      const guarded = await runChainWithTimeout(recipe, { timeoutMs: REPLAY_TIMEOUT_MS })
      if (guarded.status === 'hang') {
        // The pin names the step too: a hang that MOVES to another step is a
        // changed finding and needs its own triage, not the old note.
        const known = KNOWN_HANGS.some((h) => h.seed === seed && h.step === guarded.hang.step)
        const text = `seed ${seed}: HANG at step ${guarded.hang.step} (${guarded.hang.kind})`
        if (known) hangs.push(text)
        else problems.push(`${text}; not in KNOWN_HANGS (add it with the triage note if accepted)`)
        continue
      }
      const { run, stale } = guarded.replay
      for (const report of run.reports) {
        if (report.status !== 'built') continue
        if (report.kind !== 'start') modifierBuilds++
        if (report.trackCount === 0) untrackedBuilds++
      }
      refusals += run.refusals.length
      if (run.completed) completed++
      checkedPicks += run.picks.length

      if (run.violations.length > 0) {
        // Reduce while the failure persists, then write the minimal recipe so
        // the seed replay does not depend on the generator drawing it again.
        const minimal = await minimizeSequence(
          recipe.steps,
          async (candidate) => {
            const replay = await runChainWithTimeout(
              { seed, steps: [...candidate] }, { timeoutMs: MINIMIZE_TIMEOUT_MS },
            )
            if (replay.status === 'hang') return true
            return replay.replay.run.violations.length > 0
          },
        )
        const file = writeMinimalRecipe(defaultRegressionsDir(), {
          seed,
          violations: run.violations.map((v) => `step ${v.step}: ${v.message}`),
          steps: minimal,
        })
        problems.push(`seed ${seed}: ${run.violations.map((v) => `step ${v.step}: ${v.message}`).join('; ')} (minimal: ${file})`)
        continue
      }
      if (run.refusals.length > 0) continue
      for (const violation of stale) {
        const known = KNOWN_STALE_PICKS.find((p) => p.seed === seed && p.step === violation.step)
        const text = `seed ${seed} step ${violation.step}: ${violation.message}`
        if (known) redPicks.push(text)
        else problems.push(text)
      }
    }

    // Known findings are not silent: a green run prints them, and the wide
    // range (the nightly) is what keeps both lists honest.
    for (const hang of hangs) console.log(`[robustness-fuzz] known hang: ${hang}`)
    for (const red of redPicks) console.log(`[robustness-fuzz] known red pick: ${red}`)
    expect(problems).toEqual([])
    // Non-vacuity: the sweep has to reach real feature solves, not stop at
    // start-only chains. The floors are a fraction of the observed coverage so
    // a bounded range that legitimately refuses stays green while a generator
    // that stops drawing edits (or a runner that stops reaching the kernel)
    // fails.
    expect(completed).toBeGreaterThan(0)
    expect(modifierBuilds).toBeGreaterThanOrEqual(Math.ceil(SEEDS / 2))
    expect(untrackedBuilds).toBe(0)
    expect(checkedPicks).toBeGreaterThan(0)
    expect(refusals).toBeLessThanOrEqual(SEEDS)
  })

  it('same seed replays the identical chain and the identical reports', { timeout: 60_000 }, async () => {
    const recipe = generateRecipe(11)
    expect(generateRecipe(11)).toEqual(recipe)
    const first = await runChainWithTimeout(recipe)
    const second = await runChainWithTimeout(recipe)
    if (first.status !== 'done' || second.status !== 'done') throw new Error('a pinned recipe hung')
    expect(first.replay.run.violations).toEqual([])
    expect(second.replay.run.violations).toEqual([])
    // Reports carry the per-step CountingScope traffic, so equal reports pin
    // the disposal traffic flat across identical runs: a leak that accumulates
    // per run would move one of the counters.
    expect(second.replay.run.reports).toEqual(first.replay.run.reports)
    expect(second.replay.run.refusals).toEqual(first.replay.run.refusals)
  })
})

describe.skipIf(!oc)('the recipe minimiser', () => {
  // A recipe long enough to have steps to drop AND one that builds end to end
  // through the watchdog: the injected fault only lands on a step that builds,
  // so a recipe the generator drew with a refused start (seed 1's revolve is
  // the pinned case) could never carry it. The generator's length is
  // seed-dependent, so scan for one instead of pinning a fragile seed.
  async function multiStepRecipe(): Promise<{ seed: number; steps: RecipeStep[] }> {
    for (let seed = 0; seed < 200; seed++) {
      const recipe = generateRecipe(seed)
      if (recipe.steps.length < 5) continue
      const guarded = await runChainWithTimeout(recipe)
      if (guarded.status === 'done' && guarded.replay.run.completed) {
        return { seed, steps: recipe.steps }
      }
    }
    throw new Error('no seed drew a five-step recipe that builds')
  }

  it('reduces a failing chain to the step that carries the failure and writes it out', { timeout: 120_000 }, async () => {
    const { seed, steps } = await multiStepRecipe()
    const fault = steps[2]
    // The fault seam is in-process only (runChain's faultAtId), so the guard
    // here is the recipe scan above; the injected run itself is cheap.
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const fails = async (candidate: readonly RecipeStep[]): Promise<boolean> =>
      runChain(oc, { seed, steps: [...candidate] }, { faultAtId: fault.id }).violations.length > 0

    expect(await fails(steps)).toBe(true)
    const minimal = await minimizeSequence(steps, fails)

    // The start step cannot be dropped: without its body every later step
    // refuses, the injected fault never builds, and the predicate would be
    // false. So the fixpoint is the start plus the faulting step.
    expect(minimal).toEqual([steps[0], fault])
    const tmpRoot = join(process.cwd(), '..', 'tmp')
    mkdirSync(tmpRoot, { recursive: true })
    const dir = mkdtempSync(join(tmpRoot, 'robustness-fuzz-test-'))
    const file = writeMinimalRecipe(dir, { seed, violations: ['injected fault'], steps: minimal })
    const written = JSON.parse(readFileSync(file, 'utf8')) as { seed: number; steps: RecipeStep[] }
    expect(written.seed).toBe(seed)
    expect(written.steps).toEqual(minimal)
    rmSync(dir, { recursive: true, force: true })
  })
})
