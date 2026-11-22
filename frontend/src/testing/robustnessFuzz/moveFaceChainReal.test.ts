// @vitest-environment node
//
// The move-face tail in the chain generator: a small seeded chain that reaches
// a move_face and survives the chain's invariants (one valid solid per body,
// positive volume, the handle table balanced). The direct tweak has no slab
// fallback, so a refusal on a curved start is recorded as a normal stop; the
// deterministic box chain pins a build and a second move chained on the first.
//
// Skips when OCC.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { generateRecipe, PRIMARY_PART, type Recipe } from '@/testing/robustnessFuzz/recipe'
import { runChain } from '@/testing/robustnessFuzz/chain'

const oc = await loadOcc()

describe.skipIf(!oc)('move-face chain (real OCC)', () => {
  it('a box chain moves one face, then another on the moved body', () => {
    const recipe: Recipe = {
      seed: 7,
      steps: [
        { kind: 'start', id: 'seed', body: PRIMARY_PART, shape: 'box', size: [10, 10, 10], arcRadius: 0, angleDeg: 0 },
        { kind: 'move-face', id: 'mf1', target: PRIMARY_PART, face: 0, distance: 2.5 },
        { kind: 'move-face', id: 'mf2', target: PRIMARY_PART, face: 1, distance: 2.5 },
      ],
    }
    const run = runChain(oc!, recipe)
    expect(run.violations).toEqual([])
    expect(run.reports.map((r) => r.kind)).toEqual(['start', 'move-face', 'move-face'])
    for (const report of run.reports) {
      expect(report.status, report.error).toBe('built')
    }
    expect(run.reports.at(-1)?.bodies).toBe(1)
  }, 240_000)

  it('the generated tail reaches a move_face and keeps the invariants', () => {
    for (const seed of [3, 5, 9]) {
      const recipe = generateRecipe(seed, { moveFaceTail: true })
      const tail = recipe.steps.at(-1)
      expect(tail?.kind).toBe('move-face')
      const run = runChain(oc!, recipe)
      expect(run.violations, `seed ${seed}`).toEqual([])
      const last = run.reports.at(-1)
      expect(last?.kind).toBe('move-face')
      // A refusal is a legitimate stop on a curved start; the chain must never
      // crash or leave a half-applied body, and a build must be one valid solid.
      if (last?.status === 'built') expect(last.bodies).toBeGreaterThanOrEqual(1)
      else expect(last?.status).toBe('refused')
    }
  }, 240_000)
})
