// Pure curve-curve intersection tests (no topology / OCC). Covers every pair the
// arbitrary area builder needs, plus the tangency = no-point rule.
import { describe, it, expect } from "vitest"
import { intersectCurves, type Curve, type Hit } from "./curveIntersect"

const line = (p0: [number, number], p1: [number, number]): Curve => ({ kind: "line", p0, p1 })
const circle = (c: [number, number], r: number): Curve => ({ kind: "circle", c, r })
const ellipse = (c: [number, number], a: number, b: number, theta = 0): Curve => ({
  kind: "ellipse",
  c,
  a,
  b,
  theta,
})
const bezier = (
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p3: [number, number],
): Curve => ({ kind: "bezier", p0, c1, c2, p3 })

const sortByX = (hs: Hit[]): Hit[] => [...hs].sort((p, q) => p.point[0] - q.point[0])

describe("intersectCurves: closed-form pairs", () => {
  it("line-line crossing X", () => {
    const hits = intersectCurves(line([-1, 0], [1, 0]), line([0, -1], [0, 1]))
    expect(hits).toHaveLength(1)
    expect(hits[0].point[0]).toBeCloseTo(0, 9)
    expect(hits[0].point[1]).toBeCloseTo(0, 9)
    expect(hits[0].tA).toBeCloseTo(0.5, 9)
    expect(hits[0].tB).toBeCloseTo(0.5, 9)
  })

  it("parallel lines: no hit", () => {
    expect(intersectCurves(line([0, 0], [1, 0]), line([0, 1], [1, 1]))).toHaveLength(0)
  })

  it("line through circle: two points", () => {
    const hits = sortByX(intersectCurves(line([-5, 0], [5, 0]), circle([0, 0], 2)))
    expect(hits).toHaveLength(2)
    expect(hits[0].point[0]).toBeCloseTo(-2, 6)
    expect(hits[1].point[0]).toBeCloseTo(2, 6)
  })

  it("circle-circle: two points", () => {
    const hits = intersectCurves(circle([0, 0], 2), circle([2, 0], 2))
    expect(hits).toHaveLength(2)
    for (const h of hits) expect(h.point[0]).toBeCloseTo(1, 6)
  })
})

describe("intersectCurves: line-ellipse", () => {
  it("horizontal line through center hits both x-vertices", () => {
    const hits = sortByX(intersectCurves(line([-10, 0], [10, 0]), ellipse([0, 0], 4, 2)))
    expect(hits).toHaveLength(2)
    expect(hits[0].point[0]).toBeCloseTo(-4, 6)
    expect(hits[1].point[0]).toBeCloseTo(4, 6)
    // eccentric angles at the major-axis vertices are 0 and pi.
    const angs = hits.map((h) => h.tB).sort((a, b) => a - b)
    expect(angs[0]).toBeCloseTo(0, 5)
    expect(angs[1]).toBeCloseTo(Math.PI, 5)
  })

  it("rotated ellipse (theta=90): major axis lies along y", () => {
    const hits = sortByX(intersectCurves(line([-10, 0], [10, 0]), ellipse([0, 0], 4, 2, 90)))
    expect(hits).toHaveLength(2)
    // along x the rotated ellipse spans the minor radius b=2.
    expect(hits[1].point[0]).toBeCloseTo(2, 6)
  })

  it("tangent line touches but does not cross: at most one point", () => {
    const hits = intersectCurves(line([-10, 2], [10, 2]), ellipse([0, 0], 4, 2))
    expect(hits.length).toBeLessThanOrEqual(1)
  })
})

describe("intersectCurves: conic-conic (numeric scan)", () => {
  it("circle cuts an ellipse in 2 points", () => {
    const hits = intersectCurves(ellipse([0, 0], 4, 2), circle([0, 0], 3))
    // a small circle of r=3 crosses the major axis (a=4) on both sides.
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it("two overlapping ellipses cross in (up to) 4 points", () => {
    const hits = intersectCurves(ellipse([0, 0], 4, 2), ellipse([2, 0], 4, 2))
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.length).toBeLessThanOrEqual(4)
  })

  it("disjoint ellipses: no hit", () => {
    expect(intersectCurves(ellipse([0, 0], 1, 1), ellipse([10, 0], 1, 1))).toHaveLength(0)
  })
})

describe("intersectCurves: bezier pairs", () => {
  it("bezier arch crossed by a horizontal line: two points", () => {
    // arch from (0,0) up and back to (4,0); line y=1 cuts it twice.
    const arch = bezier([0, 0], [1, 3], [3, 3], [4, 0])
    const hits = sortByX(intersectCurves(arch, line([-1, 1], [5, 1])))
    expect(hits).toHaveLength(2)
    for (const h of hits) expect(h.point[1]).toBeCloseTo(1, 4)
  })

  it("bezier through a circle", () => {
    // S-curve from (-3,0) through the origin to (3,0): enters and exits r=1.5.
    const s = bezier([-3, 0], [-1, -1], [1, 1], [3, 0])
    const hits = intersectCurves(s, circle([0, 0], 1.5))
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it("bezier through an ellipse", () => {
    const s = bezier([-5, 0], [-2, -1], [2, 1], [5, 0])
    const hits = intersectCurves(s, ellipse([0, 0], 4, 2))
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it("bezier crossing the line's infinite extension (not the segment) yields no hit", () => {
    // short segment x in [0,1] on y=0; the bezier crosses y=0 at x=5, off-segment.
    const seg = line([0, 0], [1, 0])
    const bz = bezier([5, -1], [5, -0.33], [5, 0.33], [5, 1])
    expect(intersectCurves(bz, seg)).toHaveLength(0)
    expect(intersectCurves(seg, bz)).toHaveLength(0)
  })

  it("two crossing beziers (X)", () => {
    const a = bezier([-2, -2], [-1, -1], [1, 1], [2, 2])
    const b = bezier([-2, 2], [-1, 1], [1, -1], [2, -2])
    const hits = intersectCurves(a, b)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].point[0]).toBeCloseTo(0, 3)
    expect(hits[0].point[1]).toBeCloseTo(0, 3)
  })
})
