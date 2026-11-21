// @vitest-environment node
//
// End to end through the real sketch solver: a fully constrained rectangle clip
// carries only its internal constraints, so the pasted copy is free to translate
// (DOF 2) and reads as an underconstrained sketch rather than an error. The
// source's fixed origin anchor is exactly what the copy rule breaks. The solve
// is the sketch-only one (solveSketch), so this needs no OCC kernel.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SketchEntitiesClip, SketchFeature } from '@/types/cad'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { initGlobalRepo } from '@/kernel/query'
import { setSketchSolver, setSketchTopology, solveSketch } from '@/kernel/features/sketch'
import { applyPasteSketchEntities } from '@/utils/yamlMutations/sketchPaste'
import { buildSketchClip } from '@/utils/clipboard/sketchClipboard'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { featureById } from '@/testing/featureAccess'

const solveBytes = loadSolver()

const SOURCE = makeSketch('src', {
  plane: '@builtin_plane_front',
  entities: ['b', 'r', 't', 'l'].map(id => ({ id, kind: 'line' })),
  initial: { b: [0, 0, 10, 0], r: [10, 0, 10, 6], t: [10, 6, 0, 6], l: [0, 6, 0, 0] },
  constraints: [
    { id: 'k1', kind: 'coincident', a: '$bend', b: '$rstart' },
    { id: 'k2', kind: 'coincident', a: '$rend', b: '$tstart' },
    { id: 'k3', kind: 'coincident', a: '$tend', b: '$lstart' },
    { id: 'k4', kind: 'coincident', a: '$lend', b: '$bstart' },
    { id: 'h', kind: 'horizontal', target: '$b' },
    { id: 'v', kind: 'vertical', target: '$r' },
    { id: 'h2', kind: 'horizontal', target: '$t' },
    { id: 'v2', kind: 'vertical', target: '$l' },
    { id: 'w', kind: 'length', target: '$b', value: 10 },
    { id: 'ht', kind: 'length', target: '$r', value: 6 },
    { id: 'anchor', kind: 'fixed', target: '$bstart', x: 0, y: 0 },
  ],
}) as SketchFeature

function clipped(): SketchEntitiesClip {
  const built = buildSketchClip(SOURCE, ['b', 'r', 't', 'l'])
  if ('reason' in built) throw new Error(built.reason)
  // The free copy carries no fixed row.
  expect(built.broken).toEqual({ fixed: 1, outside: 0 })
  return built.clip
}

describe.skipIf(!solveBytes)('paste solves as a free copy (real solver)', () => {
  beforeAll(() => {
    setSketchSolver(solveBytes!)
    setSketchTopology(loadTopology())
  })
  afterAll(() => {
    setSketchSolver(null)
    setSketchTopology(null)
  })

  it('a pasted rectangle is underconstrained with two translational DOF, never an error', () => {
    const doc = makeDoc(makeSketch('sk2', { plane: '@builtin_plane_top' }) as SketchFeature)
    applyPasteSketchEntities(doc, { featureId: 'sk2', clip: clipped(), offset: [20, 10] })
    const pasted = featureById(doc, 'sk2', 'sketch')
    expect(pasted.entities).toHaveLength(4)
    expect(pasted.constraints).toHaveLength(10)

    const solved = solveSketch(
      pasted as unknown as Record<string, unknown>,
      initGlobalRepo(),
      {},
    )
    expect(solved.status).toBe('underconstrained')
    expect(solved.dof).toBe(2)
    expect(solved.geometry).toBeDefined()
  })
})
