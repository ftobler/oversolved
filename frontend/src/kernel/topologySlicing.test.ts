// Arbitrary-geometry area builder: ellipses and splines as slice-able geometry.
// Geometry is taken from captured bug reports (bugreports/slice_*, donut_*),
// using the enrichSketchEntity dict form detectTopology consumes.
import { describe, it, expect } from "vitest"
import { detectTopology } from "./topology"
import { TOL_TOPOLOGY_MERGE } from "./solverConstants"

type Geom = Record<string, unknown>

const ellipse = (cx: number, cy: number, a: number, b: number, theta: number): Geom => ({
  kind: "ellipse",
  center: [cx, cy],
  a,
  b,
  theta,
})
const line = (x1: number, y1: number, x2: number, y2: number): Geom => ({ start: [x1, y1], end: [x2, y2] })
const circle = (cx: number, cy: number, r: number): Geom => ({ center: [cx, cy], radius: r })
const spline = (p: number[]): Geom => ({
  kind: "spline",
  start: [p[0], p[1]],
  c1: [p[2], p[3]],
  c2: [p[4], p[5]],
  end: [p[6], p[7]],
})

const E1 = ellipse(0, 0, 5, 2.5, 0)  // the standard test ellipse

describe("area builder: line / arc / circle slicing an ellipse", () => {
  it("slice-line-thru-ellipse-center: minor-axis line splits into 2 areas", () => {
    const topo = detectTopology({ e1: E1, l1: line(0, 2.5, 0, -2.5) }, "sk")
    expect(topo.surfaces).toHaveLength(2)
  })

  it("slice-line-misses-ellipse: untouched ellipse stays 1 area", () => {
    const topo = detectTopology({ e1: E1, l1: line(-10, 8, 10, 8) }, "sk")
    expect(topo.surfaces).toHaveLength(1)
    expect((topo.surfaces[0].boundary as Geom[])[0].kind).toBe("ellipse")
  })

  it("slice-circle-cuts-ellipse: two crossing closed curves", () => {
    const topo = detectTopology({ e1: E1, c1: circle(-5.210583, -2.854166, 6.558725) }, "sk")
    expect(topo.surfaces.length).toBeGreaterThanOrEqual(2)
  })

  // Regression for bugreports/ellipse_slice_error{,2,3}: a chord whose endpoint
  // is constrained onto the rim sits there only to within the solver residual, so
  // the line-end vertex and the line/ellipse intersection computed there must
  // merge for the cut to close. Rather than memorising the three reported points
  // (the end-to-end real-solver check lives in sliceEndpointOnEllipseReal.test.ts)
  // these tests drive the tolerance boundary directly: build a genuine chord A--B
  // and continue the line a controlled `eps` past A (off the rim), so `eps` is
  // exactly the line-end / intersection vertex gap the merge must absorb.
  describe("slice-line-endpoint-near-rim: vertex-merge tolerance boundary", () => {
    const ellAt = (phi: number): [number, number] => [5 * Math.cos(phi), 2.5 * Math.sin(phi)]
    // L large so the off-rim point's *line parameter* stays well inside SPLIT,
    // isolating the world-space MERGE tolerance as the only thing under test.
    const surfaces = (phiA: number, phiB: number, eps: number, L = 100): number => {
      const A = ellAt(phiA)
      const B = ellAt(phiB)
      const n = Math.hypot(A[0] - B[0], A[1] - B[1])
      const dx = (A[0] - B[0]) / n
      const dy = (A[1] - B[1]) / n
      const start = line(B[0] - L * dx, B[1] - L * dy, A[0] + eps * dx, A[1] + eps * dy)
      return detectTopology({ e1: E1, l1: start }, "sk").surfaces.length
    }
    // A moderate chord and a more grazing one (small angle at A amplifies nothing
    // here because eps is the displacement directly -- the boundary is the same).
    const chords: [string, number, number][] = [
      ["moderate", 1.0, 3.0],
      ["grazing", 0.3, 2.8],
    ]
    for (const [name, phiA, phiB] of chords) {
      it(`${name}: closes into 2 areas while the gap stays under MERGE`, () => {
        for (const eps of [1e-9, 1e-8, 1e-7, TOL_TOPOLOGY_MERGE / 2]) {
          expect(surfaces(phiA, phiB, eps)).toBe(2)
        }
      })
      it(`${name}: a gap past MERGE intentionally stops merging (1 area)`, () => {
        expect(surfaces(phiA, phiB, TOL_TOPOLOGY_MERGE * 2)).toBe(1)
      })
    }
  })

  it("slice-arc-cuts-ellipse: an arc divides the ellipse", () => {
    const arc: Geom = {
      center: [-10.458259, -1.701254],
      radius: 10.127272,
      angle_start: -25.292217,
      angle_end: 38.962818,
      start: [-10.458259 + 10.127272 * Math.cos((-25.292217 * Math.PI) / 180), -1.701254 + 10.127272 * Math.sin((-25.292217 * Math.PI) / 180)],
      end: [-10.458259 + 10.127272 * Math.cos((38.962818 * Math.PI) / 180), -1.701254 + 10.127272 * Math.sin((38.962818 * Math.PI) / 180)],
    }
    const topo = detectTopology({ e1: E1, a1: arc }, "sk")
    expect(topo.surfaces.length).toBeGreaterThanOrEqual(2)
  })
})

describe("area builder: spline slicing", () => {
  it("slice-spline-thru-ellipse: spline slashes a full ellipse into areas", () => {
    const s = spline([-2.174095, 5.807216, -2.790440, -3.801748, 2.539267, 4.228380, 1.686274, -4.632326])
    const topo = detectTopology({ e1: E1, s1: s }, "sk")
    expect(topo.surfaces.length).toBeGreaterThanOrEqual(2)
  })

  it("slice-spline-cuts-circle: spline cuts a circle", () => {
    const s = spline([-6, 0, -2, 6, 2, -6, 6, 0])
    const topo = detectTopology({ c1: circle(0, 0, 4), s1: s }, "sk")
    expect(topo.surfaces.length).toBeGreaterThanOrEqual(2)
  })

  it("slice-two-crossing-splines: two splines enclose a region", () => {
    const a = spline([-2.466216, 6.037253, 4.185461, 5.378464, 4.185461, -4.105332, -3.785563, -4.686429])
    const b = spline([4.321234, 6.252959, -4.443252, 4.472412, -2.259706, -5.433049, 5.816597, -2.549292])
    const topo = detectTopology({ a, b }, "sk")
    expect(topo.surfaces.length).toBeGreaterThanOrEqual(1)
  })
})

describe("area builder: ellipse vs ellipse", () => {
  it("slice-ellipse-ellipse-overlap: overlapping ellipses split into regions", () => {
    const e2 = ellipse(-4.581310, -1.561098, 6.832069, 4.222219, -49.414097)
    const topo = detectTopology({ e1: E1, e2 }, "sk")
    expect(topo.surfaces.length).toBeGreaterThanOrEqual(3)
  })

  it("slice-ellipse-ellipse-tangent: tangent ellipses stay separate (no split)", () => {
    const e2 = ellipse(-7.464931, 0, 4.617304, 2.464931, -90)
    const topo = detectTopology({ e1: E1, e2 }, "sk")
    expect(topo.surfaces).toHaveLength(2)
  })
})

describe("area builder: inner loops / donut (even-odd nesting)", () => {
  const holesOf = (s: { holes?: unknown }): unknown[] => (s.holes as unknown[]) ?? []

  it("donut-concentric-circles: one washer area with one hole", () => {
    const topo = detectTopology({ c1: circle(0, 0, 5), c2: circle(0, 0, 2.5) }, "sk")
    expect(topo.surfaces).toHaveLength(1)
    expect(holesOf(topo.surfaces[0])).toHaveLength(1)
  })

  it("donut-concentric-ellipses: one elliptical washer with one hole", () => {
    const topo = detectTopology({ e1: E1, e2: ellipse(0, 0, 4, 1.5, 0) }, "sk")
    expect(topo.surfaces).toHaveLength(1)
    expect(holesOf(topo.surfaces[0])).toHaveLength(1)
  })

  it("donut-circle-in-ellipse: elliptical face with a circular hole", () => {
    const topo = detectTopology({ e1: E1, c1: circle(-1.787076, -0.144848, 1.185717) }, "sk")
    expect(topo.surfaces).toHaveLength(1)
    expect(holesOf(topo.surfaces[0])).toHaveLength(1)
    // outer boundary is the ellipse, the hole is the circle.
    expect((topo.surfaces[0].boundary as Geom[])[0].kind).toBe("ellipse")
  })

  it("donut-rect-two-holes: one rectangle face with two holes", () => {
    const rect = {
      l1: line(-5, -5, 5, -5),
      l2: line(5, -5, 5, 5),
      l3: line(5, 5, -5, 5),
      l4: line(-5, 5, -5, -5),
    }
    const topo = detectTopology(
      { ...rect, c1: circle(-1.911068, 2.247443, 1.223361), c2: circle(1.787360, -2.300799, 1.534329) },
      "sk",
    )
    expect(topo.surfaces).toHaveLength(1)
    expect(holesOf(topo.surfaces[0])).toHaveLength(2)
  })

  it("nest-three-levels: outer-with-hole plus a solid island = 2 areas", () => {
    const topo = detectTopology(
      { c1: circle(0, 0, 7.5), c2: circle(0, 0, 5), c3: circle(0, 0, 2.5) },
      "sk",
    )
    expect(topo.surfaces).toHaveLength(2)
    const withHole = topo.surfaces.filter((s) => holesOf(s).length > 0)
    const islands = topo.surfaces.filter((s) => holesOf(s).length === 0)
    expect(withHole).toHaveLength(1)  // the r7.5 ring (hole = r5)
    expect(islands).toHaveLength(1)  // the r2.5 solid disk
  })
})

describe("area builder: sliced ellipse produces ellipse_arc edges (repr)", () => {
  it("repr-half-ellipse-edge: a diameter line yields ellipse_arc boundary edges", () => {
    const topo = detectTopology({ e1: E1, l1: line(0, 2.5, 0, -2.5) }, "sk")
    const kinds = topo.surfaces.flatMap((s) => (s.boundary as Geom[]).map((e) => e.kind))
    expect(kinds).toContain("ellipse_arc")
    expect(kinds).toContain("line")
    // each ellipse_arc carries an eccentric angle range.
    const arc = topo.surfaces
      .flatMap((s) => s.boundary as Geom[])
      .find((e) => e.kind === "ellipse_arc")!
    expect(typeof arc.angle_start_deg).toBe("number")
    expect(typeof arc.angle_end_deg).toBe("number")
    expect(arc.id).toBe("e1")
  })
})

describe("area builder: degenerate / robustness", () => {
  it("degen-line-tangent-ellipse: a tangent line does not split the ellipse", () => {
    const topo = detectTopology({ e1: E1, l1: line(-6, 2.5, 6, 2.5) }, "sk")
    expect(topo.surfaces).toHaveLength(1)
    expect((topo.surfaces[0].boundary as Geom[])[0].kind).toBe("ellipse")
  })

  it("degen-duplicate-ellipses: two identical ellipses are one area", () => {
    const topo = detectTopology({ e1: E1, e2: ellipse(0, 0, 5, 2.5, 0) }, "sk")
    expect(topo.surfaces).toHaveLength(1)
  })

  it("degen-high-eccentricity: a>>b ellipse slices cleanly", () => {
    const topo = detectTopology({ e1: ellipse(0, 0, 10, 0.5, 0), l1: line(0, 3, 0, -3) }, "sk")
    expect(topo.surfaces).toHaveLength(2)
  })

  it("degen-intersect-at-vertex: a near-vertex slice does not throw", () => {
    // captured bug geometry: vertical line meeting the ellipse near its major vertex.
    const topo = detectTopology(
      { e1: ellipse(0, 0, 4.9997, 2.2511, -2.922), l1: line(-4.9932, 1.2516, -4.9932, -2.2482) },
      "sk",
    )
    expect(topo.surfaces.length).toBeGreaterThanOrEqual(1)
  })
})

describe("area builder: lineage / query parity", () => {
  it("lineage-subedge-ancestry: every sliced ellipse sub-edge references its source id", () => {
    const topo = detectTopology({ e1: E1, l1: line(0, 2.5, 0, -2.5) }, "sk")
    const arcs = topo.surfaces.flatMap((s) => (s.boundary as Geom[]).filter((e) => e.kind === "ellipse_arc"))
    expect(arcs.length).toBeGreaterThanOrEqual(2)
    for (const a of arcs) expect(a.id).toBe("e1")
    // the surface ancestry query references the ellipse entity.
    for (const s of topo.surfaces) expect(s.query as string).toContain("e1")
  })

  it("lineage-region-classifiers: the two halves get distinct side classifiers", () => {
    const topo = detectTopology({ e1: E1, l1: line(0, 2.5, 0, -2.5) }, "sk")
    expect(topo.surfaces).toHaveLength(2)
    const tokenSets = topo.surfaces.map((s) => ((s.classifiers as string[]) ?? []).join(","))
    expect(tokenSets[0]).not.toEqual(tokenSets[1])  // distinguishable left vs right
    expect(tokenSets.every((t) => t.includes("cls_ld_l1"))).toBe(true)
  })
})
