import { describe, it, expect } from 'vitest'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { applyAddEntity, applyDeleteElements, applyMoveEntity, applyMoveVertex } from '@/utils/yamlMutations/sketch'
import { applyInsertFitPoint, applySetFitSplineHandle } from '@/utils/yamlMutations/fitSpline'
import type { PartConstraint, PartDoc, SketchFeature } from '@/types/cad'

function sketchDoc(entities: SketchFeature['entities'], initial: Record<string, number[]>, constraints: PartConstraint[] = []): PartDoc {
  return makeDoc(makeSketch('sk1', { entities, initial, constraints }))
}

function feature(doc: PartDoc): SketchFeature {
  return doc.features![0] as SketchFeature
}

const FIVE = [0, 0, 1, 2, 2, 0, 3, 2, 4, 0]

describe('add_entity fit_spline', () => {
  it('stores the flat fit points when there are no tangents', () => {
    const doc = sketchDoc([], {})
    applyAddEntity(doc, 'sk1', 'fit_spline', [0, 0, 1, 2, 3, 1], 'sp')
    expect(feature(doc).entities).toEqual([{ id: 'sp', kind: 'fit_spline' }])
    expect(feature(doc).initial!.sp).toEqual([0, 0, 1, 2, 3, 1])
  })

  it('converts unscaled tangents to absolute handles (D2)', () => {
    const doc = sketchDoc([], {})
    applyAddEntity(doc, 'sk1', 'fit_spline', [0, 0, 2, 0], 'sp', {
      tangents: [[0, 1], [-1, 1]], tangentScale: false,
    })
    const def = feature(doc).entities![0]
    expect(def.handles).toBe('both')
    // c1 = P0 + h0*t0/3 = (0, 2/3); c2 = P1 - h1*t1/3 = (2 + 2/3, -2/3).
    const p = feature(doc).initial!.sp
    expect(p[4]).toBe(0)
    expect(p[5]).toBeCloseTo(2 / 3, 5)
    expect(p[6]).toBeCloseTo(2 + 2 / 3, 5)
    expect(p[7]).toBeCloseTo(-2 / 3, 5)
  })

  it('scales the tangents by the OCCT rule by default', () => {
    const doc = sketchDoc([], {})
    applyAddEntity(doc, 'sk1', 'fit_spline', [0, 0, 2, 0], 'sp', {
      tangents: [[0, 1], [-1, 1]],
    })
    const p = feature(doc).initial!.sp
    // n = 2, degree 1: both ends scale to the chord derivative (1, 0), so the
    // start tangent (0, 1) keeps its magnitude and the end (-1, 1) halves.
    expect(p[4]).toBe(0)
    expect(p[5]).toBeCloseTo(2 / 3, 5)
    expect(p[6]).toBeCloseTo(2 + 1 / 3, 5)
    expect(p[7]).toBeCloseTo(-1 / 3, 5)
  })

  it('refuses a zero tangent and a zero-span point list', () => {
    const doc = sketchDoc([], {})
    applyAddEntity(doc, 'sk1', 'fit_spline', [0, 0, 2, 0], 'sp', { tangents: [[0, 0], null] })
    expect(feature(doc).entities).toEqual([])
    applyAddEntity(doc, 'sk1', 'fit_spline', [0, 0, 0, 0], 'sp2')
    expect(feature(doc).entities).toEqual([])
  })
})

describe('positional fit-point edits renumber refs', () => {
  it('insert shifts the ref at the insertion index and leaves the new point unconstrained', () => {
    const doc = sketchDoc(
      [{ id: 'sp', kind: 'fit_spline' }],
      { sp: [...FIVE] },
      [
        { id: 'c1', kind: 'coincident', a: '$spfit1', b: '$spstart' },
        { id: 'c2', kind: 'coincident', a: '$spfit2', b: '$spfit1' },
        { id: 'c3', kind: 'coincident', a: '$spfit3', b: '$spfit1' },
      ] as PartConstraint[],
    )
    applyInsertFitPoint(doc, 'sk1', 'sp', 2, [1.5, 1])
    const f = feature(doc)
    expect(f.initial!.sp).toEqual([0, 0, 1, 2, 1.5, 1, 2, 0, 3, 2, 4, 0])
    // `splice(2, 0, p)` moves the OLD point 2 to index 3, so its ref must become
    // `fit3`; an off-by-one rewrite would leave it on `fit2`, the new point.
    expect(f.constraints!.map(c => c.a)).toEqual(['$spfit1', '$spfit3', '$spfit4'])
    expect(f.constraints!.map(c => c.b)).toEqual(['$spstart', '$spfit1', '$spfit1'])
    expect(f.constraints!.some(c => c.a === '$spfit2')).toBe(false)
  })

  it('delete drops the deleted point constraints and shifts the rest down', () => {
    const doc = sketchDoc(
      [{ id: 'sp', kind: 'fit_spline' }],
      { sp: [...FIVE] },
      [
        { id: 'c2', kind: 'coincident', a: '$spfit2', b: '$spfit1' },
        { id: 'c3', kind: 'coincident', a: '$spfit3', b: '$spfit1' },
        { id: 'c4', kind: 'coincident', a: '$spfit4', b: '$spfit1' },
      ] as PartConstraint[],
    )
    applyDeleteElements(doc, ['vertex:sk1:sp:fit2'])
    const f = feature(doc)
    expect(f.initial!.sp).toEqual([0, 0, 1, 2, 3, 2, 4, 0])
    expect(f.constraints!.map(c => c.id)).toEqual(['c3', 'c4'])
    expect(f.constraints!.map(c => (c.a as string))).toEqual(['$spfit2', '$spfit3'])
  })

  it('deleting two fit points at once removes exactly the two the caller named', () => {
    // Applying the targets in order would delete the original fit2, then read
    // `fit3` against the renumbered four-point list and delete the original
    // fit4 instead. Collecting the indices per entity and applying them
    // high-to-low keeps both names pointing at the caller's points.
    const doc = sketchDoc(
      [{ id: 'sp', kind: 'fit_spline' }],
      { sp: [...FIVE] },
      [
        { id: 'c2', kind: 'coincident', a: '$spfit2', b: '$spfit1' },
        { id: 'c3', kind: 'coincident', a: '$spfit3', b: '$spfit1' },
        { id: 'c4', kind: 'coincident', a: '$spfit4', b: '$spfit1' },
      ] as PartConstraint[],
    )
    applyDeleteElements(doc, ['vertex:sk1:sp:fit2', 'vertex:sk1:sp:fit3'])
    const f = feature(doc)
    // Points 0, 1 and 4 survive: [0,0], [1,2], [4,0].
    expect(f.initial!.sp).toEqual([0, 0, 1, 2, 4, 0])
    expect(f.constraints!.map(c => c.id)).toEqual(['c4'])
    // The original fit4 is now the second point of the remaining list.
    expect(f.constraints![0].a).toBe('$spfit2')
  })

  it('set_fit_spline_handle adds and removes a handle with its constraints', () => {
    const doc = sketchDoc(
      [{ id: 'sp', kind: 'fit_spline' }],
      { sp: [...FIVE] },
      [{ id: 'c1', kind: 'coincident', a: '$spc1', b: '$spfit1' }] as PartConstraint[],
    )
    applySetFitSplineHandle(doc, 'sk1', 'sp', 'start', [0.5, 1])
    expect(feature(doc).entities![0].handles).toBe('start')
    expect(feature(doc).initial!.sp.slice(10, 12)).toEqual([0.5, 1])
    applySetFitSplineHandle(doc, 'sk1', 'sp', 'start', null)
    expect(feature(doc).entities![0].handles).toBeUndefined()
    expect(feature(doc).constraints).toEqual([])
  })
})

describe('fit spline drag writes', () => {
  // Five fit points then the two absolute handles (D2): 14 params.
  const BOTH = [0, 0, 1, 2, 2, 0, 3, 2, 4, 0, -1, 0, 5, 0]

  const bothDoc = (): PartDoc =>
    sketchDoc([{ id: 'sp', kind: 'fit_spline', handles: 'both' }], { sp: [...BOTH] })

  it('a fit<k> drag moves only that point', () => {
    const doc = bothDoc()
    applyMoveVertex(doc, 'sk1', 'sp', 'fit2', [9, 9])
    expect(feature(doc).initial!.sp).toEqual([0, 0, 1, 2, 9, 9, 3, 2, 4, 0, -1, 0, 5, 0])
  })

  it('an edge drag translates every fit point and both handles', () => {
    const doc = bothDoc()
    applyMoveEntity(doc, 'sk1', 'sp', [10, 20])
    expect(feature(doc).initial!.sp).toEqual([
      10, 20, 11, 22, 12, 20, 13, 22, 14, 20, 9, 20, 15, 20,
    ])
  })
})
