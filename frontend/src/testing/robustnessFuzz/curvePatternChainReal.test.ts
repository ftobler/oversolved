// @vitest-environment node
//
// The curve-pattern family's pinned seeds: chains whose curve-array tail walks
// a path through the real kernel (the `splitChainReal` pattern). A generator or
// runner change that stops reaching the kind, or that turns one of these into a
// refusal, fails here by seed instead of hiding in the sweep's aggregate.
//
// Skips when OCC.js is absent, like every *Real suite.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { generateRecipe } from '@/testing/robustnessFuzz/recipe'
import { runChain } from '@/testing/robustnessFuzz/chain'

const oc = await loadOcc()

// One seed per spacing mode, and one that turns the copies (tangent) beside one
// that only translates them (fixed).
const PINNED: readonly { seed: number; spacing: 'equal' | 'distance'; orientation: 'tangent' | 'fixed' }[] = [
  { seed: 10, spacing: 'equal', orientation: 'tangent' },
  { seed: 8, spacing: 'equal', orientation: 'fixed' },
  { seed: 3, spacing: 'distance', orientation: 'tangent' },
  { seed: 6, spacing: 'distance', orientation: 'tangent' },
  { seed: 9, spacing: 'distance', orientation: 'fixed' },
]

describe.skipIf(!oc)('curve-pattern tail pinned seeds (real OCC)', () => {
  for (const { seed, spacing, orientation } of PINNED) {
    it(`seed ${seed} walks a ${spacing} path, ${orientation}`, () => {
      const recipe = generateRecipe(seed, { curvePatternTail: true })
      const tail = recipe.steps.at(-1)
      expect(tail?.kind).toBe('curve-array')
      if (tail?.kind !== 'curve-array') return
      expect(tail.spacing).toBe(spacing)
      expect(tail.orientation).toBe(orientation)

      const run = runChain(oc!, recipe)
      expect(run.violations).toEqual([])
      const last = run.reports.at(-1)
      expect(last?.kind).toBe('curve-array')
      expect(last?.status, last?.error).toBe('built')
    }, 240_000)
  }
})
