// @vitest-environment node
//
// The appended RecipeLoft fuzz step against the real kernel. The seeded sweep
// (chainReal.test.ts) pins the safety contract for the whole chain; this focused
// replay pins that the loft step actually BUILDS for some seeds rather than
// being refused everywhere, and that the store invariants hold across it.
//
// The loft is appended to every recipe, so every seed carries one: the scan
// below needs no pinned seed list, and the floor is a non-vacuity guard, not a
// coverage figure.
//
// Skips when OCC.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { generateRecipe } from './recipe'
import { runChain } from './chain'
import type { OccModule } from '@/kernel/occ/occTypes'

const oc = await loadOcc()

// The same bounded range the PR-gate sweep replays.
const SEEDS = 24
// How many of them must build their loft step. Measured on this generator: 6
// build (the rest refuse on a degenerate section); the floor keeps a generator
// that stops drawing a buildable loft from passing silently.
const MIN_BUILT = 3

describe.skipIf(!oc)('RecipeLoft fuzz step (real kernel)', () => {
  it('builds the loft step for some seeds, with no violation anywhere', { timeout: 120_000 }, () => {
    let reached = 0
    let built = 0
    for (let seed = 0; seed < SEEDS; seed++) {
      const run = runChain(oc as OccModule, generateRecipe(seed))
      expect(run.violations, `seed ${seed}`).toEqual([])
      // The runner stops at the first refusal, so a seed whose drawn chain
      // refused earlier never reaches the appended step.
      const loftReport = run.reports.find((r) => r.kind === 'loft')
      if (loftReport === undefined) continue
      reached++
      if (loftReport.status === 'built') built++
    }
    expect(reached).toBeGreaterThanOrEqual(MIN_BUILT)
    expect(built).toBeGreaterThanOrEqual(MIN_BUILT)
  })
})
