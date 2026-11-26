// The piece-rewrite engine's pure half: where a point lies on a curve and how a
// curve cuts into exact pieces. The document plan is pinned through the split
// applier in utils/__tests__/yamlMutations.splitEntity.test.ts.

import { describe, it, expect } from 'vitest'
import { arcSweep, cutEntity, pointOnEntity, splitBezier } from '../sketchPieces'
import { bezierEval, type Pt } from '../fitSpline'

describe('pointOnEntity', () => {
  it('reports the line t and the perpendicular distance', () => {
    const on = pointOnEntity('line', [0, 0, 10, 0], [2.5, 0])!
    expect(on.param).toBeCloseTo(0.25, 12)
    expect(on.distance).toBe(0)
    expect(on.inSpan).toBe(true)
    const near = pointOnEntity('line', [0, 0, 10, 0], [5, 0.0004])!
    expect(near.param).toBeCloseTo(0.5, 12)
    expect(near.distance).toBeCloseTo(0.0004, 12)
    const past = pointOnEntity('line', [0, 0, 10, 0], [12, 3])!
    expect(past.param).toBeCloseTo(1.2, 12)
    expect(past.distance).toBeCloseTo(3, 12)
    expect(past.inSpan).toBe(false)
  })

  it('reports the arc angle measured from the start and flags a point outside the sweep', () => {
    // A quarter arc from 0 to 90 degrees.
    const arc = [0, 0, 10, 0, 90]
    const on = pointOnEntity('arc', arc, [10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6)])!
    expect(on.param).toBeCloseTo(30, 10)
    expect(on.distance).toBeLessThan(1e-12)
    expect(on.inSpan).toBe(true)
    const near = pointOnEntity('arc', arc, [0, 10.5])!
    expect(near.param).toBeCloseTo(90, 10)
    expect(near.distance).toBeCloseTo(0.5, 12)
    const outside = pointOnEntity('arc', arc, [-10, 0])!
    expect(outside.inSpan).toBe(false)
    // A sweep through the seam orders along the arc, past 360.
    const wrap = pointOnEntity('arc', [0, 0, 10, 350, 20], [10, 0])!
    expect(wrap.param).toBeCloseTo(360, 10)
    expect(wrap.inSpan).toBe(true)
  })

  it('reports a circle angle in [0, 360)', () => {
    const on = pointOnEntity('circle', [5, 5, 2], [5, 3])!
    expect(on.param).toBeCloseTo(270, 10)
    expect(on.inSpan).toBe(true)
    expect(pointOnEntity('circle', [5, 5, 2], [5, 9])!.distance).toBeCloseTo(2, 12)
  })

  it('reports the Bezier t of the closest foot', () => {
    const spline = [0, 0, 10, 20, 30, 20, 40, 0]
    const ctrl: Pt[] = [[0, 0], [10, 20], [30, 20], [40, 0]]
    const at = bezierEval(ctrl, 0.3)
    const on = pointOnEntity('spline', spline, at)!
    expect(on.param).toBeCloseTo(0.3, 8)
    expect(on.distance).toBeLessThan(1e-9)
    const off = pointOnEntity('spline', spline, [at[0], at[1] + 1])!
    expect(off.distance).toBeGreaterThan(0.5)
  })

  it('answers null for a kind it cannot place a point on', () => {
    expect(pointOnEntity('ellipse', [0, 0, 5, 3, 0], [5, 0])).toBeNull()
    expect(pointOnEntity('point', [0, 0], [0, 0])).toBeNull()
  })
})

describe('cutEntity', () => {
  it('cuts a line into two blocks meeting at the cut whose union is the line', () => {
    const pieces = cutEntity('line', [0, 0, 8, 4], [0.25])!
    expect(pieces).toEqual([
      { kind: 'line', params: [0, 0, 2, 1] },
      { kind: 'line', params: [2, 1, 8, 4] },
    ])
  })

  it('sorts several line cuts', () => {
    const pieces = cutEntity('line', [0, 0, 10, 0], [0.75, 0.25])!
    expect(pieces.map(p => p.params)).toEqual([[0, 0, 2.5, 0], [2.5, 0, 7.5, 0], [7.5, 0, 10, 0]])
  })

  it('keeps an arc centre and radius and splits its angles', () => {
    const pieces = cutEntity('arc', [1, 2, 5, 10, 100], [40])!
    expect(pieces).toEqual([
      { kind: 'arc', params: [1, 2, 5, 10, 40] },
      { kind: 'arc', params: [1, 2, 5, 40, 100] },
    ])
    // Through the seam the cut angle folds back into [0, 360).
    const wrap = cutEntity('arc', [0, 0, 1, 350, 20], [365])!
    expect(wrap.map(p => p.params.slice(3))).toEqual([[350, 5], [5, 20]])
    for (const piece of wrap) expect(arcSweep(piece.params[3], piece.params[4])).toBeCloseTo(15, 9)
  })

  it('cuts a circle at two points into two arcs covering 360 degrees', () => {
    const pieces = cutEntity('circle', [0, 0, 3], [300, 60])!
    expect(pieces).toEqual([
      { kind: 'arc', params: [0, 0, 3, 60, 300] },
      { kind: 'arc', params: [0, 0, 3, 300, 60] },
    ])
    const total = pieces.reduce((sum, p) => sum + arcSweep(p.params[3], p.params[4]), 0)
    expect(total).toBeCloseTo(360, 12)
    expect(cutEntity('circle', [0, 0, 3], [10])).toBeNull()
  })

  it('splits a Bezier by de Casteljau into halves through the original samples', () => {
    const ctrl: Pt[] = [[0, 0], [30, 100], [70, -40], [100, 50]]
    const pieces = cutEntity('spline', ctrl.flat(), [0.4])!
    const [head, tail] = splitBezier(ctrl, 0.4)
    expect(pieces[0].params).toEqual(head.flat())
    expect(pieces[1].params).toEqual(tail.flat())
    const asCtrl = (p: number[]): Pt[] => [[p[0], p[1]], [p[2], p[3]], [p[4], p[5]], [p[6], p[7]]]
    let worst = 0
    for (let i = 0; i <= 50; i++) {
      const u = i / 50
      const a = bezierEval(asCtrl(pieces[0].params), u)
      const b = bezierEval(ctrl, 0.4 * u)
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]))
      const c = bezierEval(asCtrl(pieces[1].params), u)
      const d = bezierEval(ctrl, 0.4 + 0.6 * u)
      worst = Math.max(worst, Math.hypot(c[0] - d[0], c[1] - d[1]))
    }
    expect(worst).toBeLessThan(1e-12)
  })

  it('re-expresses a second Bezier cut on the remaining tail', () => {
    const ctrl: Pt[] = [[0, 0], [10, 40], [60, 40], [80, 0]]
    const pieces = cutEntity('spline', ctrl.flat(), [0.25, 0.75])!
    expect(pieces).toHaveLength(3)
    const joint1 = bezierEval(ctrl, 0.25)
    const joint2 = bezierEval(ctrl, 0.75)
    expect(pieces[0].params[6]).toBeCloseTo(joint1[0], 12)
    expect(pieces[1].params[0]).toBeCloseTo(joint1[0], 12)
    expect(pieces[1].params[6]).toBeCloseTo(joint2[0], 12)
    expect(pieces[2].params[7]).toBe(0)
  })

  it('refuses a cut at or past an end', () => {
    expect(cutEntity('line', [0, 0, 1, 0], [0])).toBeNull()
    expect(cutEntity('line', [0, 0, 1, 0], [1.2])).toBeNull()
    expect(cutEntity('arc', [0, 0, 1, 0, 90], [90])).toBeNull()
    expect(cutEntity('ellipse', [0, 0, 2, 1, 0], [0.5])).toBeNull()
  })

  it('refuses repeated cuts and a short or non-finite block', () => {
    expect(cutEntity('line', [0, 0, 1, 0], [0.5, 0.5])).toBeNull()
    expect(cutEntity('circle', [0, 0, 1], [10, 370])).toBeNull()
    expect(cutEntity('line', [], [0.5])).toBeNull()
    expect(cutEntity('arc', [0, 0, Number.NaN, 0, 90], [45])).toBeNull()
  })
})
