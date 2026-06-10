// Pure curve-split tests: de Casteljau sub-Bezier reconstruction + ellipse arc
// endpoints. No topology / OCC.
import { describe, it, expect } from "vitest"
import { splitBezierAt, subdivideBezier, ellipsePointAt, type BezierCtrl } from "./curveSplit"

function bezierAt(c: BezierCtrl, t: number): [number, number] {
  const mt = 1 - t
  const w0 = mt * mt * mt
  const w1 = 3 * mt * mt * t
  const w2 = 3 * mt * t * t
  const w3 = t * t * t
  return [
    w0 * c[0][0] + w1 * c[1][0] + w2 * c[2][0] + w3 * c[3][0],
    w0 * c[0][1] + w1 * c[1][1] + w2 * c[2][1] + w3 * c[3][1],
  ]
}

const C: BezierCtrl = [
  [0, 0],
  [1, 3],
  [3, 3],
  [4, 0],
]

describe("subdivideBezier", () => {
  it("a sub-segment evaluates to the same points as the original curve", () => {
    const seg = subdivideBezier(C, 0.25, 0.75)
    for (let i = 0; i <= 10; i++) {
      const s = i / 10
      const local = bezierAt(seg, s)  // param along the sub-segment
      const global = bezierAt(C, 0.25 + s * (0.75 - 0.25))  // mapped onto original
      expect(local[0]).toBeCloseTo(global[0], 9)
      expect(local[1]).toBeCloseTo(global[1], 9)
    }
  })

  it("subdivide over [0,1] returns the original curve", () => {
    const seg = subdivideBezier(C, 0, 1)
    for (let i = 0; i <= 4; i++) {
      const t = i / 4
      expect(bezierAt(seg, t)[0]).toBeCloseTo(bezierAt(C, t)[0], 9)
      expect(bezierAt(seg, t)[1]).toBeCloseTo(bezierAt(C, t)[1], 9)
    }
  })

  it("splitBezierAt joins back at the cut point", () => {
    const [left, right] = splitBezierAt(C, 0.4)
    expect(left[3][0]).toBeCloseTo(right[0][0], 12)
    expect(left[3][1]).toBeCloseTo(right[0][1], 12)
    expect(left[3][0]).toBeCloseTo(bezierAt(C, 0.4)[0], 9)
  })
})

describe("ellipsePointAt", () => {
  it("eccentric angles 0 and pi/2 land on the semi-axes", () => {
    const v0 = ellipsePointAt([0, 0], 4, 2, 0, 0)
    const v90 = ellipsePointAt([0, 0], 4, 2, 0, Math.PI / 2)
    expect(v0[0]).toBeCloseTo(4, 9)
    expect(v0[1]).toBeCloseTo(0, 9)
    expect(v90[0]).toBeCloseTo(0, 9)
    expect(v90[1]).toBeCloseTo(2, 9)
  })

  it("rotation theta=90 swaps the axes", () => {
    const v0 = ellipsePointAt([1, 1], 4, 2, 90, 0)
    expect(v0[0]).toBeCloseTo(1, 9)
    expect(v0[1]).toBeCloseTo(5, 9)  // major axis (a=4) now along +y
  })
})
