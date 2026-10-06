// @vitest-environment node
//
// Real-solver check for the `dock` constraint -- the materialize half of lazy
// inferred materialization. A point docked to a `tangent(A, B)` host lowers to
// two coincident-to-locus pins (A and B as curves) reusing the existing
// r_coincident primitive -- no new solver constraint. The docked point must:
//   1. hold the host's contact after a real solve,
//   2. ride the contact when a curve moves, and
//   3. float (no pin) once the host tangent is deleted.
//
// Skips when the Rust solver build is absent.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { loadSolver } from '../loadSolver'
import { lowerSketch } from '../lowerSketch'
import { encodeInput, decodeOutput } from '../codec'
import { partDocToSketches } from '../partDocToSketches'
import { applyAddConstraint, applyAddDock, applyMoveEntity, applyDeleteElements } from '@/utils/yamlMutations'

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

// Two circles, externally tangent at (5, 0), held together by a `tangent`
// constraint so the contact is a well-defined host foot.
function tangentDoc(): PartDoc {
  const doc: PartDoc = {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'circA', kind: 'circle' }, { id: 'circB', kind: 'circle' }],
      initial: { circA: [0, 0, 5], circB: [10, 0, 5] },
      constraints: [],
    }],
  }
  applyAddConstraint(doc, 'sk', 'tangent', ['entity:sk:circA', 'entity:sk:circB'])
  return doc
}

const hostId = (doc: PartDoc) => doc.features![0].constraints!.find(c => c.kind === 'tangent')!.id
const pointId = (doc: PartDoc) => doc.features![0].entities!.find(e => e.kind === 'point')!.id
const distTo = (p: number[], c: number[]) => Math.hypot(p[0] - c[0], p[1] - c[1])

describe.skipIf(!bytes)('docked point', () => {
  it('holds the tangent host contact after solve', () => {
    const doc = tangentDoc()
    applyAddDock(doc, 'sk', [5, 0], hostId(doc))

    const solved = solveFeature(doc)
    const p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    // On both loci: distance to each centre equals that circle's radius.
    expect(distTo(p, [solved.circA[0], solved.circA[1]])).toBeCloseTo(solved.circA[2], 4)
    expect(distTo(p, [solved.circB[0], solved.circB[1]])).toBeCloseTo(solved.circB[2], 4)
    expect(p[0]).toBeCloseTo(5, 3)
    expect(p[1]).toBeCloseTo(0, 3)
  })

  it('rides the contact when a curve moves', () => {
    const doc = tangentDoc()
    applyAddDock(doc, 'sk', [5, 0], hostId(doc))
    // Slide circB; the tangent keeps them in contact and the dock rides along.
    applyMoveEntity(doc, 'sk', 'circB', [2, 0])

    const solved = solveFeature(doc)
    const p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    expect(distTo(p, [solved.circA[0], solved.circA[1]])).toBeCloseTo(solved.circA[2], 4)
    expect(distTo(p, [solved.circB[0], solved.circB[1]])).toBeCloseTo(solved.circB[2], 4)
  })

  it('floats when the host tangent is deleted (no pin survives)', () => {
    const doc = tangentDoc()
    applyAddDock(doc, 'sk', [5, 0], hostId(doc))
    // Delete the host constraint: the dangling dock lowers to nothing.
    applyDeleteElements(doc, [`constraint:sk:${hostId(doc)}`])

    const { sketches } = partDocToSketches(doc.features)
    // Nothing references the point any more -- it is a free point.
    expect(sketches[0].sketch.constraints).toHaveLength(0)

    // It still solves (the point just rests at its seed); no NaN, no crash.
    const solved = solveFeature(doc)
    const p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    expect(p[0]).toBeCloseTo(5, 3)
    expect(p[1]).toBeCloseTo(0, 3)
  })

  it('materialize-on-reference: a dock handle in a coincident solves to the contact', () => {
    const doc = tangentDoc()
    // A free point elsewhere; constrain it coincident to the tangent contact by
    // naming the dock handle. The interception materializes the contact point and
    // rewrites the coincident to it.
    const sk = doc.features![0]
    sk.entities!.push({ id: 'free', kind: 'point' })
    sk.initial!['free'] = [3, 4]
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:free:xy', `dock:sk:${hostId(doc)}`])

    const solved = solveFeature(doc)
    const mat = doc.features![0].entities!.filter(e => e.kind === 'point').map(e => e.id)
    expect(mat).toHaveLength(2)
    const contactId = mat.find(id => id !== 'free')!
    const c = solved[contactId]
    const f = solved.free
    // Contact sits on both circles and the free point rode to it.
    expect(distTo(c, [solved.circA[0], solved.circA[1]])).toBeCloseTo(solved.circA[2], 4)
    expect(distTo(c, [solved.circB[0], solved.circB[1]])).toBeCloseTo(solved.circB[2], 4)
    expect(f[0]).toBeCloseTo(c[0], 4)
    expect(f[1]).toBeCloseTo(c[1], 4)
  })

  it('is idempotent: docking the same host twice reuses the point', () => {
    const doc = tangentDoc()
    applyAddDock(doc, 'sk', [5, 0], hostId(doc))
    applyAddDock(doc, 'sk', [5, 0], hostId(doc))
    const points = doc.features![0].entities!.filter(e => e.kind === 'point')
    const docks = doc.features![0].constraints!.filter(c => c.kind === 'dock')
    expect(points).toHaveLength(1)
    expect(docks).toHaveLength(1)
  })
})
