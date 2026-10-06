// @vitest-environment node
//
// Real-solver check for materialized intersection points. A point pinned to two
// curves via coincident-to-locus constraints (the locus form of coincident,
// authored by applyAddPointAtIntersection) must sit on BOTH curves after the
// real Rust solve, and keep sitting on both when a circle moves. This is the
// proof that "also constrainable" works with the existing primitive -- no new
// solver constraint, no wasm change.
//
// Skips when the Rust solver build is absent.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { loadSolver } from '../loadSolver'
import { lowerSketch } from '../lowerSketch'
import { encodeInput, decodeOutput } from '../codec'
import { partDocToSketches } from '../partDocToSketches'
import { applyAddPointAtIntersection, applyMoveEntity } from '@/utils/yamlMutations'

const bytes = loadSolver()

function solveFeature(doc: PartDoc): Record<string, number[]> {
  const { sketches, skipped } = partDocToSketches(doc.features)
  expect(skipped).toHaveLength(0)
  expect(sketches).toHaveLength(1)
  const { input, layout } = lowerSketch(sketches[0].sketch)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const solved: Record<string, number[]> = {}
  for (const l of layout) solved[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  return solved
}

// Two circles, externally tangent at (5, 0) in the initial geometry.
function tangentCirclesDoc(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'circA', kind: 'circle' }, { id: 'circB', kind: 'circle' }],
      initial: { circA: [0, 0, 5], circB: [10, 0, 5] },
      constraints: [],
    }],
  }
}

const pointId = (doc: PartDoc) => doc.features![0].entities!.find(e => e.kind === 'point')!.id
const distTo = (p: number[], c: number[]) => Math.hypot(p[0] - c[0], p[1] - c[1])

describe.skipIf(!bytes)('materialized intersection point', () => {
  it('lands on both circles at the tangency', () => {
    const doc = tangentCirclesDoc()
    applyAddPointAtIntersection(doc, 'sk', [5, 0], ['circA', 'circB'])

    const solved = solveFeature(doc)
    const p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    // On both loci: distance to each centre equals that circle's radius.
    expect(distTo(p, [solved.circA[0], solved.circA[1]])).toBeCloseTo(solved.circA[2], 4)
    expect(distTo(p, [solved.circB[0], solved.circB[1]])).toBeCloseTo(solved.circB[2], 4)
    // The tangency is at (5, 0); the point holds there.
    expect(p[0]).toBeCloseTo(5, 3)
    expect(p[1]).toBeCloseTo(0, 3)
  })

  it('stays on both curves after a circle moves', () => {
    const doc = tangentCirclesDoc()
    applyAddPointAtIntersection(doc, 'sk', [5, 0], ['circA', 'circB'])
    // Slide circB inward so the two circles now overlap (intersect at two points).
    applyMoveEntity(doc, 'sk', 'circB', [-1, 0])

    const solved = solveFeature(doc)
    const p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    // The coincidences rode along: the point is still on both loci.
    expect(distTo(p, [solved.circA[0], solved.circA[1]])).toBeCloseTo(solved.circA[2], 4)
    expect(distTo(p, [solved.circB[0], solved.circB[1]])).toBeCloseTo(solved.circB[2], 4)
  })
})
