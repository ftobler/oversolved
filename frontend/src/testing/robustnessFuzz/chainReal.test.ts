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
import { envInt } from '@/testing/__tests__/envInt'

// The watchdog child runs the sources through --experimental-strip-types,
// which Node only has from 22.6. The package floor is now 22.12, so a local
// checkout is always new enough; the guard is retained defensively. Same
// guard as fullDocRegression. No CI leg is that old (the matrix runs 22, 24
// and 26).
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)

// Resolving the package is enough to gate: the sweep's kernel work runs in the
// forked children, and the parent's own OCC (needed only by the minimiser's
// in-process fault injection) is loaded lazily in that test so the sweep fork
// holds one kernel, not two.
const occAvailable = occInstalled()

// Set by the fuzz-geometry recipe and the CI fuzz job. A job that provisions
// OCC.js and the WASM builds must fail, not skip, when they went missing: the
// skip is only a convenience for a local checkout without them.
const requireReal = !!process.env.KERNEL_PROVISIONED || process.env.FUZZ_REQUIRE_REAL === '1'

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
// hang NOT on this list fails the sweep with the seed and hung step. The entries
// this table used to carry were all the same OCCT hazard (found on the 7.4
// kernel): ShapeUpgrade_UnifySameDomain spins inside the fuse clean when the
// welded shapes have exactly coincident faces. The browser worker survives a
// spin by killing the worker (solverClient's watchdog); the fuzz child is its
// test-side equivalent. The shell and helix generator steps (d03837d7, 7362336a)
// redrew 1003 of the 1500 recipes, so the 2026-10-16 pins all went stale; the
// 2026-10-17 re-triage replayed each new hang alone under a 300 s watchdog.
// The 2026-10-31 re-triage ran the whole 1500-seed range with the fired-pin
// ratchet. On the OCCT 8.0.1 kernel the last eight (mirror, circular-array and
// one plain union, seed 535) no longer spin: the 2026-11-15 fuzz-geometry run
// finished every one of them, so the table is empty. A hang at any of those
// seeds now reports as an unexpected hang and must be re-triaged, not excused
// by an old note.
const KNOWN_HANGS: readonly { seed: number; phase: ChainPhase; step: number; kind: string }[] = []

// Known red picks, pinned by seed and step, and by the kind of violation the
// pin describes: the message must carry `match`, so a different failure at the
// same seed and step cannot hide behind an old note. The naming check reaches
// the step and the recorded construction UUID is dead in the perturbed body,
// which production's resolver would also report as a miss: the sibling
// elements carry DIFFERENT construction UUIDs, and the foreign-uuid exclusion
// (queryRepository) forbids handing one back in place of the named element.
// Triaged as a real naming fragility awaiting its own fix, not silenced: the
// message stays in the log. The table was re-triaged on 2026-10-17 after the
// shell and helix steps redrew most recipes, then baselined to exactly the
// set that fires once every recipe runs on a fresh kernel, then re-triaged on
// 2026-10-31 with the fired-pin ratchet (seed 280 step 2 and seed 990 steps 3
// and 4 no longer fire; seed 186 step 4 now reports the re-mint itself rather
// than an unreached chain), then on 2026-11-05 after the short-array per-copy
// fuse moved seed 1476's start-body edge UUID: its perturbed chamfer now
// reaches the pick and reports the re-mint instead of refusing before it.
// Then on 2026-11-09 the table dropped seed 1100 step 2 and seed 1131 steps 3
// and 4: those were generic feature refusals (a fillet radius pre-check, an
// unsound fuse), not dead references. The check now reports an unreached pick
// only when a stale pick stopped the perturbed chain, so a geometry refusal
// cannot masquerade as a naming failure (the shell's validity knife edge
// follows the allocation layout; see backlog.md).
// Then on 2026-11-15 the table dropped seed 976 step 4 and seed 1117 step 3:
// both draw four copies at 120 deg, which the pattern instance model's
// coincidence rule now refuses by name (the last copy lands on the seed), so
// the chain stops at the array and never records the pinned edge pick. The
// refusal is the intended answer and is unit-tested; 21 of the 1500 recipes
// draw such an array, so those chains only lose their tail.
// Two kinds share the pin: a re-mint (the reference goes dead under the +2.5 mm
// growth) and an unreached pick (a stale pick at an earlier step stopped the
// perturbed chain, so the reference cannot even be tested). The rate holds at
// about 1 in 50 built references, so a wider range keeps surfacing new seeds:
// the class awaits its own naming fix (backlog.md).
type PickPin = { seed: number; step: number; match: string; note: string }

const PICK_REMINT_EDGE = 'edge query'
const PICK_REMINT_FACE = 'face query'
const PICK_UNREACHED = 'the perturbed chain did not reach'

const KNOWN_STALE_PICKS: readonly PickPin[] = [
  {
    seed: 145,
    step: 3,
    match: PICK_REMINT_EDGE,
    note: 'revolve-start edge @u|e_9310... re-mints under a +2.5 mm growth; the built step reference goes dead while the chain later refuses',
  },
  { seed: 145, step: 4, match: PICK_UNREACHED, note: 'unreached: a stale pick at an earlier step stopped the chain' },
  { seed: 156, step: 2, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  {
    seed: 186,
    step: 4,
    match: PICK_REMINT_EDGE,
    note: 'edge re-mints under the +2.5 mm growth; the chain reaches the pick again, so the unreached note no longer applies',
  },
  {
    seed: 187,
    step: 4,
    match: PICK_REMINT_FACE,
    note: 'revolve-start face @u|u_9403... re-mints under a +2.5 mm growth; the built step reference goes dead while the chain later refuses',
  },
  { seed: 227, step: 2, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 227, step: 3, match: PICK_UNREACHED, note: 'unreached: a stale pick at an earlier step stopped the chain' },
  {
    seed: 235,
    step: 3,
    match: PICK_REMINT_FACE,
    note: 'OCCT 8: the +2.5 mm perturbed three-copy array cuts the picked bottom face into four sectors, so the parent UUID dies; 7.4 kept the face whole (the 2026-11-04 short-array fix). A face split has no child to hand the parent name to, see backlog',
  },
  { seed: 252, step: 3, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 263, step: 3, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 366, step: 4, match: PICK_REMINT_FACE, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 378, step: 4, match: PICK_REMINT_FACE, note: 'face re-mints under the +2.5 mm growth (the mirror step at 3 no longer hangs on OCCT 8)' },
  { seed: 388, step: 2, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 470, step: 3, match: PICK_REMINT_FACE, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 529, step: 5, match: PICK_REMINT_FACE, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 561, step: 4, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 578, step: 4, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 578, step: 5, match: PICK_UNREACHED, note: 'unreached: a stale pick at an earlier step stopped the chain' },
  { seed: 639, step: 5, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth (the mirror step at 2 no longer hangs on OCCT 8)' },
  { seed: 682, step: 3, match: PICK_REMINT_FACE, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 709, step: 1, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 709, step: 2, match: PICK_UNREACHED, note: 'unreached: a stale pick at an earlier step stopped the chain' },
  { seed: 710, step: 2, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 753, step: 2, match: PICK_REMINT_FACE, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 853, step: 1, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 893, step: 3, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 893, step: 4, match: PICK_UNREACHED, note: 'unreached: a stale pick at an earlier step stopped the chain' },
  { seed: 951, step: 4, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1054, step: 3, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1054, step: 4, match: PICK_UNREACHED, note: 'unreached: a stale pick at an earlier step stopped the chain' },
  { seed: 1065, step: 4, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1189, step: 1, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1190, step: 2, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1323, step: 2, match: PICK_REMINT_FACE, note: 'face re-mints under the +2.5 mm growth' },
  { seed: 1350, step: 2, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1375, step: 4, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1378, step: 4, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth' },
  { seed: 1469, step: 4, match: PICK_REMINT_EDGE, note: 'edge re-mints under the +2.5 mm growth (the mirror step at 2 no longer hangs on OCCT 8)' },
  {
    seed: 1476,
    step: 3,
    match: PICK_REMINT_EDGE,
    note: 'the start body edge @u|e_e5d7... re-mints under the +2.5 mm growth after the short-array per-copy fuse; the reference is now tested and goes dead, so the unreached note no longer applies',
  },
]

// The pin for a violation, or null. The message has to name the pinned class
// too: seed and step alone let a different failure take the old note's place.
function findStalePin(seed: number, step: number, message: string): PickPin | null {
  return KNOWN_STALE_PICKS.find(p => p.seed === seed && p.step === step && message.includes(p.match)) ?? null
}

// Pins in the swept range that did not fire. A pin that stops firing means the
// finding it records moved or was fixed, and the table must be re-triaged
// rather than left to excuse nothing. The tables are parameters so the
// meta-tests can drive them while a real one is legitimately empty.
function unfiredPins(
  seeds: number,
  firedHangs: ReadonlySet<string>,
  firedPicks: ReadonlySet<string>,
  hangPins: readonly { seed: number; phase: ChainPhase; step: number; kind: string }[] = KNOWN_HANGS,
  pickPins: readonly PickPin[] = KNOWN_STALE_PICKS,
): string[] {
  const problems: string[] = []
  for (const pin of hangPins) {
    if (pin.seed >= seeds) continue
    const key = `${pin.seed}:${pin.phase}:${pin.step}`
    if (!firedHangs.has(key)) {
      problems.push(`KNOWN_HANGS pin seed ${pin.seed} ${pin.phase} step ${pin.step} (${pin.kind}) did not fire; re-triage the pin table`)
    }
  }
  for (const pin of pickPins) {
    if (pin.seed >= seeds) continue
    if (!firedPicks.has(`${pin.seed}:${pin.step}`)) {
      problems.push(`KNOWN_STALE_PICKS pin seed ${pin.seed} step ${pin.step} ("${pin.match}") did not fire; re-triage the pin table`)
    }
  }
  return problems
}

afterAll(() => {
  disposeChainChild()
})

// Outside the skipIf suite so the failure is attributed to provisioning rather
// than to a skipped sweep.
describe('the geometry fuzz provisioning guard', () => {
  it.runIf(requireReal)('has OCC.js installed and a Node that can run the watchdog', () => {
    expect(occAvailable, 'oc: OCC.js absent - run `npm run occ:install` or `just install-occ`').toBe(true)
    expect(stripTypes, 'Node < 22.6 cannot run the watchdog child (--experimental-strip-types)').toBe(true)
  })
})

describe.skipIf(!occAvailable || !stripTypes)('the seeded geometry fuzz (real kernel)', () => {
  it('replays the bounded seed range: no violation, no stale pick', { timeout: TIMEOUT_MS }, async () => {
    const problems: string[] = []
    const hangs: string[] = []
    const redPicks: string[] = []
    // Pin keys that actually matched a finding in this sweep. A pin with a
    // seed inside the swept range that never lands here is stale and fails
    // below, named, so the table cannot excuse a finding that moved or went
    // away.
    const firedHangs = new Set<string>()
    const firedPicks = new Set<string>()
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
        if (known) {
          hangs.push(text)
          firedHangs.add(`${seed}:${guarded.hang.phase}:${guarded.hang.step}`)
        } else {
          problems.push(`${text}; not in KNOWN_HANGS (add it with the triage note if accepted)`)
        }
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
        const known = findStalePin(seed, violation.step, violation.message)
        const text = `seed ${seed} step ${violation.step}: ${violation.message}`
        if (known) {
          redPicks.push(text)
          firedPicks.add(`${seed}:${violation.step}`)
          continue
        }
        // A pin at this seed and step whose class does not match is the
        // failure mode the message match exists for: say so rather than
        // reporting it as an unlisted finding.
        const sameSpot = KNOWN_STALE_PICKS.find(p => p.seed === seed && p.step === violation.step)
        problems.push(sameSpot
          ? `${text}; the pin at this seed and step expects "${sameSpot.match}" (re-triage it)`
          : text)
      }
    }

    problems.push(...unfiredPins(SEEDS, firedHangs, firedPicks))

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

  // The 2026-11-09 re-triage: a perturbed chain that stops on a feature
  // refusal must not report the later picks as dead references. Seed 1131's
  // perturbed fuse is unsound and seed 1100's perturbed fillet fails its
  // radius pre-check, both deterministic geometry refusals after a completed
  // base run. Seed 145's perturbed edge re-mints, which is a real stale pick,
  // so its later hole pick still reports as unreached. The shell knife edge
  // that exposed the difference (seed 990) follows the allocation layout and
  // cannot pin the rule itself.
  it('reports an unreached pick only when a stale pick stopped the chain', { timeout: 600_000 }, async () => {
    const cases: readonly { seed: number; steps: number[] }[] = [
      { seed: 1100, steps: [] },
      { seed: 1131, steps: [] },
      { seed: 145, steps: [3, 4] },
    ]
    for (const { seed, steps } of cases) {
      const guarded = await runChainWithTimeout(generateRecipe(seed), { timeoutMs: REPLAY_TIMEOUT_MS })
      expect(guarded.status, `seed ${seed} did not finish`).toBe('done')
      if (guarded.status !== 'done') continue
      // Guard against a vacuous []: the persistence replay only runs for a
      // completed base chain that recorded a pick, so pin those first.
      expect(guarded.replay.run.violations, `seed ${seed}`).toEqual([])
      expect(guarded.replay.run.completed, `seed ${seed}`).toBe(true)
      expect(guarded.replay.run.picks.length, `seed ${seed}`).toBeGreaterThan(0)
      expect(guarded.replay.stale.map((s) => s.step), `seed ${seed}`).toEqual(steps)
    }
  })

  // The 2026-11-04 fuzz failure: batching the fuzz's three-copy arrays moved a
  // source face's UUID under the +2.5 mm perturbed start, so seed 235's hole
  // pick went red. Short arrays went back to the one-at-a-time path
  // (patternPart's chunk gate) and the pick resolved again on 7.4.
  //
  // On OCCT 8 the same perturbed array cuts the picked bottom face into four
  // sectors: the face no longer exists as one face, so the parent UUID dies and
  // the pick is a known re-mint (KNOWN_STALE_PICKS). The base chain still builds
  // and records the pick, the perturbed replay reports exactly that one and
  // stops on it, and nothing is flagged as a violation. If a naming fix lets a
  // split child inherit the parent's UUID, this flips to the green resolution
  // below and the pin comes out with it.
  it('pins the perturbed pick of a short-array seed whose face splits on OCCT 8', { timeout: TIMEOUT_MS }, async () => {
    const guarded = await runChainWithTimeout(generateRecipe(235))
    expect(guarded.status).toBe('done')
    if (guarded.status !== 'done') return
    expect(guarded.replay.run.violations).toEqual([])
    expect(guarded.replay.run.picks.some((pick) => pick.step === 3 && pick.kind === 'face')).toBe(true)
    expect(guarded.replay.run.completed).toBe(true)
    expect(guarded.replay.stale).toHaveLength(1)
    expect(guarded.replay.stale[0].step).toBe(3)
    expect(guarded.replay.stale[0].message).toContain('face query')
    expect(guarded.replay.stale[0].message).toContain('no longer resolves')
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

  // The feature-mirror tail is its own seed family too: the step is drawn from a
  // derived PRNG (`seed ^ FEATURE_MIRROR_SALT`) and synthesises a cut source, so
  // the default sweep and its pinned findings are untouched.
  const FEATURE_MIRROR_SEEDS = envInt('ROBUSTNESS_FUZZ_FEATURE_MIRROR_SEEDS', 24)

  it('replays the feature-mirror-tail range: no violation and no unexpected refusal', { timeout: Math.min(90 * 60_000, 120_000 + Math.ceil(FEATURE_MIRROR_SEEDS / WORKERS) * BUDGET_MS) }, async () => {
    const problems: string[] = []
    let mirrorBuilt = 0
    const outcomes = await runSeedsBounded(FEATURE_MIRROR_SEEDS, WORKERS, (seed) =>
      runChainWithTimeout(generateRecipe(seed, { featureMirrorTail: true }))
        .catch((err: unknown) => {
          throw new Error(`feature mirror seed ${seed}: the watchdog child failed: ${err instanceof Error ? err.message : String(err)}`)
        }))
    for (let seed = 0; seed < FEATURE_MIRROR_SEEDS; seed++) {
      const guarded = outcomes[seed]
      if (guarded.status === 'hang') {
        const where = guarded.hang.step === null
          ? 'before the first step'
          : `at ${guarded.hang.phase} step ${guarded.hang.step} (${guarded.hang.kind})`
        problems.push(`feature mirror seed ${seed}: HANG ${where}`)
        continue
      }
      const { run } = guarded.replay
      for (const v of run.violations) problems.push(`feature mirror seed ${seed}: step ${v.step}: ${v.message}`)
      const last = run.reports.at(-1)
      if (last?.kind === 'feature-mirror' && last.status === 'built') mirrorBuilt++
    }
    console.log(`[robustness-fuzz] feature-mirror sweep: ${FEATURE_MIRROR_SEEDS} seeds, ${mirrorBuilt} mirror steps built`)
    expect(problems).toEqual([])
    expect(mirrorBuilt).toBeGreaterThanOrEqual(Math.ceil(FEATURE_MIRROR_SEEDS / 3))
  })

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

  it('matches a pin only on its seed, step and message class', () => {
    const pin = KNOWN_STALE_PICKS[0]
    const message = `${pin.match} @u|dead no longer resolves`
    expect(findStalePin(pin.seed, pin.step, message)).toBe(pin)
    // A different violation at the same spot does not take the pin's note.
    expect(findStalePin(pin.seed, pin.step, 'a wholly different violation')).toBeNull()
    expect(findStalePin(pin.seed, pin.step + 1, message)).toBeNull()
    expect(findStalePin(pin.seed + 1, pin.step, message)).toBeNull()
  })

  it('names a stale-pick pin whose key no longer matches the sweep', () => {
    // A typo in seed or step makes the pin unreachable; the unfired check has
    // to name it rather than let the typo excuse nothing.
    const pin = KNOWN_STALE_PICKS[0]
    const fired = new Set(KNOWN_STALE_PICKS.map(p => `${p.seed}:${p.step}`))
    fired.delete(`${pin.seed}:${pin.step}`)
    fired.add(`${pin.seed}:${pin.step + 1}`)
    expect(unfiredPins(pin.seed + 1, new Set(), fired)).toContain(
      `KNOWN_STALE_PICKS pin seed ${pin.seed} step ${pin.step} ("${pin.match}") did not fire; re-triage the pin table`,
    )
  })

  it('names a pin inside the swept range that did not fire', () => {
    // A synthetic hang, so the check stays exercised while the real table is
    // legitimately empty (OCCT 8 no longer spins on those unifications).
    const hang = { seed: 7, phase: 'base' as ChainPhase, step: 1, kind: 'mirror' }
    const fired = new Set<string>()
    const problems = unfiredPins(hang.seed + 1, fired, fired, [hang])
    expect(problems).toContain(
      `KNOWN_HANGS pin seed ${hang.seed} ${hang.phase} step ${hang.step} (${hang.kind}) did not fire; re-triage the pin table`,
    )
    // The same table stays quiet outside the swept range.
    expect(unfiredPins(hang.seed, fired, fired, [hang])).not.toContain(
      `KNOWN_HANGS pin seed ${hang.seed} ${hang.phase} step ${hang.step} (${hang.kind}) did not fire; re-triage the pin table`,
    )
  })

  it('accepts the full table when every pin fired', () => {
    const hangs = new Set(KNOWN_HANGS.map(h => `${h.seed}:${h.phase}:${h.step}`))
    const picks = new Set(KNOWN_STALE_PICKS.map(p => `${p.seed}:${p.step}`))
    const widest = Math.max(...KNOWN_HANGS.map(h => h.seed), ...KNOWN_STALE_PICKS.map(p => p.seed)) + 1
    expect(unfiredPins(widest, hangs, picks)).toEqual([])
  })
})
