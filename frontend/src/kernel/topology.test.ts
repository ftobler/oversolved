import { describe, it, expect } from "vitest"
import fixture from "./occ/__fixtures__/topology.json"
import { collinearOverlap, detectTopology } from "./topology"

// Structure and identity-bearing query strings must match Python exactly;
// coordinates are compared within a tight tolerance to absorb cross-language
// transcendental last-bit differences (atan2/sin/cos/hypot). A mismatch reports
// the JSON path so divergence is easy to localize.
const TOL = 1e-9

function assertDeepClose(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === "number") {
    expect(typeof actual, `${path}: type`).toBe("number")
    const a = actual as number
    if (Number.isNaN(expected)) {
      expect(Number.isNaN(a), `${path}`).toBe(true)
      return
    }
    const diff = Math.abs(a - expected)
    const ok = diff <= TOL || diff <= TOL * Math.abs(expected)
    expect(ok, `${path}: ${a} != ${expected} (diff ${diff})`).toBe(true)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path}: expected array`).toBe(true)
    const arr = actual as unknown[]
    expect(arr.length, `${path}: length`).toBe(expected.length)
    expected.forEach((v, i) => assertDeepClose(arr[i], v, `${path}[${i}]`))
    return
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object", `${path}: expected object`).toBe(true)
    const eObj = expected as Record<string, unknown>
    const aObj = actual as Record<string, unknown>
    expect(Object.keys(aObj).sort(), `${path}: keys`).toEqual(Object.keys(eObj).sort())
    for (const k of Object.keys(eObj)) assertDeepClose(aObj[k], eObj[k], `${path}.${k}`)
    return
  }
  // string | boolean | null: exact (queries, kinds, vertex ids, classifiers)
  expect(actual, `${path}`).toBe(expected)
}

describe("detectTopology parity with Python", () => {
  for (const [name, c] of Object.entries(fixture)) {
    it(name, () => {
      const result = detectTopology(
        c.geometry as Record<string, unknown>,
        c.feature_id as string,
      )
      assertDeepClose(result, c.expected, name)
    })
  }
})

// ─── Helpers ───

const lineGeom = (x1: number, y1: number, x2: number, y2: number) => ({
  start: [x1, y1],
  end: [x2, y2],
})

const circleGeom = (cx: number, cy: number, r: number) => ({
  center: [cx, cy],
  radius: r,
})

const arcGeom = (cx: number, cy: number, r: number, aStartDeg: number, aEndDeg: number) => {
  const a0 = (aStartDeg * Math.PI) / 180
  const a1 = (aEndDeg * Math.PI) / 180
  return {
    center: [cx, cy],
    radius: r,
    angle_start: aStartDeg,
    angle_end: aEndDeg,
    start: [cx + r * Math.cos(a0), cy + r * Math.sin(a0)],
    end: [cx + r * Math.cos(a1), cy + r * Math.sin(a1)],
  }
}

const rectGeom = (x0: number, y0: number, x1: number, y1: number) => ({
  bottom: lineGeom(x0, y0, x1, y0),
  right: lineGeom(x1, y0, x1, y1),
  top: lineGeom(x1, y1, x0, y1),
  left: lineGeom(x0, y1, x0, y0),
})

const ns = (result: ReturnType<typeof detectTopology>) => result.surfaces.length
const ni = (result: ReturnType<typeof detectTopology>) =>
  Object.keys(result.intersection_points).length

const COORD_TOL = 1e-6

// ─── Surface counts ───

describe("detectTopology surface counts", () => {
  it("triangle → 1 surface, 0 intersections", () => {
    /** Three lines forming a closed triangle → 1 surface. */
    const r = detectTopology({
      a: lineGeom(0, 0, 2, 0),
      b: lineGeom(2, 0, 1, 2),
      c: lineGeom(1, 2, 0, 0),
    })
    expect(ns(r)).toBe(1)
    expect(ni(r)).toBe(0)  // no new intersections, just shared endpoints
  })

  it("rectangle → 1 surface, 0 intersections", () => {
    /** Four lines forming a closed rectangle → 1 surface. */
    const r = detectTopology(rectGeom(0, 0, 2, 2))
    expect(ns(r)).toBe(1)
    expect(ni(r)).toBe(0)
  })

  it("standalone circle → 1 surface", () => {
    /** A circle with no intersections → 1 surface. */
    const r = detectTopology({ c: circleGeom(1, 1, 1) })
    expect(ns(r)).toBe(1)
    expect(ni(r)).toBe(0)
  })

  it("rectangle with diagonal → 2 surfaces", () => {
    /** Rectangle + diagonal → 2 triangular surfaces. */
    const r = detectTopology({
      ...rectGeom(0, 0, 2, 2),
      diag: lineGeom(0, 0, 2, 2),
    })
    expect(ns(r)).toBe(2)
    expect(ni(r)).toBe(0)  // diagonal shares corners, no new pts
  })

  it("rectangle with horizontal midline → 2 surfaces, 2 intersections", () => {
    /** Rectangle + horizontal line through the middle (intersects edges, not corners) → 2 surfaces. */
    const r = detectTopology({
      ...rectGeom(0, 0, 4, 4),
      mid: lineGeom(-1, 2, 5, 2),
    })
    expect(ns(r)).toBe(2)
    expect(ni(r)).toBe(2)  // two new crossing points
  })

  it("rectangle with vertical midline → 2 surfaces, 2 intersections", () => {
    /** Rectangle + vertical line through the middle → 2 surfaces. */
    const r = detectTopology({
      ...rectGeom(0, 0, 4, 4),
      mid: lineGeom(2, -1, 2, 5),
    })
    expect(ns(r)).toBe(2)
    expect(ni(r)).toBe(2)
  })

  it("rectangle with non-corner diagonal → 2 surfaces", () => {
    /** Rectangle + line whose endpoints sit on two edges (not corners) → 2 surfaces.
     *  The line endpoints already exist as endpoint vertices, so no new
     *  intersection_points are recorded -- but the edges are still split correctly. */
    const r = detectTopology({
      ...rectGeom(0, 0, 4, 4),
      slash: lineGeom(0, 2, 2, 4),
    })
    expect(ns(r)).toBe(2)
  })

  it("circle cut by diameter chord → 2 surfaces", () => {
    /** Circle bisected by a chord through the center → 2 surfaces.
     *  The chord endpoints are exactly on the circle, so they're endpoint vertices,
     *  not counted as new intersection points. */
    const r = detectTopology({
      c: circleGeom(0, 0, 1),
      chord: lineGeom(-1, 0, 1, 0),
    })
    expect(ns(r)).toBe(2)
  })

  it("circle cut by off-center chord → 2 surfaces, 2 intersections", () => {
    /** Circle cut by a chord that does not pass through the center → 2 surfaces. */
    const r = detectTopology({
      c: circleGeom(0, 0, 1),
      chord: lineGeom(-1, 0.5, 1, 0.5),
    })
    expect(ns(r)).toBe(2)
    expect(ni(r)).toBe(2)
  })

  it("two overlapping circles → 3 surfaces, 2 intersections", () => {
    /** Two overlapping circles → 3 surfaces: left lune, overlap, right lune. */
    const r = detectTopology({
      c1: circleGeom(-0.5, 0, 1),
      c2: circleGeom(0.5, 0, 1),
    })
    expect(ns(r)).toBe(3)
    expect(ni(r)).toBe(2)
  })

  it("semicircle arc + diameter → 1 surface", () => {
    /** Upper semicircle arc + diameter line → 1 surface (half-disk). */
    const r = detectTopology({
      semi: arcGeom(0, 0, 1, 0, 180),
      diam: lineGeom(-1, 0, 1, 0),
    })
    expect(ns(r)).toBe(1)
    expect(ni(r)).toBe(0)  // arc endpoints land on line endpoints
  })

  it("3/4 arc + chord → 1 surface", () => {
    /** 3/4 arc + chord closing off the short segment → 1 surface (half-disk-like region). */
    const r = detectTopology({
      a: arcGeom(0, 0, 1, 0, 270),
      ch: lineGeom(0, -1, 1, 0),
    })
    expect(ns(r)).toBe(1)
  })

  it("single line → 0 surfaces", () => {
    /** A single open line cannot enclose any area. */
    const r = detectTopology({ l: lineGeom(0, 0, 1, 1) })
    expect(ns(r)).toBe(0)
  })

  it("two non-intersecting lines → 0 surfaces", () => {
    const r = detectTopology({
      a: lineGeom(0, 0, 1, 0),
      b: lineGeom(0, 1, 1, 1),
    })
    expect(ns(r)).toBe(0)
  })

  it("two separate rectangles → 2 surfaces", () => {
    /** Two separate closed rectangles → 2 surfaces each. */
    const r = detectTopology({
      b1: lineGeom(0, 0, 2, 0),
      r1: lineGeom(2, 0, 2, 2),
      t1: lineGeom(2, 2, 0, 2),
      l1: lineGeom(0, 2, 0, 0),
      b2: lineGeom(4, 0, 6, 0),
      r2: lineGeom(6, 0, 6, 2),
      t2: lineGeom(6, 2, 4, 2),
      l2: lineGeom(4, 2, 4, 0),
    })
    expect(ns(r)).toBe(2)
    expect(ni(r)).toBe(0)
  })

  it("rectangle with two parallel splits → 3 surfaces, 4 intersections", () => {
    /** Rectangle split by two parallel lines → 3 surfaces. */
    const r = detectTopology({
      ...rectGeom(0, 0, 6, 4),
      s1: lineGeom(2, -1, 2, 5),
      s2: lineGeom(4, -1, 4, 5),
    })
    expect(ns(r)).toBe(3)
    expect(ni(r)).toBe(4)
  })

  it("rectangle with cross → 4 surfaces, 5 intersections", () => {
    /** Rectangle split by a horizontal + vertical line crossing inside → 4 surfaces. */
    const r = detectTopology({
      ...rectGeom(0, 0, 4, 4),
      h: lineGeom(-1, 2, 5, 2),
      v: lineGeom(2, -1, 2, 5),
    })
    expect(ns(r)).toBe(4)
    expect(ni(r)).toBe(5)
  })

  it("CW arc face (180°→0°) → 1 surface", () => {
    /** Half-disk using an arc from 180° to 0° (CW) + diameter line → 1 surface. */
    const r = detectTopology({
      semi: arcGeom(0, 0, 1, 180, 0),
      chord: lineGeom(1, 0, -1, 0),
    })
    expect(ns(r)).toBe(1)
  })
})

// ─── Query strings ───

describe("detectTopology query strings", () => {
  it("triangle surface has query", () => {
    const r = detectTopology(
      { a: lineGeom(0, 0, 2, 0), b: lineGeom(2, 0, 1, 2), c: lineGeom(1, 2, 0, 0) },
      "sketch1",
    )
    const q = r.surfaces[0].query as string
    expect(q.startsWith("?")).toBe(true)
    expect(q.endsWith(":flatface")).toBe(true)
    expect(q).toContain("@sketch1/a")
    expect(q).toContain("@sketch1/b")
    expect(q).toContain("@sketch1/c")
  })

  it("triangle surface query is deterministic", () => {
    const geom = { a: lineGeom(0, 0, 2, 0), b: lineGeom(2, 0, 1, 2), c: lineGeom(1, 2, 0, 0) }
    const r1 = detectTopology(geom, "sketch1")
    const r2 = detectTopology(geom, "sketch1")
    expect(r1.surfaces[0].query).toBe(r2.surfaces[0].query)
  })

  it("different geometries produce different queries", () => {
    const rectG = {
      bottom: lineGeom(0, 0, 2, 0),
      right: lineGeom(2, 0, 2, 2),
      top: lineGeom(2, 2, 0, 2),
      left: lineGeom(0, 2, 0, 0),
    }
    const rRect = detectTopology(rectG, "sk")
    const rectQuery = rRect.surfaces[0].query as string

    const diagG = { ...rectG, diag: lineGeom(0, 0, 2, 2) }
    const rDiag = detectTopology(diagG, "sk")
    expect(rDiag.surfaces.length).toBe(2)
    const q0 = rDiag.surfaces[0].query as string
    const q1 = rDiag.surfaces[1].query as string
    expect(q0).not.toBe(q1)
    expect(q0).not.toBe(rectQuery)
    expect(q1).not.toBe(rectQuery)
  })
})

// ─── Construction lines ───

describe("detectTopology construction lines", () => {
  it("construction lines are ignored", () => {
    /** Construction lines are excluded from topology -- rectangle stays 1 surface. */
    const r = detectTopology({
      ...rectGeom(0, 0, 2, 2),
      diag: { ...lineGeom(0, 0, 2, 2), construction: true },
    })
    expect(ns(r)).toBe(1)
  })

  it("only construction lines → 0 surfaces", () => {
    /** All construction lines cannot enclose a surface -- result is empty. */
    const r = detectTopology({
      a: { ...lineGeom(0, 0, 2, 0), construction: true },
      b: { ...lineGeom(2, 0, 1, 2), construction: true },
      c: { ...lineGeom(1, 2, 0, 0), construction: true },
    })
    expect(ns(r)).toBe(0)
  })

  it("construction line does not split surface", () => {
    /** A construction line crossing a closed rectangle does not split the surface. */
    const r = detectTopology({
      ...rectGeom(0, 0, 4, 4),
      h: { ...lineGeom(-1, 2, 5, 2), construction: true },
    })
    expect(ns(r)).toBe(1)
  })
})

// ─── Wrapping arcs ───

describe("detectTopology wrapping arcs", () => {
  it("wrapping arc half-disk (270°→90° through 0°) → 1 surface", () => {
    /** Right-half-disk: CCW arc from 270° to 90° (through 0°) + vertical chord.
     *  The arc wraps through 0°, so angle_end (1.57 rad) < angle_start (4.71 rad).
     *  This must still yield exactly 1 surface. */
    const r = 1.0
    const rTopo = detectTopology({
      a: arcGeom(0, 0, r, 270, 90),
      l: lineGeom(0, -r, 0, r),
    })
    expect(ns(rTopo)).toBe(1)
  })

  it("wrapping arc three-quarter (270°→180° through 0°) → 1 surface", () => {
    /** 3/4 arc from 270° to 180° (wrapping through 0°) + chord → 1 surface. */
    const r = 1.0
    const rTopo = detectTopology({
      a: arcGeom(0, 0, r, 270, 180),
      l: lineGeom(0, -r, -r, 0),
    })
    expect(ns(rTopo)).toBe(1)
  })

  it("equal belt (stadium) → 1 surface", () => {
    /** Stadium (pill) shape: two 180° arcs + two straight sides → 1 enclosed surface.
     *  The right arc goes from 270° to 90° (wrapping through 0°). Without proper
     *  parameter normalisation the right arc is reversed in the DCEL and no surface
     *  is found for the right half. */
    const r = 1.0
    const d = 4.0
    const rTopo = detectTopology({
      arc_l: arcGeom(-d / 2, 0, r, 90, 270),
      arc_r: arcGeom(d / 2, 0, r, 270, 90),
      top: lineGeom(-d / 2, r, d / 2, r),
      bot: lineGeom(d / 2, -r, -d / 2, -r),
    })
    expect(ns(rTopo)).toBe(1)
  })

  it("unequal belt → 1 surface", () => {
    /** Unequal belt: two arcs of different radii + two tangent lines → 1 surface.
     *  Both the wrapping-arc and the twin-mapping fixes must be active for this
     *  to produce a single enclosed region. */
    const r1 = 1.0
    const r2 = 2.0
    const d = 6.0
    const rTopo = detectTopology({
      arc_l: arcGeom(-d / 2, 0, r1, 90, 270),
      arc_r: arcGeom(d / 2, 0, r2, 270, 90),
      top: lineGeom(-d / 2, r1, d / 2, r2),
      bot: lineGeom(d / 2, -r2, -d / 2, -r1),
    })
    expect(ns(rTopo)).toBe(1)
  })
})

// ─── Boundary edge vertex references ───

describe("detectTopology boundary edges", () => {
  it("boundary edges have vertex references", () => {
    /** Every line edge in a surface boundary must reference vertices that exist
     *  in the topology's vertices dict. */
    const r = detectTopology({
      a: lineGeom(0, 0, 2, 0),
      b: lineGeom(2, 0, 1, 2),
      c: lineGeom(1, 2, 0, 0),
    })
    expect(ns(r)).toBe(1)
    const { vertices } = r
    const surface = r.surfaces[0]
    const boundary = surface.boundary as Record<string, unknown>[]
    for (const edge of boundary) {
      expect(edge).toHaveProperty("start_vertex")
      expect(edge).toHaveProperty("end_vertex")
      const sv = edge.start_vertex as string
      const ev = edge.end_vertex as string
      expect(sv === null || sv in vertices).toBe(true)
      expect(ev === null || ev in vertices).toBe(true)
      if (edge.kind === "line") {
        expect(sv).not.toBeNull()
        expect(ev).not.toBeNull()
      }
    }
  })

  it("boundary edge vertex coords match edge coords", () => {
    /** Vertex coordinates referenced by boundary edges must match the edge
     *  start/end coordinates within floating-point tolerance. */
    const r = detectTopology(rectGeom(0, 0, 4, 4))
    expect(ns(r)).toBe(1)
    const { vertices } = r
    const surface = r.surfaces[0]
    const boundary = surface.boundary as Record<string, unknown>[]
    for (const edge of boundary) {
      if (edge.kind !== "line") continue
      const sv = vertices[edge.start_vertex as string]
      const ev = vertices[edge.end_vertex as string]
      expect(Math.abs(sv.x - (edge.start as number[])[0])).toBeLessThan(COORD_TOL)
      expect(Math.abs(sv.y - (edge.start as number[])[1])).toBeLessThan(COORD_TOL)
      expect(Math.abs(ev.x - (edge.end as number[])[0])).toBeLessThan(COORD_TOL)
      expect(Math.abs(ev.y - (edge.end as number[])[1])).toBeLessThan(COORD_TOL)
    }
  })
})

// ─── collinearOverlap degenerate segments ───

describe("collinearOverlap degenerate segments", () => {
  it("zero-length segment A returns empty", () => {
    const result = collinearOverlap(
      { start: [1.0, 0.0], end: [1.0, 0.0] },
      { start: [0.0, 0.0], end: [2.0, 0.0] },
    )
    expect(result).toEqual([])
  })

  it("zero-length segment B returns empty", () => {
    const result = collinearOverlap(
      { start: [0.0, 0.0], end: [2.0, 0.0] },
      { start: [1.0, 0.0], end: [1.0, 0.0] },
    )
    expect(result).toEqual([])
  })

  it("normal overlapping segments return overlap points", () => {
    const result = collinearOverlap(
      { start: [0.0, 0.0], end: [2.0, 0.0] },
      { start: [1.0, 0.0], end: [3.0, 0.0] },
    )
    expect(result.length).toBeGreaterThan(0)
  })
})

// ─── Degenerate and touching geometry ───

describe("detectTopology degenerate geometry", () => {
  it("two touching rectangles → 2 surfaces", () => {
    /** Two rectangles touching along a collinear overlapping edge → 2 surfaces.
     *  Mirrors the exact geometry from bugreport
     *  sketch_area_building_problem_20260502_002427.md:
     *  bottom rect (-25,-10)-(25,-10)-(25,10)-(-25,10),
     *  top rect sits on bottom rect's top edge at y~10
     *  with overlapping collinear segments on the shared boundary. */
    const r = detectTopology({
      bot: lineGeom(-25, -10.0000000001, 25, -10.0000000001),
      rig: lineGeom(25, -10, 25, 9.9999999999),
      top: lineGeom(25, 9.9999999999, -25, 9.9999999998),
      lef: lineGeom(-25, 9.9999999998, -25, -10.0000000001),
      t_bot: lineGeom(-22.3419399725, 9.9999999998, -12.6978362039, 9.9999999998),
      t_rig: lineGeom(-12.6978362039, 9.9999999998, -12.6978362039, 32.1068859586),
      t_top: lineGeom(-12.6978362039, 32.1068859586, -22.3419399725, 32.1068859586),
      t_lef: lineGeom(-22.3419399725, 32.1068859586, -22.3419399725, 9.9999999998),
    })
    expect(r.surfaces.length).toBe(2)
    expect(r.surfaces.some((sfc) => (sfc.boundary as unknown[]).length === 4)).toBe(true)
  })

  it("topology with degenerate zero-length line still finds surface", () => {
    // A square plus a zero-length degenerate line; topology should still find the square surface.
    const r = detectTopology({
      e1: { kind: "line", construction: false, ...lineGeom(0.0, 0.0, 1.0, 0.0) },
      e2: { kind: "line", construction: false, ...lineGeom(1.0, 0.0, 1.0, 1.0) },
      e3: { kind: "line", construction: false, ...lineGeom(1.0, 1.0, 0.0, 1.0) },
      e4: { kind: "line", construction: false, ...lineGeom(0.0, 1.0, 0.0, 0.0) },
      e5: { kind: "line", construction: false, ...lineGeom(0.5, 0.5, 0.5, 0.5) },
    })
    expect(ns(r)).toBe(1)
  })
})

// ─── Phase 2 line-division classifiers (ported from test_classifier_resolution.py) ───

describe("line-division classifiers", () => {
  it("split circle gets line-division classifiers per half", () => {
    /** A circle bisected by a line produces two half-disks, each carrying a
     *  line-division classifier token ("cls_ld_<eid>_p" / "cls_ld_<eid>_n"). */
    const r = detectTopology({
      circ: { kind: "circle", center: [0, 0], radius: 10.0 },
      cut: { kind: "line", start: [-10, 0], end: [10, 0] },
    }, "sk1")
    expect(r.surfaces.length).toBe(2)
    const cls = r.surfaces.map((s) => [...(s.classifiers as string[] ?? [])].sort()).sort()
    expect(cls).toEqual([["cls_ld_cut_n"], ["cls_ld_cut_p"]])
  })

  it("single region sketch has no classifiers (no churn)", () => {
    /** A sketch with one closed loop per ancestral group has no sibling surfaces
     *  to disambiguate, so it stays untouched — zero classifier tokens emitted. */
    const r = detectTopology({
      circ: { kind: "circle", center: [0, 0], radius: 5.0 },
    }, "sk1")
    expect(r.surfaces.length).toBe(1)
    expect(r.surfaces[0].classifiers as string[] ?? []).toEqual([])
    expect(r.surfaces[0].query).not.toContain("@cls_")
  })

  it("four quadrant split produces four distinct classifier pairs", () => {
    /** Two perpendicular cuts through a circle produce four quadrants, each
     *  identified by a unique pair of line-division tokens (one per cut line). */
    const r = detectTopology({
      circ: { kind: "circle", center: [0, 0], radius: 10.0 },
      h: { kind: "line", start: [-10, 0], end: [10, 0] },
      v: { kind: "line", start: [0, -10], end: [0, 10] },
    }, "sk1")
    const quads = r.surfaces.filter((s) => ((s.classifiers as string[]) ?? []).length > 0)
    expect(quads.length).toBe(4)
    const tokenSets = new Set(quads.map((s) => JSON.stringify([...(s.classifiers as string[] ?? [])].sort())))
    expect(tokenSets.size).toBe(4)  // all four quadrants distinct
  })

  it("concentric circles form one washer (outer face + inner hole)", () => {
    /** Even/odd nesting: the outer circle is a filled face whose single hole is
     *  the inner circle (the OCC face-with-holes / donut model). No classifier
     *  is needed; the region is identified by its outer bounding circle. */
    const r = detectTopology({
      outer: { kind: "circle", center: [0, 0], radius: 10.0 },
      inner: { kind: "circle", center: [0, 0], radius: 4.0 },
    }, "sk1")
    expect(r.surfaces.length).toBe(1)
    const s = r.surfaces[0]
    expect(s.classifiers as string[] ?? []).toEqual([])
    expect(s.query).toContain("@sk1/outer")
    // The inner circle is the hole, carrying its own entity id for lineage.
    const holes = s.holes as Record<string, unknown>[][]
    expect(holes).toHaveLength(1)
    expect(holes[0].some((e) => e.id === "inner")).toBe(true)
  })
})
