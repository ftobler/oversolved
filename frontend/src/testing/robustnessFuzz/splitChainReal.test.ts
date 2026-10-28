// @vitest-environment node
//
// The split family's pinned seeds: one per keep mode, each a chain whose split
// tail BUILDS (the `shellChainReal` pattern). A generator or runner change that
// stops reaching the split, or that turns one of these into a refusal, fails
// here by seed instead of hiding in the sweep's aggregate.
//
// Skips when OCC.js is absent, like every *Real suite.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { generateRecipe } from '@/testing/robustnessFuzz/recipe'
import { runChain } from '@/testing/robustnessFuzz/chain'

const oc = await loadOcc()

const PINNED: readonly { seed: number; keep: 'above' | 'below' | 'both' }[] = [
  { seed: 9, keep: 'above' },
  { seed: 5, keep: 'below' },
  { seed: 19, keep: 'both' },
]

describe.skipIf(!oc)('split-tail pinned seeds (real OCC)', () => {
  for (const { seed, keep } of PINNED) {
    it(`seed ${seed} keeps ${keep} and builds the split step`, () => {
      const recipe = generateRecipe(seed, { splitTail: true })
      const tail = recipe.steps.at(-1)
      expect(tail?.kind).toBe('split')
      if (tail?.kind !== 'split') return
      expect(tail.keep).toBe(keep)

      const run = runChain(oc!, recipe)
      expect(run.violations).toEqual([])
      const last = run.reports.at(-1)
      expect(last?.kind).toBe('split')
      expect(last?.status, last?.error).toBe('built')
    }, 240_000)
  }
})
