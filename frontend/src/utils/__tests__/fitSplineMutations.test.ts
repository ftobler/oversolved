import { describe, it, expect } from 'vitest'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { applyAddEntity, applyDeleteElements } from '@/utils/yamlMutations/sketch'
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
  it('insert shifts every later fit ref by one', () => {
    const doc = sketchDoc(
      [{ id: 'sp', kind: 'fit_spline' }],
      { sp: [...FIVE] },
      [
        { id: 'c3', kind: 'coincident', a: '$spfit3', b: '$spfit1' },
        { id: 'c4', kind: 'coincident', a: '$spfit4', b: '$spfit1' },
      ] as PartConstraint[],
    )
    applyInsertFitPoint(doc, 'sk1', 'sp', 2, [1.5, 1])
    const f = feature(doc)
    expect(f.initial!.sp).toEqual([0, 0, 1, 2, 1.5, 1, 2, 0, 3, 2, 4, 0])
    expect(f.constraints!.map(c => c.a)).toEqual(['$spfit4', '$spfit5'])
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
