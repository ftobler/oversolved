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
// The seed range is scheduled through a bounded pool of watchdog children
// (ROBUSTNESS_FUZZ_WORKERS, default 2) with the results slotted by seed, then
// aggregated, ordered and minimised in one ascending-seed pass: the findings
// and their order do not depend on the pool width (sweep.ts).
//
// The default sweep is bounded for the PR gate; ROBUSTNESS_FUZZ_SEEDS widens it
// for `just fuzz-geometry` and the main gate. The suite skips where OCC.js is
// not installed, like every *Real suite, and on a Node too old to run the
// watchdog child (--experimental-strip-types needs 22.6).

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { minimizeSequence } from '@/hooks/__tests__/fuzzMinimizer'
import { generateRecipe, type RecipeStep } from './recipe'
import { runChain } from './chain'
import { chainWorkerCount, configureChainWorkers, disposeChainChild, runChainWithTimeout, type ChainPhase } from './chainTimeout'
import { runSeedsBounded } from './sweep'
import { writeMinimalRecipe, defaultRegressionsDir } from './regressions'

// The watchdog child runs the sources through --experimental-strip-types,
// which Node only has from 22.6. package.json still allows 20.19 and the CI
// matrix runs 20, so on an older Node the child cannot start at all: skip
// rather than report every seed as a crash. Same guard as fullDocRegression.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)

// Resolving the package is enough to gate: the sweep's kernel work runs in the
// forked children, and the parent's own OCC (needed only by the minimiser's
// in-process fault injection) is loaded lazily in that test so the sweep fork
// holds one kernel, not two.
const occAvailable = occInstalled()

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// The bounded default keeps the PR gate fast; the recipe and the main gate widen
// it (200 is the plan's acceptance range, 1500 the main gate's). The budget per
// seed covers the fresh child's kernel load (~1.5 s, chainTimeout), the base
// replay, the persistence replay and an amortised share of the watchdog kills
// (a hanging seed costs the full 60 s).
const SEEDS = envInt('ROBUSTNESS_FUZZ_SEEDS', 24)
// The pool bound lives in the test (the source module cannot read process.env
// by convention): 2 keeps the forked OCC kernels inside the runner's memory,
// and the justfile pins VITEST_MAX_FORKS beside it.
configureChainWorkers(envInt('ROBUSTNESS_FUZZ_WORKERS', 2))
const WORKERS = chainWorkerCount()
// Per-seed wall budget. 8 s leaves headroom for a slow arm board (Pi 5, a full
// suite sharing its cores) and is overridable for slower hosts.
const BUDGET_MS = envInt('ROBUSTNESS_FUZZ_BUDGET_MS', 8_000)
// The wall budget covers SEEDS worth of recipes spread over WORKERS children:
// the pool turns the per-seed cost into a per-worker cost, so the cap divides
// with it or a wide run would fail a sweep the job budget still allows.
const TIMEOUT_MS = Math.min(90 * 60_000, 120_000 + Math.ceil(SEEDS / WORKERS) * BUDGET_MS)
// The watchdog's silence window per step: twice the 30 s the browser worker
// gives a solve, so a loaded CI runner has headroom. A healthy chain step is
// well under a second. The timer re-arms on every progress report, so this
// covers one step, not the whole base-plus-persistence replay (which can
// legitimately pass 30 s together).
const REPLAY_TIMEOUT_MS = 60_000
// Minimisation replays are prefixes of a recipe the sweep already ran, so they
// are cheaper than a full seed; this keeps a hanging candidate from dominating
// the reduction.
const MINIMIZE_TIMEOUT_MS = 10_000

// Known kernel hangs, pinned by seed. A seed here is reported as known; any
// hang NOT on this list fails the sweep with the seed and hung step. All but
// one are the same OCCT 7.4.0p1 hazard: ShapeUpgrade_UnifySameDomain spins
// inside the fuse clean when the welded shapes have exactly coincident faces.
// The browser worker survives a spin by killing the worker (solverClient's
// watchdog); the fuzz child is its test-side equivalent. The shell and helix
// generator steps (d03837d7, 7362336a) redrew 1003 of the 1500 recipes, so
// the 2026-10-16 pins all went stale; the 2026-10-17 re-triage replayed each
// new hang alone under a 300 s watchdog. Every fuse below still spun at 300 s
// (mirror, circular-array and one plain union, seed 535; seed 762 joined once
// every recipe ran on a fresh kernel). Seed 268 is not a spin: its perturbed
// rebuild's shell spends ~22 s in MakeThickSolidByJoin before refusing
// build_not_done (backlog.md). The liveness window re-arms at that step, so it
// fits on the CI box; it is still pinned in both phases because a slower
// runner can spend more than the 60 s window inside that one call, and the
// kill has to be attributed to the step that owns it either way.
const KNOWN_HANGS: readonly { seed: number; phase: ChainPhase; step: number; kind: string }[] = [
  { seed: 49, phase: 'base', step: 1, kind: 'mirror' },
  { seed: 268, phase: 'persistence', step: 3, kind: 'shell' },
  { seed: 268, phase: 'base', step: 3, kind: 'shell' },
  { seed: 355, phase: 'base', step: 5, kind: 'circular-array' },
  { seed: 378, phase: 'base', step: 3, kind: 'mirror' },
  { seed: 535, phase: 'base', step: 3, kind: 'boolean' },
  { seed: 622, phase: 'base', step: 3, kind: 'circular-array' },
  { seed: 639, phase: 'base', step: 2, kind: 'mirror' },
  { seed: 762, phase: 'base', step: 2, kind: 'mirror' },
  { seed: 1215, phase: 'base', step: 2, kind: 'circular-array' },
  { seed: 1359, phase: 'base', step: 1, kind: 'mirror' },
  { seed: 1469, phase: 'base', step: 2, kind: 'mirror' },
]

// Known red picks, pinned by seed and step. The naming check reaches the step
// and the recorded construction UUID is dead in the perturbed body, which
// production's resolver would also report as a miss: the sibling elements
// carry DIFFERENT construction UUIDs, and the foreign-uuid exclusion
// (queryRepository) forbids handing one back in place of the named element.
// Triaged as a real naming fragility awaiting its own fix, not silenced: the
// message stays in the log. The table was re-triaged on 2026-10-17 after the
// shell and helix steps redrew most recipes, then baselined to exactly the
// set that fires once every recipe runs on a fresh kernel (two 1500-seed runs
// gave identical findings; reused children had flipped picks between runs).
// Three kinds share the pin: a re-mint (the reference goes dead under the
// +2.5 mm growth), an unreached pick (the perturbed chain refused at an
// earlier step, so the reference cannot even be tested, reported only for a
// completed base run), and the refused fuse, chamfer or fillet variant of it.
// The rate holds at about 1 in 50 built references, so a wider range keeps
// surfacing new seeds: the class awaits its own naming fix (backlog.md).
const KNOWN_STALE_PICKS: readonly { seed: number; step: number; note: string }[] = [
  {
    seed: 145,
    step: 3,
    note: 'revolve-start edge @u|e_9310... re-mints under a +2.5 mm growth; the built step reference goes dead while the chain later refuses',
  },
  { seed: 145, step: 4, note: 'unreached: the perturbed chain refused at an earlier step' },
  { seed: 156, step: 2, note: 'edge re-mints under the +2.5 mm growth' },
  {
    seed: 186,
    step: 4,
    note: 'the same re-mint makes the perturbed chain refuse before step 4, so its recorded reference can never be tested',
  },
  {
    seed: 187,
    step: 4,
    note: 'revolve-start face @u|u_9403... re-mints under a +2.5 mm growth; the built step reference goes dead while the chain later refuses',
  },
  { seed: 227, step: 2, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 227, step: 3, note: 'unreached: the perturbed chain refused at an earlier step' },
  { seed: 263, step: 3, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 280, step: 2, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 366, step: 4, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 388, step: 2, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 529, step: 5, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 561, step: 4, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 578, step: 4, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 578, step: 5, note: 'unreached: the perturbed chain refused at an earlier step' },
  { seed: 682, step: 3, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 709, step: 1, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 709, step: 2, note: 'unreached: the perturbed chain refused at an earlier step' },
  { seed: 710, step: 2, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 727, step: 3, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 753, step: 2, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 853, step: 1, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 893, step: 3, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 893, step: 4, note: 'unreached: the perturbed chain refused at an earlier step' },
  { seed: 951, step: 4, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 976, step: 4, note: 'edge re-mints under the +2.5 mm growth' },
  // Surfaced by the arc-join shell fallback (c3f472c2): before it the base
  // shell refused, so the picks were never tested. The arc-join offset of this
  // filleted, drilled box sits on a validity knife edge that follows the heap
  // layout: the CI box refuses the perturbed shell, a local child builds it and
  // a local in-process replay refuses even the base one.
  { seed: 990, step: 3, note: 'unreached: the perturbed shell refused on invalid geometry' },
  { seed: 990, step: 4, note: 'unreached: the perturbed shell refused on invalid geometry' },
  { seed: 1065, step: 4, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1100, step: 2, note: 'unreached: the perturbed fillet refused on invalid geometry' },
  { seed: 1117, step: 3, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1131, step: 3, note: 'unreached: the perturbed fuse refused as unsound' },
  { seed: 1131, step: 4, note: 'unreached: the perturbed fuse refused as unsound' },
  { seed: 1189, step: 1, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1190, step: 2, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1323, step: 2, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 1350, step: 2, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1375, step: 4, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1378, step: 4, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1476, step: 3, note: 'unreached: the perturbed chamfer refused on invalid geometry' },
]

afterAll(() => {
  disposeChainChild()
})

describe.skipIf(!occAvailable || !stripTypes)('the seeded geometry fuzz (real kernel)', () => {
  it('replays the bounded seed range: no violation, no stale pick', { timeout: TIMEOUT_MS }, async () => {
    const problems: string[] = []
    const hangs: string[] = []
    const redPicks: string[] = []
    let completed = 0
    let refusals = 0
    let modifierBuilds = 0
    let untrackedBuilds = 0
    let recordedPicks = 0

    const outcomes = await runSeedsBounded(SEEDS, WORKERS, (seed) =>
      runChainWithTimeout(generateRecipe(seed), { timeoutMs: REPLAY_TIMEOUT_MS })
        .catch((err: unknown) => {
          throw new Error(`seed ${seed}: the watchdog child failed: ${err instanceof Error ? err.message : String(err)}`)
        }))

    // The aggregation is a single ascending-seed pass, exactly like the old
    // serial loop, so the report text, the minimisation order and the fixture
    // writes are identical at any pool width.
    for (let seed = 0; seed < SEEDS; seed++) {
      const guarded = outcomes[seed]
      if (guarded.status === 'hang') {
        // The pin names the step and kind: a hang that MOVES to another step
        // (or kind) is a changed finding and needs its own triage, not the
        // old note.
        const known = KNOWN_HANGS.some((h) =>
          h.seed === seed
          && h.phase === guarded.hang.phase
          && h.step === guarded.hang.step
          && h.kind === guarded.hang.kind)
        const where = guarded.hang.step === null
          ? 'before the first step'
          : `at ${guarded.hang.phase} step ${guarded.hang.step} (${guarded.hang.kind})`
        const text = `seed ${seed}: HANG ${where}`
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
      recordedPicks += run.picks.length

      if (run.violations.length > 0) {
        // Reduce while the failure persists, then write the minimal recipe so
        // the seed replay does not depend on the generator drawing it again.
        const recipe = generateRecipe(seed)
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
      // Stale picks are checked for refused chains too: the runner replays the
      // perturbation whenever a pick was recorded, and a reference that was
      // reached again but no longer resolves is a finding regardless of where
      // the base chain stopped.
      for (const violation of stale) {
        const known = KNOWN_STALE_PICKS.find((p) => p.seed === seed && p.step === violation.step)
        const text = `seed ${seed} step ${violation.step}: ${violation.message}`
        if (known) redPicks.push(text)
        else problems.push(text)
      }
    }

    // Known findings are not silent: a green run prints them, and the wide
    // range (the main gate) is what keeps both lists honest.
    console.log(`[robustness-fuzz] chain sweep: ${SEEDS} seeds, ${completed} completed, ${refusals} refused, ${recordedPicks} picks, ${hangs.length} known hangs, ${redPicks.length} known red picks`)
    for (const hang of hangs) console.log(`[robustness-fuzz] known hang: ${hang}`)
    for (const red of redPicks) console.log(`[robustness-fuzz] known red pick: ${red}`)
    expect(problems).toEqual([])
    // Non-vacuity: the sweep has to reach real feature solves, not stop at
    // start-only chains. The floors are a fraction of the observed coverage so
    // a bounded range that legitimately refuses stays green while a generator
    // that stops drawing edits (or a runner that stops reaching the kernel)
    // fails. Every recipe runs on a fresh kernel, so the refusals are fixed:
    // 11 of these 24 seeds refuse. The cap at three quarters leaves headroom
    // for a generator change and still catches a sweep that refuses nearly
    // everything.
    expect(completed).toBeGreaterThan(0)
    expect(modifierBuilds).toBeGreaterThanOrEqual(Math.ceil(SEEDS / 2))
    expect(untrackedBuilds).toBe(0)
    expect(recordedPicks).toBeGreaterThan(0)
    expect(refusals).toBeLessThanOrEqual(Math.ceil(SEEDS * 0.75))
  })

  // The default start draw is hole-free (box, arc-profile, revolve), so a
  // nested-loop washer never reached this fuzz: the duplicated-hole extrude
  // that shipped a negative-volume washer was invisible here. The ring start
  // forces the most basic holed profile through the same chain checks, whose
  // soundness gate is a strictly positive volume for every body. Persistent
  // naming is not part of this sweep; the default family owns that finding
  // class.
  const RING_SEEDS = envInt('ROBUSTNESS_FUZZ_RING_SEEDS', 8)

  // The split tail is its own seed family: the step is drawn from a derived
  // PRNG (`seed ^ SPLIT_SALT`), so the default sweep's recipes stay
  // byte-identical and its pinned findings keep their seeds. The tail is
  // appended after the drawn chain, so a chain that refuses earlier never
  // reaches it; that is why the floor counts split steps that BUILT, not seeds.
  const SPLIT_SEEDS = envInt('ROBUSTNESS_FUZZ_SPLIT_SEEDS', 24)

  it('replays the split-tail range: no violation and no unexpected refusal', { timeout: Math.min(90 * 60_000, 120_000 + Math.ceil(SPLIT_SEEDS / WORKERS) * BUDGET_MS) }, async () => {
    const problems: string[] = []
    let splitBuilt = 0
    const outcomes = await runSeedsBounded(SPLIT_SEEDS, WORKERS, (seed) =>
      runChainWithTimeout(generateRecipe(seed, { splitTail: true }))
        .catch((err: unknown) => {
          throw new Error(`split seed ${seed}: the watchdog child failed: ${err instanceof Error ? err.message : String(err)}`)
        }))
    for (let seed = 0; seed < SPLIT_SEEDS; seed++) {
      const guarded = outcomes[seed]
      if (guarded.status === 'hang') {
        const where = guarded.hang.step === null
          ? 'before the first step'
          : `at ${guarded.hang.phase} step ${guarded.hang.step} (${guarded.hang.kind})`
        problems.push(`split seed ${seed}: HANG ${where}`)
        continue
      }
      const { run } = guarded.replay
      for (const v of run.violations) problems.push(`split seed ${seed}: step ${v.step}: ${v.message}`)
      const last = run.reports.at(-1)
      if (last?.kind === 'split' && last.status === 'built') splitBuilt++
    }
    console.log(`[robustness-fuzz] split sweep: ${SPLIT_SEEDS} seeds, ${splitBuilt} split steps built`)
    expect(problems).toEqual([])
    // Non-vacuity: the tail has to reach the split on a real share of the range
    // (about half of the first 24 seeds build it), or the sweep proves nothing.
    expect(splitBuilt).toBeGreaterThanOrEqual(Math.ceil(SPLIT_SEEDS / 3))
  })

  it('replays a nested-loop (washer) start range: no violation', { timeout: Math.min(90 * 60_000, 120_000 + Math.ceil(RING_SEEDS / WORKERS) * BUDGET_MS) }, async () => {
    const problems: string[] = []
    let built = 0
    const outcomes = await runSeedsBounded(RING_SEEDS, WORKERS, (seed) =>
      runChainWithTimeout(generateRecipe(seed, { startShape: 'ring' }))
        .catch((err: unknown) => {
          throw new Error(`ring seed ${seed}: the watchdog child failed: ${err instanceof Error ? err.message : String(err)}`)
        }))
    for (let seed = 0; seed < RING_SEEDS; seed++) {
      const guarded = outcomes[seed]
      if (guarded.status === 'hang') {
        const where = guarded.hang.step === null
          ? 'before the first step'
          : `at ${guarded.hang.phase} step ${guarded.hang.step} (${guarded.hang.kind})`
        problems.push(`ring seed ${seed}: HANG ${where}`)
        continue
      }
      const { run } = guarded.replay
      const start = run.reports[0]
      if (start === undefined || start.status !== 'built') {
        problems.push(`ring seed ${seed}: the washer start did not build (${start?.error ?? 'no report'})`)
        continue
      }
      built++
      for (const v of run.violations) problems.push(`ring seed ${seed}: step ${v.step}: ${v.message}`)
    }
    console.log(`[robustness-fuzz] ring sweep: ${RING_SEEDS} seeds, ${built} washer starts built`)
    expect(built).toBeGreaterThan(0)
    expect(problems).toEqual([])
  })

  it('same seed replays the identical chain and the identical reports', { timeout: 60_000 }, async () => {
    const recipe = generateRecipe(11)
    expect(generateRecipe(11)).toEqual(recipe)
    const first = await runChainWithTimeout(recipe)
    const second = await runChainWithTimeout(recipe)
    if (first.status !== 'done' || second.status !== 'done') throw new Error('a pinned recipe hung')
    expect(first.replay.run.violations).toEqual([])
    expect(second.replay.run.violations).toEqual([])
    // Each replay runs on its own fresh child, so this pins determinism across
    // kernels; the leak check on one shared kernel is in its own suite below.
    expect(second.replay.run.reports).toEqual(first.replay.run.reports)
    expect(second.replay.run.refusals).toEqual(first.replay.run.refusals)
  })
})

describe.skipIf(!occAvailable || !stripTypes)('the recipe minimiser', () => {
  // A recipe long enough to have steps to drop AND one that builds end to end
  // through the watchdog: the injected fault only lands on a step that builds,
  // so a recipe the generator drew with a refused start (seed 1's revolve is
  // the pinned case) could never carry it. The generator's length is
  // seed-dependent, so scan for one instead of pinning a fragile seed. The
  // scan is sequential and stops at the first hit: it replays full chains and
  // must not walk the whole bounded range.
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
    // The fault seam is in-process only (runChain's faultAtId), so the parent
    // loads OCC here; the watchdog children are disposed first so the two
    // kernels never coexist in this fork.
    disposeChainChild()
    const oc = await loadOcc()
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
    try {
      const file = writeMinimalRecipe(dir, { seed, violations: ['injected fault'], steps: minimal })
      const written = JSON.parse(readFileSync(file, 'utf8')) as { seed: number; steps: RecipeStep[] }
      expect(written.seed).toBe(seed)
      expect(written.steps).toEqual(minimal)
    } finally {
      // A failing assertion above must not leave the scratch recipe behind.
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!occAvailable)('one kernel replaying a seed twice', () => {
  it('reports the identical disposal traffic both times', { timeout: 60_000 }, async () => {
    // The watchdog pool never reuses a kernel, so the in-process kernel is the
    // only place an accumulating leak can show. Reports carry the per-step
    // CountingScope traffic: a leak that grows per run moves a counter.
    disposeChainChild()
    const oc = await loadOcc()
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const recipe = generateRecipe(11)
    const first = runChain(oc, recipe)
    const second = runChain(oc, recipe)
    expect(first.violations).toEqual([])
    expect(second.reports).toEqual(first.reports)
    expect(second.refusals).toEqual(first.refusals)
  })
})

// The pins were grown by hand from a wide sweep, so a duplicate key is a
// transcription slip that would silently make one finding cover for another.
// This runs without a kernel, so it guards the tables on every leg.
describe('the robustness fuzz pin tables', () => {
  it('keys every pin by a unique seed and step', () => {
    const hangKeys = KNOWN_HANGS.map((h) => `${h.seed}:${h.phase}:${h.step}`)
    expect(new Set(hangKeys).size).toBe(hangKeys.length)
    const pickKeys = KNOWN_STALE_PICKS.map((p) => `${p.seed}:${p.step}`)
    expect(new Set(pickKeys).size).toBe(pickKeys.length)
  })
})
