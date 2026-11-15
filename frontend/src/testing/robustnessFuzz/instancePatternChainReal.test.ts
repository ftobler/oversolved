// @vitest-environment node
//
// The instance-pattern family's pinned seeds: chains whose instance-array tail
// copies the running body onto sketch points through the real kernel (the
// `curvePatternChainReal` pattern). A generator or runner change that stops
// reaching the kind, or that turns one of these into a refusal, fails here by
// seed instead of hiding in the sweep's aggregate.
//
// Skips when OCC.js is absent, like every *Real suite.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { generateRecipe } from '@/testing/robustnessFuzz/recipe'
import { runChain } from '@/testing/robustnessFuzz/chain'

const oc = await loadOcc()

// Seeds harvested over 0..39: each chain completes and its last step builds.
const PINNED = [3, 5, 6, 8]

describe.skipIf(!oc)('instance-pattern tail pinned seeds (real OCC)', () => {
  for (const seed of PINNED) {
    it(`seed ${seed} copies the body onto sketch points`, () => {
      const recipe = generateRecipe(seed, { instancePatternTail: true })
      const tail = recipe.steps.at(-1)
      expect(tail?.kind).toBe('instance-array')
      if (tail?.kind !== 'instance-array') return
      expect(tail.points.length).toBeGreaterThanOrEqual(2)

      const run = runChain(oc!, recipe)
      expect(run.violations).toEqual([])
      expect(run.refusals).toEqual([])
      const last = run.reports.at(-1)
      expect(last?.kind).toBe('instance-array')
      expect(last?.status, last?.error).toBe('built')
    }, 240_000)
  }
})
