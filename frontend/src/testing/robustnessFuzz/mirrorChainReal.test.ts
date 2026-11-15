// @vitest-environment node
//
// The feature-mirror family's pinned seeds: a chain whose feature-subject
// mirror tail BUILDS (the `splitChainReal` pattern). The tail synthesises a cut
// source, runs it, and mirrors that feature, so a generator or runner change
// that stops reaching the path, or that turns a pinned seed into a refusal,
// fails here by seed.
//
// Skips when OCC.js is absent, like every *Real suite.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { generateRecipe } from '@/testing/robustnessFuzz/recipe'
import { runChain } from '@/testing/robustnessFuzz/chain'

const oc = await loadOcc()

const PINNED: readonly number[] = [3, 6, 9, 19]

describe.skipIf(!oc)('feature-mirror-tail pinned seeds (real OCC)', () => {
  for (const seed of PINNED) {
    it(`seed ${seed} builds the feature mirror step`, () => {
      const recipe = generateRecipe(seed, { featureMirrorTail: true })
      const tail = recipe.steps.at(-1)
      expect(tail?.kind).toBe('feature-mirror')
      const run = runChain(oc!, recipe)
      expect(run.violations).toEqual([])
      const last = run.reports.at(-1)
      expect(last?.kind).toBe('feature-mirror')
      expect(last?.status, last?.error).toBe('built')
    }, 240_000)
  }
})
