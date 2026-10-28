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
import { generateRecipe, PRIMARY_BODY, type Recipe } from '@/testing/robustnessFuzz/recipe'
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

  // A one-sided split can disconnect the kept side: a U (a block with a channel
  // cut out of its middle) split above the channel floor keeps the two arms as
  // two bodies. The invariant used to demand exactly one body for a one-sided
  // keep, so this is the case that pins the count rule and the side check on
  // every piece.
  it('a kept side that disconnects reports every arm, all on the kept side', () => {
    const recipe: Recipe = {
      seed: 0,
      steps: [
        { kind: 'start', id: 'seed', body: PRIMARY_BODY, shape: 'box', size: [10, 6, 10], arcRadius: 0, angleDeg: 0 },
        // A channel from y = 2.5 through the top and the full depth leaves a
        // full-width base with one arm on either side.
        {
          kind: 'boolean', id: 's1', operation: 'subtract', target: PRIMARY_BODY,
          tool: 'box', toolId: 'tool_s1', toolBody: 'body_tool_s1',
          size: [5, 5, 12], anchor: 'min', offset: [1, 1, 0],
        },
        // The drawn plane snaps to y = 2.5 (the channel floor), so keep above
        // keeps the two arms and drops the base.
        { kind: 'split', id: 's2', target: PRIMARY_BODY, axis: 'y', fraction: 0.3, keep: 'above' },
      ],
    }
    const run = runChain(oc!, recipe)
    expect(run.violations).toEqual([])
    expect(run.refusals).toEqual([])
    const last = run.reports.at(-1)
    expect(last?.kind).toBe('split')
    expect(last?.status, last?.error).toBe('built')
    expect(last?.bodies).toBe(2)
  })
})
