// @vitest-environment node
//
// The RecipeShell fuzz step against the real kernel. The seeded sweep pins the
// safety contract; this focused replay pins that the step actually builds a
// shell (not just that refusals are tolerated) for two frozen seeds that draw
// one, and that the store invariants hold across it.
//
// Skips when OCC.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { generateRecipe } from './recipe'
import { runChain } from './chain'
import type { OccModule } from '@/kernel/occ/occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('RecipeShell fuzz step (real kernel)', () => {
  // Seeds whose chains draw a shell step after a start body.
  const SHELL_SEEDS = [23, 93]

  for (const seed of SHELL_SEEDS) {
    it(`seed ${seed} builds its shell step without a violation`, { timeout: 60_000 }, () => {
      const run = runChain(oc as OccModule, generateRecipe(seed))
      expect(run.violations).toEqual([])
      const shellReport = run.reports.find((r) => r.kind === 'shell')
      expect(shellReport, `seed ${seed} no longer draws a shell step`).toBeDefined()
      expect(shellReport!.status).toBe('built')
    })
  }
})
